// 再起動の間に投稿された message を channel の history から取り直す（Issue #36）。
// Discord gateway は切断中に生成された messageCreate を再接続後に再配信しないため、unit を stop して
// ready になるまでの窓に投稿された message は黙って消える。bot は live で処理を終えた message id を
// state.json の cursor に記録しているので、ready 後に「cursor より新しい history」だけを
// 古い順に会話 queue へ流し込む。
// cursor は turn が終わってから進む（at-least-once）。実行中に kill された message は cursor より
// 古い側に残るので、次の restart でここに取り直される

import { discordChatAdmissionFailures, type DiscordChatHandler } from './chat.ts'
import type { DiscordConfig } from './config.ts'
import type { DiscordGateway, DiscordHistoryMessage } from './gateway.ts'
import { isDiscordMessageIdNewer, noteDiscordSeenMessageId, type DiscordBotState } from './state.ts'

// history は 1 回の fetch で 100 件まで。取り直すのは直近の窓だけで十分なので、処理するのは新しい 20 件
export const BACKFILL_FETCH_LIMIT = 100
export const BACKFILL_MAX_MESSAGES = 20
// 窓が長かった（bot が落ちてしばらく起動していなかった）ときに、古い会話を後から走らせない上限
export const BACKFILL_MAX_AGE_MS = 15 * 60_000
// history fetch が止まっても shutdown を止めない
export const BACKFILL_FETCH_TIMEOUT_MS = 8_000

// Discord snowflake: 先頭 42 bit が millisecond timestamp（Discord epoch 2015-01-01T00:00:00Z）。
// Discord REST が返す timestamp と一致する値を使う。1_420_064_800_000（2014-12-31T22:26:40Z）を
// 使っていた過去実装では、復元した投稿時刻が 5_600_000 ms 古くなり、host clock 基準の age 判定で
// 窓内の message が全て stale になっていた（#36 の human backfill が一発も処理されなかった実因）
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

// 窓の長さを測るための、history の中で最新の id 時刻。id 単調増加なので比較だけで決まる
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
  },
): BackfillSelection {
  const maxAgeMs = input.maxAgeMs ?? BACKFILL_MAX_AGE_MS
  const limit = input.limit ?? BACKFILL_MAX_MESSAGES
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

    if (createdMs === null || input.nowMs() - createdMs > maxAgeMs) {
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
    const dropped = candidates.slice(0, candidates.length - limit)

    for (const message of dropped) {
      skipped.push({ messageId: message.messageId, reason: 'over_limit' })
    }

    return { candidates: candidates.slice(candidates.length - limit), skipped }
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
  })

  for (const skip of selection.skipped) {
    deps.log({ type: 'discord_backfill_ignored', messageId: skip.messageId, reason: skip.reason })
  }

  const handled: string[] = []
  let current = deps.state

  for (const message of selection.candidates) {
    if (deps.isHandled(message.messageId)) {
      // live で既に処理した id。nonce が同じなので送っても Discord では 1 通にまとまるが、会話を二重に走らせない
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

    // backfill の返信は channel への send（live の message.reply と同じ nonce rule）。
    // chatHandler 側で chunk と nonce を決めるので、ここでは送るだけにする
    const reply = async (content: string, nonce: string) => {
      await deps.gateway.sendText(content, nonce)
    }

    await deps.chatHandler.handle(message, reply)
    handled.push(message.messageId)

    // cursor を 1 件ずつ前に進める。live と同じ規則で turn が終わってから進めるので、
    // 処理中に kill された message は次の restart の backfill が取り直します（at-least-once）
    const advanced = noteDiscordSeenMessageId(current, message.messageId)

    if (advanced !== current) {
      current = advanced
      deps.saveState(advanced)
    }
  }

  if (handled.length > 0 || selection.skipped.length > 0) {
    deps.log({
      type: 'discord_backfill',
      handled: handled.length,
      skipped: selection.skipped.length,
      cursor,
      // cursor から history の最新 id までの Discord 側の窓の長さ（取りこぼし窓の実測用）
      windowMs: (() => {
        const cursorMs = discordMessageTimestampMs(cursor)
        const newestMs = latestDiscordHistoryTimestampMs(history)

        if (cursorMs === null || newestMs === null) {
          return null
        }

        return Math.max(0, newestMs - cursorMs)
      })(),
    })
  }

  return { handled, skipped: selection.skipped, seeded: false }
}
