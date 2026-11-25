// 再起動の間に投稿された message を channel の history から取り直す（Issue #36）。
// Discord gateway は切断中に生成された messageCreate を再接続後に再配信しないため、unit を stop して
// ready になるまでの間に投稿された message は黙って消える。bot は live で処理を終えた message id を
// state.json の cursor に記録しているので、ready 後に「cursor より新しい history」だけを
// 古い順に会話 queue へ流し込む。
// cursor は turn が終わってから進む（at-least-once）。実行中に kill された message は cursor より
// 古い側に残るので、次の restart でここに取り直される

import { createHash } from 'node:crypto'
import { discordChatAdmissionFailures, type DiscordChatHandler } from './chat.ts'
import type { DiscordConfig } from './config.ts'
import type { DiscordGateway, DiscordHistoryMessage } from './gateway.ts'
import {
  canAdvanceCursorPast,
  isDiscordMessageIdNewer,
  noteDiscordSeenMessageId,
  type DiscordBotState,
} from './state.ts'

// history は 1 回の fetch で 100 件まで。取り直すのは直近の message だけで十分なので、処理するのは新しい 20 件
export const BACKFILL_FETCH_LIMIT = 100
export const BACKFILL_MAX_MESSAGES = 20
// stop していた期間が長かった（bot が落ちてしばらく起動していなかった）ときに、古い会話を後から走らせない上限。
// unfinished（受理済みで turn が終わっていない）の id はこの上限を見ない：at-least-once の約束で
// 必ず取り直す対象なので、cursor より新しい unfinished を age で捨てるとそのまま恒久的に消える
export const BACKFILL_MAX_AGE_MS = 15 * 60_000
// history fetch が止まっても shutdown を止めない
export const BACKFILL_FETCH_TIMEOUT_MS = 8_000

// Discord snowflake: 先頭 42 bit が millisecond timestamp（Discord epoch 2015-01-01T00:00:00Z）。
// Discord REST が返す timestamp と一致する値を使う。1_420_064_800_000（2014-12-31T22:26:40Z）を
// 使っていた過去実装では、復元した投稿時刻が 5_600_000 ms 古くなり、host clock 基準の age 判定で
// 取り直しの対象になった message が全て stale になっていた（#36 の human backfill が一発も処理されなかった実因）
const DISCORD_EPOCH_MS = 1_420_070_400_000

export type BackfillSkipReason = 'self_message' | 'not_allowed' | 'empty' | 'stale' | 'over_limit'
export type BackfillSkip = { messageId: string; reason: BackfillSkipReason }

export type BackfillSelection = { candidates: DiscordHistoryMessage[]; skipped: BackfillSkip[] }

export function discordMessageTimestampMs(messageId: string): number | null {
  try {
    return Number((BigInt(messageId) >> 22n) + BigInt(DISCORD_EPOCH_MS))
  } catch {
    return null
  }
}

// 受信できていなかった期間の長さを測るための、history の中で最新の id 時刻。id 単調増加なので比較だけで決まる
export function latestDiscordHistoryTimestampMs(
  history: readonly DiscordHistoryMessage[],
): number | null {
  let newest: number | null = null

  for (const message of history) {
    const createdMs = discordMessageTimestampMs(message.messageId)

    if (createdMs !== null && (newest === null || createdMs > newest)) {
      newest = createdMs
    }
  }

  return newest
}

// cursor より新しい message だけを対象に、live と同じ admission gate を通して古い順に並べ直す。
// cursor が無い instance は live で何も拾えていないので history を処理しない（seed 側で埋める）
export function selectBackfillMessages(
  input: {
    history: readonly DiscordHistoryMessage[]
    cursor: string | null
    config: DiscordConfig
    botUserId: string
    nowMs: () => number
    maxAgeMs?: number
    limit?: number
    // restart 前に受理して turn が終わっていない ids。含まれる id は age 上限を無視して取り直す
    unfinishedMessageIds?: ReadonlySet<string>
  },
): BackfillSelection {
  const maxAgeMs = input.maxAgeMs ?? BACKFILL_MAX_AGE_MS
  const limit = input.limit ?? BACKFILL_MAX_MESSAGES
  const unfinishedMessageIds = input.unfinishedMessageIds ?? new Set<string>()
  const skipped: BackfillSkip[] = []

  if (input.cursor === null) {
    return { candidates: [], skipped }
  }

  const candidates: DiscordHistoryMessage[] = []

  for (const message of input.history) {
    // live で既に処理・破棄した id は取り直さない
    if (!isDiscordMessageIdNewer(message.messageId, input.cursor)) {
      continue
    }

    if (message.isBot || message.userId === input.botUserId) {
      skipped.push({ messageId: message.messageId, reason: 'self_message' })

      continue
    }

    if (discordChatAdmissionFailures(message, input.config).length > 0) {
      skipped.push({ messageId: message.messageId, reason: 'not_allowed' })

      continue
    }

    // slash command の invocation など、本文を持たない interaction は会話にしない
    if (message.content.trim() === '') {
      skipped.push({ messageId: message.messageId, reason: 'empty' })

      continue
    }

    const createdMs = discordMessageTimestampMs(message.messageId)

    // age 上限は「stop していた期間が長いときに古い会話を後から走らせない」ためのもの。unfinished の id は
    // すでに受理されていて turn が終わっていないので、age に関係なく取り直す（2026-11-24 の incident では
    // 08:00 の shutdown 以降の 3 件が 15 分を越えたというだけで discord_backfill_ignored reason:"stale" になった）
    if (
      createdMs === null ||
      (!unfinishedMessageIds.has(message.messageId) && input.nowMs() - createdMs > maxAgeMs)
    ) {
      skipped.push({ messageId: message.messageId, reason: 'stale' })

      continue
    }

    candidates.push(message)
  }

  // fetch は新しい順。会話は古い順に続けるので並べ替え、上限を超えるときは新しい側を残す
  candidates.sort((a, b) => {
    return isDiscordMessageIdNewer(a.messageId, b.messageId) ? 1 : -1
  })

  if (candidates.length > limit) {
    const overflow = candidates.length - limit
    const droppedIds = new Set<string>()

    // 上限を越える分は unfinished ではない古い側から落とす。unfinished を over_limit で捨てると cursor が
    // その id を越えられず（unfinished gate）、次の restart でもまた落とされて取り直せない
    for (const message of candidates) {
      if (droppedIds.size >= overflow) {
        break
      }

      if (!unfinishedMessageIds.has(message.messageId)) {
        droppedIds.add(message.messageId)
      }
    }

    // unfinished だけで上限を越えているときは、古い順に続けるので古い側から落とす
    for (const message of candidates) {
      if (droppedIds.size >= overflow) {
        break
      }

      if (!droppedIds.has(message.messageId)) {
        droppedIds.add(message.messageId)
      }
    }

    const kept: DiscordHistoryMessage[] = []

    for (const message of candidates) {
      if (droppedIds.has(message.messageId)) {
        skipped.push({ messageId: message.messageId, reason: 'over_limit' })

        continue
      }

      kept.push(message)
    }

    return { candidates: kept, skipped }
  }

  return { candidates, skipped }
}

export type DiscordBackfillOutcome = {
  handled: string[]
  skipped: BackfillSkip[]
  // cursor が無かった instance。history の newest を cursor に置き、今回は何も処理しない
  seeded: boolean
}

export type DiscordBackfillDependencies = {
  config: DiscordConfig
  botUserId: string
  gateway: DiscordGateway
  chatHandler: DiscordChatHandler
  log(entry: Record<string, unknown>): void
  nowMs(): number
  // 起動時 state（cursor の floor）。bot.ts は memory の state を渡す
  state: DiscordBotState
  // cursor を前に進めた state を保存する（bot.ts は state.json へ書く）
  saveState(state: DiscordBotState): void
  // 同じ message を live で既に処理していたら取り直さない
  isHandled(messageId: string): boolean
  // backfill で処理した id を live 側にも伝える（shutdown 後の重複を防ぐ）
  markHandled(messageId: string): void
  // backfill で turn を終えた id（応答を送り終えた）。restart 後の再応答を抑える記録へ live 側が使う
  markAnswered(messageId: string): void
  // restart 前に受理して turn が終わっていなかった ids。含まれる id は age 上限を無視して取り直し、
  // 取り直して処理を終えるまで cursor をその id より後ろへ進めない。bot.ts は state.json から復元した
  // Set を渡す（backfill が処理を終えた id をここから除く）
  unfinishedMessageIds: Set<string>
}

// live の answer と restart 後の取り直しで同じ nonce を使い回さないための namespace。
// Discord の enforce_nonce（gateway payload の enforceNonce: true）は「過去数分のあいだ同じ author +
// 同じ nonce」を 1 通にまとめる（discord-api-types の docs に明記）。chat.ts の shutdown notice は
// CHAT_SHUTDOWN_UNPROCESSED_REPLY を messageId + chunk 0 の nonce（discordChatReplyNonce）で送るので、
// 取り直しの answer も同じ nonce にすると、再起動が数分以内に終わった場合に answer の 1 chunk 目が
// Discord 側で落ちる（notice だけが残り、取り直したのに応答が見えない）。取り直し側だけを別の
// namespace にすると notice と answer は別の message になり、取り直し同士の重複（取り直し中に kill
// されて次の restart で再取り直し）は同じ nonce として Discord 側にまとめられる
export function discordBackfillReplyNonce(messageId: string, chunkIndex: number) {
  return `araya-${createHash('sha256').update(`backfill:${messageId}:${chunkIndex}`).digest('hex').slice(0, 18)}`
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} が ${timeoutMs}ms を越えました`))
      }, timeoutMs)

      promise.then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

// ready 後に 1 回走る。失敗しても会話機能と shutdown を止めない（log に理由を残す）
export async function runDiscordRestartBackfill(
  deps: DiscordBackfillDependencies,
): Promise<DiscordBackfillOutcome> {
  const nowMs = deps.nowMs
  const noop: DiscordBackfillOutcome = { handled: [], skipped: [], seeded: false }

  if (deps.gateway.fetchRecentMessages === undefined) {
    deps.log({ type: 'discord_backfill_skipped', reason: 'history_api_unavailable' })

    return noop
  }

  let history: DiscordHistoryMessage[]

  try {
    history = await withTimeout(
      deps.gateway.fetchRecentMessages(BACKFILL_FETCH_LIMIT),
      BACKFILL_FETCH_TIMEOUT_MS,
      'discord history fetch',
    )
  } catch (error) {
    deps.log({
      type: 'discord_backfill_skipped',
      reason: 'history_fetch_failed',
      message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    })

    return noop
  }

  const cursor = deps.state.lastSeenMessageId ?? null

  // cursor が無い状態では「どこまで見たか」を確定できない。history の newest を cursor に置いて
  // 次の再起動から取り直せるようにし、今回は何も処理しない
  if (cursor === null) {
    let newest: string | null = null

    for (const message of history) {
      if (isDiscordMessageIdNewer(message.messageId, newest)) {
        newest = message.messageId
      }
    }

    if (newest === null) {
      deps.log({ type: 'discord_backfill_skipped', reason: 'no_history' })

      return noop
    }

    const seeded = noteDiscordSeenMessageId(deps.state, newest)

    if (seeded !== deps.state) {
      deps.saveState(seeded)
    }

    deps.log({ type: 'discord_backfill_seeded', messageId: newest, historyCount: history.length })

    return { handled: [], skipped: [], seeded: true }
  }

  const selection = selectBackfillMessages({
    history,
    cursor,
    config: deps.config,
    botUserId: deps.botUserId,
    nowMs,
    unfinishedMessageIds: deps.unfinishedMessageIds,
  })

  // history の fetch 結果に無い unfinished は、message が削除されたか fetch 範囲（新しい 100 件）の外。backfill は
  // history 以外を取り直す手段が無いので、これを unfinished に残したままにすると cursor が恒久的に止まる
  // （稼働中の log で測った 1574692480371392604 は 2026-11-24T08:00:14Z の shutdown で unfinished に出たが、
  // 09:02:01Z の restart 後の history に 1 度も現れず、取り直されなかった）。cursor を止めたままにはしないので
  // 対象から出して log に残す。fetch した後に届いた live message は history に無いだけなので除く
  // （deps.isHandled はこの process が live で受理した id を含む）
  const fetchedMessageIds = new Set<string>()

  for (const message of history) {
    fetchedMessageIds.add(message.messageId)
  }

  // history が 0 件の fetch（channel が見えない・API が 0 件を返した）では「fetch 結果に無い」ことから
  // 何も言えないので、unfinished を対象から出さない
  if (fetchedMessageIds.size > 0) {
    for (const messageId of [...deps.unfinishedMessageIds]) {
      if (fetchedMessageIds.has(messageId) || deps.isHandled(messageId)) {
        continue
      }

      deps.unfinishedMessageIds.delete(messageId)
      deps.log({ type: 'discord_backfill_unfinished_unreachable', messageId, historyCount: history.length })
    }
  }

  for (const skip of selection.skipped) {
    deps.log({ type: 'discord_backfill_ignored', messageId: skip.messageId, reason: skip.reason })

    // 会話にならない id（bot 自身・許可外 user・空本文）は live の discard と同じ扱い。unfinished に
    // 残したままにすると cursor がその id で止まり続けて、後ろの message も取り直せなくなる
    if (skip.reason === 'self_message' || skip.reason === 'not_allowed' || skip.reason === 'empty') {
      deps.unfinishedMessageIds.delete(skip.messageId)
    }
  }

  const handled: string[] = []
  let current = deps.state

  for (const message of selection.candidates) {
    if (deps.isHandled(message.messageId)) {
      // live（この process）か前回の process で既に処理した id。Discord は同じ author + 同じ nonce を過去数分の
      // あいだ 1 通にまとめるだけで、数分以上経った再送信は channel に届く。会話を二重に走らせないここで止める
      deps.log({ type: 'discord_backfill_ignored', messageId: message.messageId, reason: 'already_handled' })

      continue
    }

    deps.markHandled(message.messageId)

    const ageMs = (() => {
      const createdMs = discordMessageTimestampMs(message.messageId)

      return createdMs === null ? null : Math.max(0, nowMs() - createdMs)
    })()

    deps.log({
      type: 'discord_backfill_received',
      messageId: message.messageId,
      userId: message.userId,
      channelId: message.channelId,
      mentionsBot: message.mentionsBot,
      ageMs,
    })

    // chatHandler が渡す nonce は live の answer と同じ値（discordChatReplyNonce は messageId と chunk
    // index だけから決まり、restart しても同じ値になる）なので捨てて、取り直し専用の nonce を送る
    // （上の discordBackfillReplyNonce の comment）。chunk 順は chatHandler が決める順のまま数える
    const chunkIndexByMessageId = new Map<string, number>()
    const reply = async (content: string, liveNonce: string) => {
      void liveNonce
      const chunkIndex = chunkIndexByMessageId.get(message.messageId) ?? 0

      chunkIndexByMessageId.set(message.messageId, chunkIndex + 1)
      await deps.gateway.sendText(content, discordBackfillReplyNonce(message.messageId, chunkIndex))
    }

    await deps.chatHandler.handle(message, reply)
    handled.push(message.messageId)
    deps.markAnswered(message.messageId)
    // 取り直しが終わった id は unfinished から出す（age 上限を無視して取り直す対象はここまでの分だけ）
    deps.unfinishedMessageIds.delete(message.messageId)

    // cursor を 1 件ずつ前に進める。live と同じ規則で turn が終わってから進めるので、
    // 処理中に kill された message は次の restart の backfill が取り直します（at-least-once）。
    // まだ取り直していない unfinished より後ろへは進めない（bot.ts の discard 経路と同じ gate）
    const advanced = noteDiscordSeenMessageId(current, message.messageId)

    if (advanced !== current && canAdvanceCursorPast(deps.unfinishedMessageIds, message.messageId)) {
      current = advanced
    }

    deps.saveState(current)
  }

  if (handled.length > 0 || selection.skipped.length > 0) {
    deps.log({
      type: 'discord_backfill',
      handled: handled.length,
      skipped: selection.skipped.length,
      cursor,
      // 取り直しを終えた位置の cursor。unfinished が残っている間はここが進んでいないことを discord.log から
      // 確かめる（cursor は取り直し開始前の位置）
      cursorAfter: current.lastSeenMessageId ?? null,
      // cursor から history の最新 id までの Discord 側の時間差（message を受信できていなかった期間の実測用）
      unreceivedMs: (() => {
        const cursorMs = discordMessageTimestampMs(cursor)
        const newestMs = latestDiscordHistoryTimestampMs(history)

        if (cursorMs === null || newestMs === null) {
          return null
        }

        return Math.max(0, newestMs - cursorMs)
      })(),
      // 取り直しを終えた後も残っている unfinished。history に届かなかった id は unreachable として log 出しするので、
      // ここに残る id は次の restart の history 候補として取り直せる id だけ
      unfinishedRemaining: deps.unfinishedMessageIds.size,
    })
  }

  return { handled, skipped: selection.skipped, seeded: false }
}
