// 再起動の間に投稿された message を channel の history から取り直す（Issue #36）。
// Discord gateway は切断中に生成された messageCreate を再接続後に再配信しないため、unit を stop して
// ready になるまでの間に投稿された message は黙って消える。bot は live で処理を終えた message id を
// state.json の cursor に記録しているので、ready 後に「cursor より新しい history」だけを
// 古い順に会話 queue へ流し込む。
// cursor は turn が終わってから進む（at-least-once）。実行中に kill された message は cursor より
// 古い側に残るので、次の restart でここに取り直される

import { createHash } from 'node:crypto'
import {
  CHAT_SHUTDOWN_UNPROCESSED_REPLY,
  CHAT_UNAVAILABLE_REPLY,
  discordChatAdmissionFailures,
  type DiscordChatHandler,
} from './chat.ts'
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

export type BackfillSelection = {
  candidates: DiscordHistoryMessage[]
  skipped: BackfillSkip[]
  // 件数上限（BACKFILL_MAX_MESSAGES）でこの round に落とされた unfinished。取り直し対象なのに history の
  // fetch window と件数上限で取り直せないので、cursor をその id より後ろへ進めない（runDiscordRestartBackfill
  // が discord_backfill_unfinished_stuck として log する）
  stuckUnfinishedMessageIds: string[]
}

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
    return { candidates: [], skipped, stuckUnfinishedMessageIds: [] }
  }

  const candidates: DiscordHistoryMessage[] = []

  for (const message of input.history) {
    // cursor gate 以前に書かれた state file など、cursor の invariant が壊れた state 上の unfinished もここで
    // 取り直す（上の selectBackfillMessages の unfinished gate）
    if (!isDiscordMessageIdNewer(message.messageId, input.cursor) && !unfinishedMessageIds.has(message.messageId)) {
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
    const stuckUnfinishedMessageIds: string[] = []

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

    // unfinished だけで上限を越えているときは、古い順に続けるので古い側から落とす。落とした unfinished は
    // この round で取り直せない（stuck）ので、id を selection.stuckUnfinishedMessageIds に出して黙らせない
    for (const message of candidates) {
      if (droppedIds.size >= overflow) {
        break
      }

      if (!droppedIds.has(message.messageId)) {
        droppedIds.add(message.messageId)

        if (unfinishedMessageIds.has(message.messageId)) {
          stuckUnfinishedMessageIds.push(message.messageId)
        }
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

    return { candidates: kept, skipped, stuckUnfinishedMessageIds }
  }

  return { candidates, skipped, stuckUnfinishedMessageIds: [] }
}

export type DiscordBackfillOutcome = {
  handled: string[]
  skipped: BackfillSkip[]
  // cursor が無かった instance。history の newest を cursor に置き、今回は何も処理しない
  seeded: boolean
  // history の fetch まで辿り着いたか（API 無し・fetch 失敗は false）。bot.ts はこれで「取り直しを試みる
  // ことができたか」を判断し、history を読めない起動で cursor より古い unfinished を prune しない
  // （fetch 失敗で prune すると、次の restart で取り直せたはずの id を黙って落とす）
  historyFetched: boolean
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
  // 同じ message を live で既に処理しているか、前回の process で応答を送り終えた id なら取り直さない。
  // 「受理した事実」だけでは飛ばさない（liveProcessingMessageIds は実行中の id だけ）。unfinished の id は
  // どの記録に入っていても unfinished 側を優先して取り直す（案内の送信記録に処理完了を依存させない）
  isHandled(messageId: string): boolean
  // backfill で処理した id を live 側にも伝える（shutdown 後の重複を防ぐ）
  markHandled(messageId: string): void
  // backfill で turn を終えて実応答の chunk を送れた id。restart 後の再応答を抑える記録（案内だけ送った
  // turn はここに記録しない）
  markAnswered(messageId: string): void
  // restart 前に受理して turn が終わっていなかった ids。含まれる id は age 上限を無視して取り直し、
  // 取り直して処理を終えるまで cursor をその id より後ろへ進めない。bot.ts は state.json から復元した
  // Set を渡す（backfill が処理を終えた id をここから除く）
  unfinishedMessageIds: Set<string>
  // live（この process）で受理して turn が実行中の ids。同じ message を live と backfill で二重に走らせない
  // ための排他。この id は reason:"live_processing" で飛ばし、unfinished には残したままにする（live 側が
  // 終わるか、process が kill されて次の restart の取り直しまで待ち合わせる）
  liveProcessingMessageIds: Set<string>
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
  const noop: DiscordBackfillOutcome = { handled: [], skipped: [], seeded: false, historyFetched: false }

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

      return { handled: [], skipped: [], seeded: false, historyFetched: true }
    }

    const seeded = noteDiscordSeenMessageId(deps.state, newest)

    if (seeded !== deps.state) {
      deps.saveState(seeded)
    }

    deps.log({ type: 'discord_backfill_seeded', messageId: newest, historyCount: history.length })

    return { handled: [], skipped: [], seeded: true, historyFetched: true }
  }

  const selection = selectBackfillMessages({
    history,
    cursor,
    config: deps.config,
    botUserId: deps.botUserId,
    nowMs,
    unfinishedMessageIds: deps.unfinishedMessageIds,
  })

  // 取り直し対象（unfinished）なのに 20 件の上限でこの round に落とされた ids。cursor はこれらの id より
  // 後ろへ進めない（下の canAdvanceCursorPast）ので、取り直しが進まない限り毎 round 同じ fetch window
  // （新しい 100 件）を読み直し、cursor は動かず candidates も同じ 100 件ままになる。黙って cursor を
  // 止めないため id を log に出す（state file 側の prune は bot.ts が担当し、落とした事は
  // discord_unfinished_pruned に出す）
  if (selection.stuckUnfinishedMessageIds.length > 0) {
    deps.log({
      type: 'discord_backfill_unfinished_stuck',
      count: selection.stuckUnfinishedMessageIds.length,
      messageIds: selection.stuckUnfinishedMessageIds.slice(0, 20),
      cursor,
      maxMessages: BACKFILL_MAX_MESSAGES,
      fetchLimit: BACKFILL_FETCH_LIMIT,
    })
  }

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
      // live で受理して実行中の id は history の fetch より後に届いただけなので「fetch 結果に無い」だけで
      // 対象から出せない（案 1 では受理の事実を liveMessageIds に書かないので、isHandled にも入っていない）
      if (fetchedMessageIds.has(messageId) || deps.liveProcessingMessageIds.has(messageId) || deps.isHandled(messageId)) {
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
      // live gate で飛ばすのは「処理中」か「処理を終えた」id だけ。受理した事実は gate ではないので、
      // unfinished の id はここで飛ばされない（live が処理中の id は live 側が終わるまで待つ）
      const reason = deps.liveProcessingMessageIds.has(message.messageId) ? 'live_processing' : 'already_handled'

      deps.log({ type: 'discord_backfill_ignored', messageId: message.messageId, reason })

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
    // 実応答の chunk を送れたか数える。self notice（CHAT_SHUTDOWN_UNPROCESSED_REPLY）と会話機能不可の案内
    // （CHAT_UNAVAILABLE_REPLY）は Discord 側への送信結果であって処理の完了ではないので、これだけ送った
    // turn を answered に記録しない（notice の送信記録に取り直し判断を依存させない）。会話を実行して
    // 失敗した旨の案内（CHAT_ERROR_REPLY）は turn が走った結果なので answered に数える
    let answerChunks = 0
    const reply = async (content: string, liveNonce: string) => {
      void liveNonce
      const chunkIndex = chunkIndexByMessageId.get(message.messageId) ?? 0

      chunkIndexByMessageId.set(message.messageId, chunkIndex + 1)

      if (content !== CHAT_SHUTDOWN_UNPROCESSED_REPLY && content !== CHAT_UNAVAILABLE_REPLY) {
        answerChunks += 1
      }

      await deps.gateway.sendText(content, discordBackfillReplyNonce(message.messageId, chunkIndex))
    }

    await deps.chatHandler.handle(message, reply)
    handled.push(message.messageId)

    if (answerChunks > 0) {
      // 応答を送った ids を answered に記録する択（nonce だけに依存しない）。Discord の enforce_nonce の
      // 重複窓は過去数分のあいだだけなので、restart をまたいだ二度応答は nonce では止められない。
      // at-least-once は壊れない: unfinished かつ answered でない id は age 上限を無視して取り直し、
      // turn 完了＋応答送信済みは処理完了なので再実行しない。応答送信中に process が消えた case は
      // answered に入らないので unfinished のまま残り、次の restart が取り直して二度走ることがある
      // （at-least-once の副作用として許容）
      deps.markAnswered(message.messageId)
    }

    // 取り直して turn を終えた id は unfinished から出す（残すと cursor がその id で止まり続ける）。
    // age 上限を無視して取り直す対象はここまでの分だけ
    deps.unfinishedMessageIds.delete(message.messageId)

    // cursor を 1 件ずつ前に進める。live と同じ規則で turn が終わってから進めるので、
    // 処理中に kill された message は次の restart の backfill が取り直します（at-least-once）。
    // まだ取り直していない unfinished より後ろへは進めない。gate の向きは live 側（bot.ts の turn 完了・
    // discard 経路）と同じで、「unfinished に messageId より古い id が残っているなら進めない」方向。
    // 逆（unfinished が newer なら止める）にすると、取り直していない古い id を cursor が越えて
    // 二度と取り直せなくなる（2026-11-24 の incident の形）
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

  return { handled, skipped: selection.skipped, seeded: false, historyFetched: true }
}
