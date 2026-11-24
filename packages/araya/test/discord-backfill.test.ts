import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BACKFILL_MAX_AGE_MS,
  BACKFILL_MAX_MESSAGES,
  discordMessageTimestampMs,
  runDiscordRestartBackfill,
  selectBackfillMessages,
} from '../src/discord/backfill.ts'
import {
  DISCORD_STATE_VERSION,
  isDiscordMessageIdNewer,
  newState,
  noteDiscordSeenMessageId,
  readDiscordBotState,
  writeDiscordBotState,
} from '../src/discord/state.ts'
import { discordStateFilePath } from '../src/discord/state.ts'
import type { DiscordConfig } from '../src/discord/config.ts'
import type { DiscordGateway, DiscordHistoryMessage } from '../src/discord/gateway.ts'
import type { DiscordChatHandler, DiscordChatMessage } from '../src/discord/chat.ts'
import type { DiscordBotState } from '../src/discord/state.ts'

const BOT_TOKEN = 'synthetic-token'
const GUILD_ID = '22345678901234567'
const CHANNEL_ID = '32345678901234567'
const USER_ID = '42345678901234567'
const BOT_USER_ID = '998877665544332211'

const NOW_MS = Date.UTC(2026, 10, 23, 12, 0, 0)
const DISCORD_EPOCH_MS = 1_420_070_400_000

// Discord snowflake を作る。ageMs 前に投稿された id にする（同順を保つため increment を増やす）
function messageIdAtAge(ageMs: number): string {
  const timestampMs = NOW_MS - ageMs - DISCORD_EPOCH_MS

  return String((BigInt(timestampMs) << 22n) + 1n)
}

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
  assert.ok(isDiscordMessageIdNewer(messageIdAtAge(1_000), messageIdAtAge(9_000)))
  assert.equal(discordMessageTimestampMs('not-a-snowflake'), null)
  assert.equal(isDiscordMessageIdNewer('abc', messageIdAtAge(1_000)), false)
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
    // 窓の上限を 60s にして、90s 前の message が stale で落ちることを確かめる
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

test('backfill: 上限を越える窓では新しい側を残し、古い側を over_limit で落とす', () => {
  const cursor = messageIdAtAge(300_000)
  const ages = Array.from({ length: BACKFILL_MAX_MESSAGES + 3 }, (_unused, index) => 5_000 + index * 100)

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

test('discord state: v1 の state.json を読んで cursor を null で埋める', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-state-migration-test-')),
  )

  try {
    await fs.mkdir(path.dirname(discordStateFilePath(dataDir)), { recursive: true, mode: 0o700 })
    await fs.writeFile(
      discordStateFilePath(dataDir),
      `${JSON.stringify({ version: 1, unit: 'araya-discord-old', readyId: 'ready-old', lastReadyAt: '2026-11-22T00:00:00.000Z' }, null, 2)}\n`,
      { mode: 0o600 },
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.version, DISCORD_STATE_VERSION)
    assert.equal(state.unit, 'araya-discord-old')
    assert.equal(state.lastSeenMessageId, null)
    // read だけでは file を書き換えない
    assert.equal(JSON.parse(await fs.readFile(discordStateFilePath(dataDir), 'utf8')).version, 1)

    // 次の保存で v2 になる
    writeDiscordBotState(dataDir, state)
    assert.equal(JSON.parse(await fs.readFile(discordStateFilePath(dataDir), 'utf8')).version, DISCORD_STATE_VERSION)

    // 未来の version と不正な cursor は reject（壊れた state を黙って上書きしない）
    await fs.writeFile(
      discordStateFilePath(dataDir),
      `${JSON.stringify({ version: DISCORD_STATE_VERSION + 1, unit: null, lastReadyAt: null }, null, 2)}\n`,
      { mode: 0o600 },
    )
    assert.throws(() => readDiscordBotState(dataDir), { code: 'discord_state_invalid' })

    await fs.writeFile(
      discordStateFilePath(dataDir),
      `${JSON.stringify({ version: DISCORD_STATE_VERSION, unit: null, lastReadyAt: null, lastSeenMessageId: 'not-an-id' }, null, 2)}\n`,
      { mode: 0o600 },
    )
    assert.throws(() => readDiscordBotState(dataDir), { code: 'discord_state_invalid' })
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord state: cursor は新しい id だけ前に進める', () => {
  const base = newState()
  const older = messageIdAtAge(30_000)
  const newer = messageIdAtAge(1_000)

  const first = noteDiscordSeenMessageId(base, older)

  assert.equal(first.lastSeenMessageId, older)
  // 同じ object を返すときは caller が保存を飛ばせる
  assert.equal(noteDiscordSeenMessageId(first, messageIdAtAge(40_000)), first)
  assert.equal(noteDiscordSeenMessageId(first, ''), first)

  const second = noteDiscordSeenMessageId(first, newer)

  assert.equal(second.lastSeenMessageId, newer)
  assert.equal(first.lastSeenMessageId, older, '元の state は変わらない')
})

type BackfillHarness = {
  logs: Record<string, unknown>[]
  saved: string[]
  handled: { messageId: string; content: string; replyText?: string }[]
  sent: { content: string; nonce: string }[]
  gateway: DiscordGateway
  chatHandler: DiscordChatHandler
}

function createBackfillHarness(
  history: readonly DiscordHistoryMessage[],
  options: { failFetch?: boolean } = {},
): BackfillHarness {
  const logs: Record<string, unknown>[] = []
  const saved: string[] = []
  const handled: BackfillHarness['handled'] = []
  const sent: { content: string; nonce: string }[] = []

  const gateway: DiscordGateway = {
    async connect() {},
    async sendText(content, nonce) {
      sent.push({ content, nonce })
    },
    fetchRecentMessages: options.failFetch
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
      // chatHandler は chunk と nonce を決める側。backfill の reply closure が呼ばれる
      await reply('response', `nonce-${message.messageId}`)
      record.replyText = 'response'
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

  return { logs, saved, handled, sent, gateway, chatHandler }
}

test('backfill: cursor が無い起動では history の newest を cursor に置いて今回は処理しない', async () => {
  const newest = messageIdAtAge(1_000)
  const harness = createBackfillHarness([historyMessage(newest), historyMessage(messageIdAtAge(9_000))])
  let state: DiscordBotState = newState()

  const outcome = await runDiscordRestartBackfill({
    config,
    botUserId: BOT_USER_ID,
    gateway: harness.gateway,
    chatHandler: harness.chatHandler,
    log: (entry) => {
      harness.logs.push(entry)
    },
    nowMs: () => NOW_MS,
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
  assert.ok(harness.logs.some((entry) => entry.type === 'discord_backfill_seeded' && entry.messageId === newest))
})

test('backfill: 窓中の message を古い順に会話へ流し、1 件ごとに cursor を保存する', async () => {
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
    config,
    botUserId: BOT_USER_ID,
    gateway: harness.gateway,
    chatHandler: harness.chatHandler,
    log: (entry) => {
      harness.logs.push(entry)
    },
    nowMs: () => NOW_MS,
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
    [`nonce-${first}`, `nonce-${second}`],
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
    config,
    botUserId: BOT_USER_ID,
    gateway: harness.gateway,
    chatHandler: harness.chatHandler,
    log: (entry) => {
      harness.logs.push(entry)
    },
    nowMs: () => NOW_MS,
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
    harness.logs.some((entry) => entry.type === 'discord_backfill_ignored' && entry.reason === 'already_handled'),
  )
})

test('backfill: history が読めなくても bot の起動を止めない（理由だけ log）', async () => {
  const cursor = messageIdAtAge(90_000)
  const harness = createBackfillHarness([], { failFetch: true })
  let state: DiscordBotState = { ...newState(), lastSeenMessageId: cursor }

  const outcome = await runDiscordRestartBackfill({
    config,
    botUserId: BOT_USER_ID,
    gateway: harness.gateway,
    chatHandler: harness.chatHandler,
    log: (entry) => {
      harness.logs.push(entry)
    },
    nowMs: () => NOW_MS,
    state,
    saveState: (next) => {
      state = next
    },
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [])
  assert.equal(state.lastSeenMessageId, cursor)
  assert.ok(harness.logs.some((entry) => entry.type === 'discord_backfill_skipped' && entry.reason === 'history_fetch_failed'))

  // gateway が history API を持たない（古い fake など）場合も飛ばす
  const noApi = createBackfillHarness([])
  const outcomeNoApi = await runDiscordRestartBackfill({
    config,
    botUserId: BOT_USER_ID,
    gateway: { ...noApi.gateway, fetchRecentMessages: undefined },
    chatHandler: noApi.chatHandler,
    log: (entry) => {
      noApi.logs.push(entry)
    },
    nowMs: () => NOW_MS,
    state: newState(),
    saveState: () => {},
    isHandled: () => false,
    markHandled: () => {},
  })

  assert.equal(outcomeNoApi.seeded, false)
  assert.ok(noApi.logs.some((entry) => entry.reason === 'history_api_unavailable'))
})

test('backfill: snowflake からの復元時刻が Discord REST の timestamp と一致する（#36 の epoch 実測）', () => {
  // 2026-11-24 に channel の history を REST で読んだ実測（Discord が自分で返した timestamp）。
  // 以前使っていた epoch 1_420_064_800_000 ではここが 5600.000 s ずれ、age 上限 15 分を常に越えて
  // 窓内の message が全部 stale で捨れた（human backfill が 1 件も処理されなかった実因）
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

test('backfill: 無受信窓の message は age 上限で捨てられず、窓の長さを log に残す', async () => {
  const cursor = messageIdAtAge(200_000)
  const windowId = messageIdAtAge(20_000)
  const harness = createBackfillHarness([historyMessage(windowId), historyMessage(cursor)])
  const state = noteDiscordSeenMessageId(newState(), cursor)

  const outcome = await runDiscordRestartBackfill({
    config,
    botUserId: BOT_USER_ID,
    gateway: harness.gateway,
    chatHandler: harness.chatHandler,
    log: (entry) => {
      harness.logs.push(entry)
    },
    nowMs: () => NOW_MS,
    state,
    saveState: (next) => {
      harness.saved.push(next.lastSeenMessageId ?? '')
    },
    isHandled: () => {
      return false
    },
    markHandled: () => {},
  })

  assert.deepEqual(outcome.handled, [windowId])

  const received = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill_received'
  })

  assert.ok(received !== undefined)
  assert.equal(received.ageMs, 20_000, '投稿から backfill 処理までの wall clock age')

  const summary = harness.logs.find((entry) => {
    return entry.type === 'discord_backfill'
  })

  assert.ok(summary !== undefined)
  assert.equal(summary.windowMs, 180_000, 'cursor から history の最新 id までの Discord 側の窓')
  assert.equal(summary.cursor, cursor)
})


