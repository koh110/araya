import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import {
  DISCORD_TEST_NOW_MS as NOW_MS,
  messageIdAtAge,
} from '../../test/support/discord-snowflake.ts'

import {
  BACKFILL_FETCH_LIMIT,
  BACKFILL_MAX_AGE_MS,
  BACKFILL_MAX_MESSAGES,
  discordBackfillReplyNonce,
  discordMessageTimestampMs,
  runDiscordRestartBackfill,
  selectBackfillMessages,
} from './backfill.ts'
import { CHAT_UNAVAILABLE_REPLY, discordChatReplyNonce } from './chat.ts'
import { newState, noteDiscordSeenMessageId } from './state.ts'
import type { DiscordConfig } from './config.ts'
import type { DiscordGateway, DiscordHistoryMessage } from './gateway.ts'
import type { DiscordChatHandler, DiscordChatMessage } from './chat.ts'
import type { DiscordBotState } from './state.ts'

const BOT_TOKEN = 'synthetic-token'
const GUILD_ID = '22345678901234567'
const CHANNEL_ID = '32345678901234567'
const USER_ID = '42345678901234567'
const BOT_USER_ID = '998877665544332211'

const config: DiscordConfig = {
  botToken: BOT_TOKEN,
  applicationId: '12345678901234567',
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  allowedUserIds: [USER_ID],
}

function historyMessage(
  messageId: string,
  overrides: Partial<DiscordHistoryMessage> = {},
): DiscordHistoryMessage {
  return {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    isBot: false,
    isWebhook: false,
    isSystem: false,
    mentionsBot: false,
    messageId,
    content: `message ${messageId}`,
    ...overrides,
  }
}

test('backfill: snowflake id から投稿時刻を復元できる', () => {
  const id = messageIdAtAge(5_000)
  const createdMs = discordMessageTimestampMs(id)

  assert.ok(createdMs !== null)
  assert.ok(Math.abs(NOW_MS - 5_000 - createdMs) < 2, `createdMs=${createdMs}`)
})

test('backfill: invalid な snowflake id から投稿時刻を復元しない', () => {
  assert.equal(discordMessageTimestampMs('not-a-snowflake'), null)
})

test('backfill: cursor より新しい message だけ、古い順に選ぶ（bot・拒否用户・空・古い物は飛ばす）', () => {
  const cursor = messageIdAtAge(120_000)
  const candidates = selectBackfillMessages({
    // gateway の fetch は新しい順で返る
    history: [
      historyMessage(messageIdAtAge(1_000)),
      historyMessage(messageIdAtAge(2_000), { isBot: true, userId: BOT_USER_ID }),
      historyMessage(messageIdAtAge(3_000), { userId: '9876543210' }),
      historyMessage(messageIdAtAge(4_000), { content: '   ' }),
      historyMessage(messageIdAtAge(90_000)),
      historyMessage(cursor),
      historyMessage(messageIdAtAge(150_000)),
      historyMessage(messageIdAtAge(10_000)),
    ],
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    // stale 上限を 60s にして、90s 前の message が stale で落ちることを確かめる
    maxAgeMs: 60_000,
  })

  assert.deepEqual(
    candidates.candidates.map((message) => message.messageId),
    [messageIdAtAge(10_000), messageIdAtAge(1_000)],
    '古い順に続ける',
  )
  assert.deepEqual(
    candidates.skipped.map((skip) => skip.reason),
    ['self_message', 'not_allowed', 'empty', 'stale'],
  )
  // cursor 以下は skip にも出さない（live で既に扱った範囲）
  assert.ok(!candidates.skipped.some((skip) => skip.messageId === cursor))
})

test('backfill: cursor が無い instance は history を処理しない', () => {
  const selection = selectBackfillMessages({
    history: [historyMessage(messageIdAtAge(1_000))],
    cursor: null,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
  })

  assert.deepEqual(selection.candidates, [])
  assert.deepEqual(selection.skipped, [])
})

test('backfill: 上限より多い history では新しい側を残し、古い側を over_limit で落とす', () => {
  const cursor = messageIdAtAge(300_000)
  const ages = Array.from(
    { length: BACKFILL_MAX_MESSAGES + 3 },
    (_unused, index) => 5_000 + index * 100,
  )

  const selection = selectBackfillMessages({
    history: ages.map((age) => historyMessage(messageIdAtAge(age))).reverse(),
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    maxAgeMs: 30 * 60_000,
  })

  assert.equal(selection.candidates.length, BACKFILL_MAX_MESSAGES)
  assert.equal(selection.skipped.length, 3)
  assert.ok(selection.skipped.every((skip) => skip.reason === 'over_limit'))
  // unfinished ではない古い側だけで足りたので stuck は無い
  assert.deepEqual(selection.stuckUnfinishedMessageIds, [])
  // 落としたのは一番古い 3 件（age が最大の物）
  assert.deepEqual(
    selection.skipped.map((skip) => skip.messageId).sort(),
    [
      messageIdAtAge(5_000 + BACKFILL_MAX_MESSAGES * 100),
      messageIdAtAge(5_000 + (BACKFILL_MAX_MESSAGES + 1) * 100),
      messageIdAtAge(5_000 + (BACKFILL_MAX_MESSAGES + 2) * 100),
    ].sort(),
  )
})

type BackfillHarness = {
  logs: Record<string, unknown>[]
  saved: string[]
  handled: { messageId: string; content: string; replyText?: string }[]
  sent: { content: string; nonce: string }[]
  // runDiscordRestartBackfill が turn を終えたと記録した ids（bot.ts はこれを state.json へ書く）
  answered: string[]
  // bot.ts が state.json から復元した unfinished を模する Set。backfill と共有する object
  unfinishedMessageIds: Set<string>
  // bot.ts が live で受理して turn を実行中にしている ids を模する Set。backfill と共有する object
  liveProcessingMessageIds: Set<string>
  gateway: DiscordGateway
  chatHandler: DiscordChatHandler
}

function createBackfillHarness(
  history: readonly DiscordHistoryMessage[],
  options: {
    failFetch?: boolean
    // gateway が history API を持たない case（DiscordGateway.fetchRecentMessages が optional なので、
    // 古い fake・API を閉じた build を模する）。undefined にしないとこの case を通せない
    noHistoryApi?: boolean
    // chatHandler が送る本文。既定では実応答。CHAT_UNAVAILABLE_REPLY など案内だけ送らせるテストで使う
    replyTextFor?: (message: DiscordChatMessage) => string
  } = {},
): BackfillHarness {
  const logs: Record<string, unknown>[] = []
  const saved: string[] = []
  const handled: BackfillHarness['handled'] = []
  const sent: { content: string; nonce: string }[] = []
  const answered: string[] = []
  const unfinishedMessageIds = new Set<string>()
  const liveProcessingMessageIds = new Set<string>()

  const gateway: DiscordGateway = {
    async connect() {},
    async sendText(content, nonce) {
      sent.push({ content, nonce })
    },
    fetchRecentMessages: options.noHistoryApi
      ? undefined
      : options.failFetch
        ? async () => {
            throw new Error('history fetch failed')
          }
        : async () => [...history],
    async registerCommands() {
      return 2
    },
    async close() {},
  }

  const chatHandler: DiscordChatHandler = {
    async handle(message: DiscordChatMessage, reply) {
      const record: BackfillHarness['handled'][number] = {
        messageId: message.messageId,
        content: message.content,
      }
      const replyText = options.replyTextFor === undefined ? 'response' : options.replyTextFor(message)
      // chatHandler は chunk と nonce を決める側。backfill の reply closure が呼ばれる
      await reply(replyText, `nonce-${message.messageId}`)
      record.replyText = replyText
      handled.push(record)
    },
    async handleCommand() {},
    async runControl() {
      return ''
    },
    async inject() {
      return ''
    },
    stopAccepting() {},
    async drain() {},
    pendingCount: () => {
      return { queued: 0, processing: 0 }
    },
  }

  return {
    logs,
    saved,
    handled,
    sent,
    answered,
    unfinishedMessageIds,
    liveProcessingMessageIds,
    gateway,
    chatHandler,
  }
}

// bot.ts が backfill へ渡す deps の内、harness 側で決まる部分（テストごとに state・saveState・isHandled を足す）
function harnessDeps(harness: BackfillHarness) {
  return {
    config,
    botUserId: BOT_USER_ID,
    gateway: harness.gateway,
    chatHandler: harness.chatHandler,
    log: (entry: Record<string, unknown>) => {
      harness.logs.push(entry)
    },
    nowMs: () => NOW_MS,
    unfinishedMessageIds: harness.unfinishedMessageIds,
    liveProcessingMessageIds: harness.liveProcessingMessageIds,
    markAnswered: (messageId: string) => {
      harness.answered.push(messageId)
    },
  }
}

test('backfill: cursor が無い起動では history の newest を cursor に置いて今回は処理しない', async () => {
  const newest = messageIdAtAge(1_000)
  const harness = createBackfillHarness([
    historyMessage(newest),
    historyMessage(messageIdAtAge(9_000)),
  ])
  let state: DiscordBotState = newState()

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.equal(outcome.seeded, true)
  assert.deepEqual(outcome.handled, [])
  assert.equal(state.lastSeenMessageId, newest)
  assert.deepEqual(harness.saved, [newest])
  assert.deepEqual(harness.handled, [])
  assert.ok(
    harness.logs.some(
      (entry) => entry.type === 'discord_backfill_seeded' && entry.messageId === newest,
    ),
  )
})

test('backfill: 停止中に届いた message を古い順に会話へ流し、1 件ごとに cursor を保存する', async () => {
  const cursor = messageIdAtAge(90_000)
  const first = messageIdAtAge(30_000)
  const second = messageIdAtAge(5_000)
  const harness = createBackfillHarness([
    historyMessage(second),
    historyMessage(messageIdAtAge(20_000), { isBot: true, userId: BOT_USER_ID }),
    historyMessage(first),
    historyMessage(cursor),
  ])
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.equal(outcome.seeded, false)
  assert.deepEqual(outcome.handled, [first, second])
  assert.deepEqual(
    harness.handled.map((entry) => entry.messageId),
    [first, second],
    '会話は古い順に続ける',
  )
  assert.deepEqual(harness.saved, [first, second], 'kill されても同じ message を取り直さない')
  assert.equal(state.lastSeenMessageId, second)
  assert.deepEqual(
    harness.sent.map((entry) => entry.nonce),
    [discordBackfillReplyNonce(first, 0), discordBackfillReplyNonce(second, 0)],
    '取り直しは chatHandler が渡す live の answer nonce を使い回さない（shutdown notice と衝突する）',
  )

  const received = harness.logs.filter((entry) => entry.type === 'discord_backfill_received')

  assert.equal(received.length, 2)
  assert.equal(received[0]?.messageId, first)
  assert.equal(received[0]?.userId, USER_ID)
  assert.equal(typeof received[0]?.ageMs, 'number')
  // 本文は log に書かない
  assert.ok(!JSON.stringify(harness.logs).includes('message '))
  assert.ok(!JSON.stringify(harness.logs).includes(BOT_TOKEN))

  const summary = harness.logs.find((entry) => entry.type === 'discord_backfill')

  assert.ok(summary !== undefined)
  assert.equal(summary.handled, 2)
  assert.equal(summary.cursor, cursor)
})

test('backfill: live で既に処理した message は取り直さない', async () => {
  const cursor = messageIdAtAge(90_000)
  const liveId = messageIdAtAge(5_000)
  const harness = createBackfillHarness([historyMessage(liveId)])
  const liveHandled = new Set<string>([liveId])
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
    },
    isHandled: (messageId) => {
      return liveHandled.has(messageId)
    },
    markHandled: (messageId) => {
      liveHandled.add(messageId)
    },
  })

  assert.deepEqual(outcome.handled, [])
  assert.deepEqual(harness.handled, [])
  assert.equal(state.lastSeenMessageId, cursor, 'live で処理済みの id で cursor を動かし直さない')
  assert.ok(
    harness.logs.some(
      (entry) => entry.type === 'discord_backfill_ignored' && entry.reason === 'already_handled',
    ),
  )
})

test('backfill: history が読めなくても bot の起動を止めない（理由だけ log）', async () => {
  const cursor = messageIdAtAge(90_000)
  const harness = createBackfillHarness([], { failFetch: true })
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [])
  assert.equal(state.lastSeenMessageId, cursor)
  assert.ok(
    harness.logs.some(
      (entry) =>
        entry.type === 'discord_backfill_skipped' && entry.reason === 'history_fetch_failed',
    ),
  )

  // gateway が history API を持たない（harness の noHistoryApi）場合も飛ばす
  const noApi = createBackfillHarness([], { noHistoryApi: true })
  const outcomeNoApi = await runDiscordRestartBackfill({
    ...harnessDeps(noApi),
    state: newState(),
    saveState: () => {},
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.equal(noApi.gateway.fetchRecentMessages, undefined)
  assert.equal(outcomeNoApi.seeded, false)
  assert.ok(noApi.logs.some((entry) => entry.reason === 'history_api_unavailable'))
})

test('backfill: snowflake からの復元時刻が Discord REST の timestamp と一致する（#36 の epoch 実測）', () => {
  // 2026-11-24 に channel の history を REST で読んだ実測（Discord が自分で返した timestamp）。
  // 以前使っていた epoch 1_420_064_800_000 ではここが 5600.000 s ずれ、age 上限 15 分を常に越えて
  // 取り直しの対象になった message が全部 stale で捨れた（human backfill が 1 件も処理されなかった実因）
  const observed: [string, string][] = [
    ['1574678984665337868', '2026-11-24T06:52:06.065Z'],
    ['1574678607257669644', '2026-11-24T06:50:36.084Z'],
    ['1574678605714432045', '2026-11-24T06:50:35.716Z'],
    ['1574668611015155743', '2026-11-24T06:10:52.794Z'],
    ['1574667688813400115', '2026-11-24T06:07:12.924Z'],
  ]

  for (const [messageId, timestamp] of observed) {
    const createdMs = discordMessageTimestampMs(messageId)

    assert.equal(createdMs, Date.parse(timestamp), `id=${messageId} createdMs=${createdMs}`)
  }
})

test('backfill: 停止中に届いた message は age 上限で捨てられず、受信できていなかった期間を log に残す', async () => {
  const cursor = messageIdAtAge(200_000)
  const duringStopId = messageIdAtAge(20_000)
  const harness = createBackfillHarness([historyMessage(duringStopId), historyMessage(cursor)])
  const state = noteDiscordSeenMessageId(newState(), cursor)

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [duringStopId])

  const received = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill_received'
  })

  assert.ok(received !== undefined)
  assert.equal(received.ageMs, 20_000, '投稿から backfill 処理までの wall clock age')

  const summary = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill'
  })

  assert.ok(summary !== undefined)
  assert.equal(
    summary.unreceivedMs,
    180_000,
    'cursor から history の最新 id までの Discord 側の時間差',
  )
  assert.equal(summary.cursor, cursor)
})

test('backfill: unfinished の id は age 上限を無視して取り直し、unfinished でない古い id は stale で落とす', () => {
  const cursor = messageIdAtAge(4 * 60 * 60_000)
  // 3 時間前。age 上限（既定 15 分）を大きく越えているが、受理済みで turn が終わっていない id
  const unfinishedId = messageIdAtAge(3 * 60 * 60_000)
  const staleId = messageIdAtAge(2 * 60 * 60_000)
  const freshId = messageIdAtAge(5_000)
  const selection = selectBackfillMessages({
    history: [historyMessage(freshId), historyMessage(staleId), historyMessage(unfinishedId), historyMessage(cursor)],
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    unfinishedMessageIds: new Set<string>([unfinishedId]),
  })

  assert.deepEqual(
    selection.candidates.map((message) => message.messageId),
    [unfinishedId, freshId],
    'unfinished は age に関係なく古い順に残す',
  )
  assert.deepEqual(
    selection.skipped.map((skip) => `${skip.messageId}:${skip.reason}`),
    [`${staleId}:stale`],
    'unfinished でない古い id は今まで通り stale',
  )
})

test('backfill: 上限を越えるとき unfinished を over_limit で落とさない', () => {
  const cursor = messageIdAtAge(300_000)
  const unfinishedId = messageIdAtAge(250_000)
  const others = [messageIdAtAge(200_000), messageIdAtAge(150_000), messageIdAtAge(100_000)]
  const history = [
    historyMessage(others[2]!),
    historyMessage(others[1]!),
    historyMessage(unfinishedId),
    historyMessage(others[0]!),
    historyMessage(cursor),
  ]

  const selection = selectBackfillMessages({
    history,
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    limit: 2,
    unfinishedMessageIds: new Set<string>([unfinishedId]),
  })

  assert.deepEqual(
    selection.candidates.map((message) => message.messageId),
    [unfinishedId, others[2]!],
    'unfinished ではない古い側から落とす',
  )
  assert.deepEqual(
    selection.skipped.map((skip) => skip.reason),
    ['over_limit', 'over_limit'],
  )

  // unfinished だけで上限を越えているときは、続ける古い順のまま古い側から落とす
  const allUnfinished = selectBackfillMessages({
    history,
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    limit: 2,
    unfinishedMessageIds: new Set<string>([unfinishedId, others[0]!, others[1]!, others[2]!]),
  })

  assert.deepEqual(
    allUnfinished.candidates.map((message) => message.messageId),
    [others[1]!, others[2]!],
  )
})

test('backfill: restart 前に受理して turn が終わっていなかった message は age 上限を無視して取り直す', async () => {
  // 2026-11-24 の incident。08:00 の shutdown で unfinished（実測 id 1574697513779339295 /
  // 1574711804037308467 / 1574795431291125812）が memory から消え、restart 後の backfill は
  // discord_backfill_ignored reason:"stale" で 3 件を捨てた。unfinished が state.json から
  // 復元されている形（id は age 比較のため synthetic）で、3 時間前の message が取り直されることを確かめる
  const cursor = messageIdAtAge(4 * 60 * 60_000)
  const unfinishedId = messageIdAtAge(3 * 60 * 60_000)
  const freshId = messageIdAtAge(5_000)
  const harness = createBackfillHarness([
    historyMessage(freshId),
    historyMessage(unfinishedId),
    historyMessage(cursor),
  ])

  harness.unfinishedMessageIds.add(unfinishedId)

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [unfinishedId],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [unfinishedId, freshId], '古い順に取り直す')
  assert.deepEqual(
    harness.handled.map((entry) => entry.messageId),
    [unfinishedId, freshId],
  )
  assert.deepEqual(
    harness.logs.filter((entry) => entry.type === 'discord_backfill_ignored'),
    [],
    'unfinished を stale で捨てない',
  )
  assert.equal(harness.unfinishedMessageIds.size, 0, '取り直し終わった id は unfinished から出す')
  assert.deepEqual(harness.answered, [unfinishedId, freshId])
  assert.equal(state.lastSeenMessageId, freshId)
  assert.deepEqual(harness.saved, [unfinishedId, freshId])

  const summary = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill'
  })

  assert.ok(summary !== undefined)
  assert.equal(summary.unfinishedRemaining, 0)
})

test('backfill: history に届かない unfinished は unreachable として log し、cursor を恒久的に止めない', async () => {
  // 実測: 2026-11-24T08:00:14Z の shutdown で unfinished に出た 1574692480371392604 は、09:02:01Z の restart 後の
  // history（新しい 100 件）に 1 度も現れなかった。backfill には history 以外を取り直す手段が無いので、
  // unfinished に残したまま cursor を止めても取り直せない。log に出して対象から出し、cursor を動かせるようにする
  const cursor = messageIdAtAge(90_000)
  const unreachableUnfinishedId = messageIdAtAge(60_000)
  const newerId = messageIdAtAge(5_000)
  const harness = createBackfillHarness([historyMessage(newerId), historyMessage(cursor)])

  harness.unfinishedMessageIds.add(unreachableUnfinishedId)

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [unreachableUnfinishedId],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [newerId], 'history にある message は取り直せる')
  assert.equal(harness.unfinishedMessageIds.has(unreachableUnfinishedId), false)
  assert.deepEqual(harness.saved, [newerId], 'unreachable な id で cursor を止めたままにしない')

  const unreachable = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill_unfinished_unreachable'
  })

  assert.ok(unreachable !== undefined, '取り直せなかった id を log に出す')
  assert.equal(unreachable.messageId, unreachableUnfinishedId)
  assert.equal(unreachable.historyCount, 2)

  const summary = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill'
  })

  assert.ok(summary !== undefined)
  assert.equal(summary.unfinishedRemaining, 0)
  assert.equal(summary.cursor, cursor, 'log の cursor は取り直し開始前の位置')
  assert.equal(summary.cursorAfter, newerId, 'unreachable な id で cursor が止まらないことを log からも読む')
})

test('backfill: history が 0 件の fetch では unfinished を unreachable にしない', async () => {
  // 0 件の fetch からは「fetch 結果に無い」ことを言えないので、unfinished を対象から出さない
  const cursor = messageIdAtAge(90_000)
  const unfinishedId = messageIdAtAge(60_000)
  const harness = createBackfillHarness([])

  harness.unfinishedMessageIds.add(unfinishedId)

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [unfinishedId],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [])
  assert.equal(harness.unfinishedMessageIds.has(unfinishedId), true)
  assert.equal(
    harness.logs.some((entry) => {
      return entry.type === 'discord_backfill_unfinished_unreachable'
    }),
    false,
  )
  assert.equal(state.lastSeenMessageId, cursor)
})

test('backfill: fetch 後に live で受理した unfinished は unreachable にしない（history に無いだけ）', async () => {
  // backfill の fetch の後に届いた live message は history へ返らない。isHandled（この process が live で
  // 受理した id）を unreachable から除くことで、turn が動いている message を backfill が捨てないようにする
  const cursor = messageIdAtAge(90_000)
  const liveUnfinishedId = messageIdAtAge(10_000)
  const olderId = messageIdAtAge(50_000)
  const harness = createBackfillHarness([historyMessage(olderId), historyMessage(cursor)])

  harness.unfinishedMessageIds.add(liveUnfinishedId)

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [liveUnfinishedId],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
    },
    isHandled: (messageId) => {
      return messageId === liveUnfinishedId
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [olderId])
  assert.equal(harness.unfinishedMessageIds.has(liveUnfinishedId), true, 'live で受理した id を残す')
  assert.equal(state.lastSeenMessageId, olderId, 'live で turn が終わっていない id より後ろへは進まない')
})

test('backfill: over_limit で取り直せなかった unfinished より後ろへ cursor を進めない', async () => {
  // 上限（20 件）を越えた unfinished は新しい側を残して古い側を落とす。取り直せなかった id より後ろへ
  // cursor を進めると、その id は次の restart の history 候補（cursor より新しい物だけ）から消える
  const cursor = messageIdAtAge(300_000)
  const unfinishedIds: string[] = []

  for (let index = 0; index < BACKFILL_MAX_MESSAGES + 1; index += 1) {
    unfinishedIds.push(messageIdAtAge(200_000 - index * 1_000))
  }

  const droppedId = unfinishedIds[0]!
  const history: DiscordHistoryMessage[] = [historyMessage(cursor)]

  for (const messageId of unfinishedIds) {
    history.push(historyMessage(messageId))
  }

  const harness = createBackfillHarness(history)

  for (const messageId of unfinishedIds) {
    harness.unfinishedMessageIds.add(messageId)
  }

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [...unfinishedIds],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.equal(outcome.handled.length, BACKFILL_MAX_MESSAGES, '上限分の unfinished は取り直せる')
  assert.ok(harness.unfinishedMessageIds.has(droppedId), '取り直せなかった id は unfinished に残る')
  assert.equal(state.lastSeenMessageId, cursor, 'cursor を droppedId より後ろへ進めない')

  const summary = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill'
  })

  assert.ok(summary !== undefined)
  assert.equal(summary.unfinishedRemaining, 1)
  assert.equal(summary.cursorAfter, cursor, '取り直せなかった unfinished より後ろへ進んでいない')
})

test('backfill: over_limit で落とした unfinished は stuckUnfinishedMessageIds と discord_backfill_unfinished_stuck に出す', async () => {
  // 黙って cursor を止める状態（取り直し対象なのに 20 件の上限で落とされた unfinished）を log で見られるようにする
  const cursor = messageIdAtAge(300_000)
  const unfinishedIds: string[] = []

  for (let index = 0; index < BACKFILL_MAX_MESSAGES + 1; index += 1) {
    unfinishedIds.push(messageIdAtAge(200_000 - index * 1_000))
  }

  const droppedId = unfinishedIds[0]!
  const history: DiscordHistoryMessage[] = [historyMessage(cursor)]

  for (const messageId of unfinishedIds) {
    history.push(historyMessage(messageId))
  }

  const harness = createBackfillHarness(history)

  for (const messageId of unfinishedIds) {
    harness.unfinishedMessageIds.add(messageId)
  }

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [...unfinishedIds],
  }

  await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  const stuck = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill_unfinished_stuck'
  })

  assert.ok(stuck !== undefined, 'over_limit で落とした unfinished を log に出す')
  assert.equal(stuck.count, 1)
  assert.deepEqual(stuck.messageIds, [droppedId])
  assert.equal(stuck.cursor, cursor)
  assert.equal(stuck.maxMessages, BACKFILL_MAX_MESSAGES)
  assert.equal(stuck.fetchLimit, BACKFILL_FETCH_LIMIT)
})

test('backfill: selectBackfillMessages は unfinished ではない古い側を落としたぶんだけ stuck に出す', () => {
  const cursor = messageIdAtAge(300_000)
  const ids: string[] = []

  for (let index = 0; index < BACKFILL_MAX_MESSAGES + 3; index += 1) {
    ids.push(messageIdAtAge(200_000 - index * 1_000))
  }

  // 古い 22 件が unfinished、新しい 1 件だけ unfinished ではない（overflow 3 のうち 1 件は捨ててよい古い側）
  const unfinishedMessageIds = new Set<string>(ids.slice(0, ids.length - 1))
  const selection = selectBackfillMessages({
    history: ids.map((messageId) => {
      return historyMessage(messageId)
    }),
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    unfinishedMessageIds,
  })

  assert.equal(selection.candidates.length, BACKFILL_MAX_MESSAGES)
  assert.deepEqual(selection.stuckUnfinishedMessageIds, [ids[0], ids[1]])
  assert.ok(
    selection.skipped.every((skip) => {
      return skip.reason === 'over_limit'
    }),
  )
})

test('backfill: 会話にならない unfinished（bot 自身・許可外 user）は unfinished から出して cursor を止めたままにしない', async () => {
  const cursor = messageIdAtAge(90_000)
  const selfId = messageIdAtAge(60_000)
  const notAllowedId = messageIdAtAge(50_000)
  const newerId = messageIdAtAge(5_000)
  const harness = createBackfillHarness([
    historyMessage(newerId),
    historyMessage(notAllowedId, { userId: '9876543210' }),
    historyMessage(selfId, { isBot: true, userId: BOT_USER_ID }),
    historyMessage(cursor),
  ])

  harness.unfinishedMessageIds.add(selfId)
  harness.unfinishedMessageIds.add(notAllowedId)

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [selfId, notAllowedId],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [newerId])
  assert.deepEqual([...harness.unfinishedMessageIds], [], '会話にならない id を unfinished に残さない')
  assert.deepEqual(harness.saved, [newerId], 'cursor が unfinished で止まり続けない')
  assert.equal(state.lastSeenMessageId, newerId)
})

// Discord の enforce_nonce を model する gateway（gateway.test.ts の dedupeGateway と同じ rule）。
// discord-api-types の docs は「same author + same nonce in the past few minutes」を 1 通にまとめると
// 説明し、payload では enforceNonce: true（gateway.ts）。数分以上離れると重複は通るので、
// テストでは「過去数分のあいだ同じ author + 同じ nonce の 2 度目の send は channel に届かない」を測る
function createNonceDedupeGateway(harness: BackfillHarness, usedNonces: Set<string>) {
  const delivered: { content: string; nonce: string }[] = []

  const gateway: DiscordGateway = {
    ...harness.gateway,
    async sendText(content, nonce) {
      harness.sent.push({ content, nonce })

      if (usedNonces.has(nonce)) {
        return
      }

      usedNonces.add(nonce)
      delivered.push({ content, nonce })
    },
  }

  return { gateway, delivered }
}

test('backfill: 取り直しの send は shutdown notice の nonce と衝突しない（Discord は過去数分の同じ nonce だけを 1 通にまとめる）', async () => {
  const cursor = messageIdAtAge(200_000)
  const replayId = messageIdAtAge(60_000)
  const harness = createBackfillHarness([historyMessage(replayId), historyMessage(cursor)])
  // 前の process は終了時にこの message へ「今回は処理できなかった」notice を送った。
  // chat.ts は messageId + chunk 0 の nonce（discordChatReplyNonce）で送るので、この nonce は使い済み
  const noticeNonce = discordChatReplyNonce(replayId, 0)
  const { gateway, delivered } = createNonceDedupeGateway(harness, new Set<string>([noticeNonce]))

  harness.unfinishedMessageIds.add(replayId)

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    gateway,
    state: noteDiscordSeenMessageId(newState(), cursor),
    saveState: () => {},
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [replayId])
  assert.equal(delivered.length, 1, 'notice と同じ nonce なら answer が Discord 側で落ちる')
  assert.notEqual(delivered[0]?.nonce, noticeNonce, 'live の answer nonce（restart でも同じ値）を使わない')
  assert.equal(delivered[0]?.nonce, discordBackfillReplyNonce(replayId, 0))
  // Discord の nonce rule（1-25 chars, ^[a-z0-9-]+$）。gateway.sendText が invalid を throw する前に満たす
  assert.match(delivered[0]?.nonce ?? '', /^[a-z0-9-]{1,25}$/)
  assert.ok((delivered[0]?.nonce.length ?? 0) <= 25, 'nonce は 25 chars 以内')
})

test('backfill: 取り直しの複数 chunk に live と違う nonce が順に振られ、取り直し同士は同じ nonce でまとまる', async () => {
  const cursor = messageIdAtAge(200_000)
  const replayId = messageIdAtAge(60_000)
  const harness = createBackfillHarness([historyMessage(replayId), historyMessage(cursor)])
  // chatHandler 側が live の answer と同じ nonce（chunk index 順）を渡す想定
  const chatHandler: DiscordChatHandler = {
    ...harness.chatHandler,
    async handle(message, reply) {
      for (const [index, chunk] of ['1 chunk 目', '2 chunk 目', '3 chunk 目'].entries()) {
        await reply(chunk, discordChatReplyNonce(message.messageId, index))
      }

      harness.handled.push({ messageId: message.messageId, content: message.content, replyText: '3 chunks' })
    },
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    chatHandler,
    state: noteDiscordSeenMessageId(newState(), cursor),
    saveState: () => {},
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [replayId])
  assert.deepEqual(
    harness.sent.map((entry) => entry.nonce),
    [
      discordBackfillReplyNonce(replayId, 0),
      discordBackfillReplyNonce(replayId, 1),
      discordBackfillReplyNonce(replayId, 2),
    ],
    'chunk 順を保ったまま取り直し専用の namespace',
  )
  assert.equal(
    new Set(harness.sent.map((entry) => entry.nonce)).size,
    harness.sent.length,
    'chunk ごとに違う nonce（同じ message の chunk が Discord 側で消えない）',
  )

  for (const [index, entry] of harness.sent.entries()) {
    assert.notEqual(entry.nonce, discordChatReplyNonce(replayId, index), 'live の answer nonce を使わない')
  }
})

test('backfill: unfinished の id は cursor より古い側・age 上限の向こう側でも history から取り直す', async () => {
  // state.json 上の unfinished が cursor より古い側にある = cursor の invariant（この id より古い message は
  // 全て処理し終えた）が壊れた state。cursor を後ろへ戻して続けると cursor より新しい message も再処理して
  // 応答が重複するので、unfinished の id だけを選ぶ
  const cursor = messageIdAtAge(60_000)
  const unfinishedBehind = messageIdAtAge(20 * 60_000)
  const otherBehind = messageIdAtAge(25 * 60_000)
  const fresh = messageIdAtAge(10_000)
  const harness = createBackfillHarness([
    historyMessage(fresh),
    historyMessage(cursor),
    historyMessage(unfinishedBehind),
    historyMessage(otherBehind),
  ])
  harness.unfinishedMessageIds.add(unfinishedBehind)
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(
    outcome.handled,
    [unfinishedBehind, fresh],
    'cursor より古い unfinished を先に、そのあと cursor より新しい取り直し（古い順）',
  )
  assert.equal(
    harness.logs.some((entry) => entry.messageId === otherBehind),
    false,
    'unfinished でない cursor より古い id は取り直さない（応答の重複を防ぐ）',
  )
  assert.equal(state.lastSeenMessageId, fresh, '取り直した分だけ cursor が進む')
  assert.deepEqual([...harness.unfinishedMessageIds], [], '取り直しを終えた unfinished は空になる')
})

test('backfill: live で処理中の id は reason:"live_processing" で飛ばし unfinished には残す', async () => {
  // live path が受理して turn が動いている message が history にも出てくる（ready 直後の live 受信）。
  // backfill が同じ id に turn を走らせると応答が二重になる。unfinished でも実行中であることを飛ばす理由に
  // するので、log の reason でどちらだったか切り分ける
  const cursor = messageIdAtAge(60_000)
  const liveId = messageIdAtAge(20_000)
  const harness = createBackfillHarness([historyMessage(liveId), historyMessage(cursor)])
  harness.unfinishedMessageIds.add(liveId)
  harness.liveProcessingMessageIds.add(liveId)
  const markHandled: string[] = []
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    // bot.ts の isHandled と同じ形（処理中もここで飛ばす）
    isHandled: (messageId) => {
      return harness.liveProcessingMessageIds.has(messageId)
    },
    markHandled: (messageId) => {
      markHandled.push(messageId)
    },
  })

  assert.deepEqual(outcome.handled, [], JSON.stringify(harness.logs))
  assert.equal(harness.handled.length, 0, 'live 処理中の message へ backfill が turn を走らせない')
  assert.deepEqual(markHandled, [], 'live 側の処理に任せる')
  assert.ok(
    harness.logs.some(
      (entry) =>
        entry.type === 'discord_backfill_ignored' && entry.messageId === liveId && entry.reason === 'live_processing',
    ),
    JSON.stringify(harness.logs),
  )
  assert.ok(harness.unfinishedMessageIds.has(liveId), 'live 側が終わるか次の restart まで unfinished に残す')
  assert.equal(state.lastSeenMessageId, cursor, 'cursor を live 処理中の id より後ろへ進めない')
})

test('backfill: live 処理中の unfinished が history に届いていないときは unreachable にしない', async () => {
  // history は fetch 時点の快照。fetch より後に届いた live message はここに出ないだけで、message が無い
  // 証拠ではない（案 1 では受理の事実を liveMessageIds に書かないので isHandled にも入っていない）
  const cursor = messageIdAtAge(60_000)
  const liveId = messageIdAtAge(30_000)
  const goneId = messageIdAtAge(40_000)
  const freshId = messageIdAtAge(10_000)
  const harness = createBackfillHarness([historyMessage(freshId)])
  harness.unfinishedMessageIds.add(liveId)
  harness.unfinishedMessageIds.add(goneId)
  harness.liveProcessingMessageIds.add(liveId)
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [freshId])
  assert.ok(
    harness.unfinishedMessageIds.has(liveId),
    'live で受理して実行中の id は fetch 結果に無いだけなので対象から出さない',
  )
  assert.ok(
    harness.logs.some(
      (entry) =>
        entry.type === 'discord_backfill_unfinished_unreachable' && entry.messageId === goneId,
    ),
    JSON.stringify(harness.logs),
  )
  assert.equal(
    harness.logs.some(
      (entry) =>
        entry.type === 'discord_backfill_unfinished_unreachable' && entry.messageId === liveId,
    ),
    false,
    JSON.stringify(harness.logs),
  )
})

test('backfill: 案内だけ送った turn は answered に記録しない（notice の送信記録で再応答を止めない）', async () => {
  // chat.ts が送る CHAT_UNAVAILABLE_REPLY は「会話機能を走らせなかった」という送信結果。これを answered に
  // すると、notice が届いたかどうかで取り直しが決まる（2026-11-24 の incident では notice 自体が
  // discord_chat_reply_failed で Discord に届いていない）。turn を終えた id は unfinished から出すので、
  // cursor が恒久的に止まるのも防ぐ
  const cursor = messageIdAtAge(60_000)
  const noticeId = messageIdAtAge(20_000)
  const harness = createBackfillHarness([historyMessage(noticeId), historyMessage(cursor)], {
    replyTextFor: () => CHAT_UNAVAILABLE_REPLY,
  })
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [noticeId])
  assert.deepEqual(harness.answered, [], '案内だけの turn を応答済みとして記録しない')
  assert.deepEqual(harness.sent.map((entry) => entry.content), [CHAT_UNAVAILABLE_REPLY])
  assert.equal(harness.unfinishedMessageIds.size, 0, 'turn を終えた id は unfinished から出す')
  assert.deepEqual(harness.saved, [noticeId])
})

test('backfill: cursor が無い起動で unfinished があるとき、seed は unfinished より後ろへ進まない', async () => {
  // seed は cursor gate の無い経路だった。state file に unfinished を持つ起動（history fetch 失敗後に live が
  // 受理して kill された等）で history の newest を cursor にすると、その unfinished は cursor が越えた側に
  // 残り、selectBackfillMessages の candidate から外れてその後の prune（discord_unfinished_pruned）で
  // state file から消える。seed も同じ gate を通し、進められないなら cursor を null のまま置く
  const unfinishedId = messageIdAtAge(30_000)
  const newerId = messageIdAtAge(1_000)
  const olderId = messageIdAtAge(90_000)
  const harness = createBackfillHarness([historyMessage(newerId), historyMessage(unfinishedId)])

  harness.unfinishedMessageIds.add(unfinishedId)

  let state: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: null,
    unfinishedMessageIds: [unfinishedId],
  }

  const outcome = await runDiscordRestartBackfill({
    ...harnessDeps(harness),
    state,
    saveState: (next) => {
      state = next
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.equal(outcome.seeded, false, 'unfinished より後ろへ seed しない')
  assert.equal(outcome.historyFetched, true, 'history fetch 自体は成功している')
  assert.deepEqual(outcome.handled, [])
  assert.deepEqual(harness.handled, [], 'cursor が無い起動では history を処理しない')
  assert.equal(state.lastSeenMessageId, null, 'cursor を null のまま置く（prune が early return して unfinished が守れる）')
  assert.deepEqual(harness.saved, [], 'state 書き込みで cursor を進めない')
  assert.deepEqual([...harness.unfinishedMessageIds], [unfinishedId], 'unfinished を残す')
  assert.ok(
    !harness.logs.some((entry) => {
      return entry.type === 'discord_backfill_seeded'
    }),
    JSON.stringify(harness.logs),
  )

  const skipped = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill_skipped'
  })

  assert.ok(skipped !== undefined, JSON.stringify(harness.logs))
  assert.equal(skipped.reason, 'no_seedable_history', 'history は読めたが seed できる id が無い')
  assert.equal(skipped.unfinishedCount, 1)
  assert.equal(skipped.historyCount, 2)

  // unfinished より古い id だけの history なら seed できる（seed 位置は常に unfinished より古い側）
  const olderOnlyHarness = createBackfillHarness([historyMessage(olderId), historyMessage(unfinishedId)])

  olderOnlyHarness.unfinishedMessageIds.add(unfinishedId)

  let olderOnlyState: DiscordBotState = {
    ...newState(),
    lastSeenMessageId: null,
    unfinishedMessageIds: [unfinishedId],
  }

  const olderOnlyOutcome = await runDiscordRestartBackfill({
    ...harnessDeps(olderOnlyHarness),
    state: olderOnlyState,
    saveState: (next) => {
      olderOnlyState = next
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.equal(olderOnlyOutcome.seeded, true)
  assert.equal(olderOnlyState.lastSeenMessageId, olderId)
  assert.deepEqual([...olderOnlyHarness.unfinishedMessageIds], [unfinishedId], 'unfinished より古い位置に置く')
})

test('backfill: unfinished と answered が同時に limit を超えるとき stuck に出すのは unfinished だけ', () => {
  // answered（前回の process で実応答を送った ids）は取り直し対象ではない。上限で落とすのは unfinished では
  // ない古い側からで、stuck（この round で取り直せない取り直し対象）に answered が混ざると log が意味を失う。
  // older-first の candidates: U1 / U2 / A1 / U3、limit 2 で overflow 2
  const cursor = messageIdAtAge(400_000)
  const u1 = messageIdAtAge(100_000)
  const u2 = messageIdAtAge(90_000)
  const a1 = messageIdAtAge(80_000)
  const u3 = messageIdAtAge(70_000)
  const selection = selectBackfillMessages({
    // gateway の fetch は新しい順
    history: [historyMessage(u3), historyMessage(a1), historyMessage(u2), historyMessage(u1)],
    cursor,
    config,
    botUserId: BOT_USER_ID,
    nowMs: () => NOW_MS,
    maxAgeMs: 30 * 60_000,
    limit: 2,
    unfinishedMessageIds: new Set<string>([u1, u2, u3]),
  })

  assert.deepEqual(
    selection.candidates.map((message) => {
      return message.messageId
    }),
    [u2, u3],
    ' unfinished ではない古い側（A1）を先に落とし、残りも古い unfinished から落とす',
  )
  assert.deepEqual(selection.stuckUnfinishedMessageIds, [u1], '取り直せなかった unfinished だけを出す')
  assert.ok(
    !selection.stuckUnfinishedMessageIds.includes(a1),
    JSON.stringify(selection.stuckUnfinishedMessageIds),
    'answered だけの id を stuck に出さない',
  )
  assert.deepEqual(
    selection.skipped.map((skip) => {
      return [skip.messageId, skip.reason]
    }),
    [
      [u1, 'over_limit'],
      [a1, 'over_limit'],
    ],
  )
})
