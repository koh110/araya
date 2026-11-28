import { createHash } from 'node:crypto'
import type { Redactor } from '../infrastructure/redaction.ts'
import type { ProgressSnapshot } from '../agent/progress.ts'
import { createDiscordControlCommands, type DiscordControlCommands } from './commands.ts'
import type { DiscordConfig } from './config.ts'
import type { DiscordCommandRequest } from './gateway.ts'

export type DiscordChatMessageMetadata = {
  guildId: string | null
  channelId: string
  userId: string
  isBot: boolean
  isWebhook: boolean
  isSystem: boolean
  mentionsBot: boolean
}

export type DiscordChatMessage = DiscordChatMessageMetadata & {
  messageId: string
  content: string
}

export function stripDiscordBotMention(content: string, botUserId: string) {
  const escapedUserId = botUserId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

  return content.replace(new RegExp(`<@!?${escapedUserId}>`, 'gu'), '').trim()
}

const DISCORD_REPLY_MAX_CHARS = 1900
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u

type FenceBlock = {
  kind: 'fence'
  lines: string[]
  marker: string
  info: string
}

type ReplyBlock = { kind: 'text'; line: string } | FenceBlock

export type DiscordChatReplySplit = {
  chunks: string[]
  // 1 つの fenced code block を複数 message に割る時、chunk 頭で開き直した fence の数
  fenceReopens: number
}

function codeLength(value: string) {
  return Array.from(value).length
}

function fenceMatchOf(value: string) {
  return FENCE_LINE_PATTERN.exec(value)
}

// fence を閉じる行か。開始行と同じ記号で、長さが高さ以上、info string を持たない
function closesFence(block: FenceBlock, value: string) {
  const match = fenceMatchOf(value)

  if (match === null) {
    return false
  }

  const marker = match[1] ?? ''
  const info = (match[2] ?? '').trim()

  return marker.charAt(0) === block.marker.charAt(0) && marker.length >= block.marker.length && info === ''
}

// 本文を「fence のまとまり」と「普通の行」に分割する。fence の中身を chunk 候補の外側へ逃がさないための前処理
function replyBlocksOf(text: string): ReplyBlock[] {
  const lines = text.split('\n')
  const blocks: ReplyBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const match = fenceMatchOf(line)

    if (match === null) {
      blocks.push({ kind: 'text', line })
      index += 1
      continue
    }

    const block: FenceBlock = { kind: 'fence', lines: [line], marker: match[1] ?? '```', info: (match[2] ?? '').trim() }
    index += 1

    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      index += 1
      block.lines.push(candidate)

      if (closesFence(block, candidate)) {
        break
      }
    }

    blocks.push(block)
  }

  return blocks
}

function splitLineFitting(line: string, capacity: number) {
  const characters = Array.from(line)

  if (characters.length <= capacity) {
    return { head: line, rest: '' }
  }

  let end = 0
  let length = 0

  while (end < characters.length) {
    const nextLength = characters[end]?.length ?? 0

    if (length + nextLength > capacity) {
      break
    }

    length += nextLength
    end += 1
  }

  // 上限ちょうどの後が空白なら単語を分けずにそのまま切る。
  let breakAt = characters[end]?.trim() === '' ? end : -1

  if (breakAt < 0) {
    for (let index = end - 1; index > 0; index -= 1) {
      if (characters[index]?.trim() === '') {
        breakAt = index
        break
      }
    }
  }

  const head = breakAt > 0 ? characters.slice(0, breakAt).join('').trimEnd() : ''

  if (head !== '') {
    let start = breakAt

    while (characters[start]?.trim() === '') {
      start += 1
    }

    return { head, rest: characters.slice(start).join('') }
  }

  // 空白が無い行（code の行など）は文字数で切る
  const cut = Math.max(1, Math.min(end, characters.length))

  return { head: characters.slice(0, cut).join(''), rest: characters.slice(cut).join('') }
}

export function splitDiscordChatReplyWithFences(content: string, maxChars = DISCORD_REPLY_MAX_CHARS): DiscordChatReplySplit {
  const trimmed = content.trim()

  if (trimmed === '') {
    return { chunks: [], fenceReopens: 0 }
  }

  const limit = Math.max(1, Math.floor(maxChars))
  const chunks: string[] = []
  let current: string[] = []
  let currentLength = 0
  let fenceReopens = 0

  const append = (line: string) => {
    if (current.length > 0) {
      currentLength += 1
    }

    current.push(line)
    currentLength += codeLength(line)
  }

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n'))
    }

    current = []
    currentLength = 0
  }

  const fitsLine = (line: string) => {
    return currentLength + (current.length > 0 ? 1 : 0) + codeLength(line) <= limit
  }

  for (const block of replyBlocksOf(trimmed)) {
    if (block.kind === 'text') {
      let pending: string | null = block.line

      while (pending !== null) {
        if (fitsLine(pending)) {
          append(pending)
          break
        }

        if (current.length === 0) {
          const { head, rest } = splitLineFitting(pending, limit)

          if (head === '') {
            break
          }

          append(head)
          flush()
          pending = rest === '' ? null : rest
          continue
        }

        const capacity = limit - currentLength - 1

        if (capacity <= 0) {
          flush()
          continue
        }

        const { head, rest } = splitLineFitting(pending, capacity)

        if (head === '') {
          flush()
          continue
        }

        append(head)
        flush()
        pending = rest === '' ? null : rest
      }

      continue
    }

    const blockCost = block.lines.reduce((total, line, index) => {
      return total + (index > 0 ? 1 : 0) + codeLength(line)
    }, 0)

    // fence のまとまりは 1 つの message に収める。収まらない時だけ閉じて開き直す
    if (currentLength + (current.length > 0 ? 1 : 0) + blockCost <= limit) {
      for (const line of block.lines) {
        append(line)
      }

      continue
    }

    if (current.length > 0) {
      flush()
    }

    if (blockCost <= limit) {
      for (const line of block.lines) {
        append(line)
      }

      continue
    }

    const closingLine = block.marker
    const reopenLine = block.info === '' ? block.marker : `${block.marker}${block.info}`
    const reopen = codeLength(reopenLine) <= limit ? reopenLine : block.marker
    let pendingLines: string[] = block.lines.slice()
    let reopenPrefix: string | null = null

    while (pendingLines.length > 0) {
      const lines: string[] = []
      let length = 0

      const pushLine = (value: string) => {
        if (lines.length > 0) {
          length += 1
        }

        lines.push(value)
        length += codeLength(value)
      }

      if (reopenPrefix !== null) {
        pushLine(reopenPrefix)
      }

      const closingCost = codeLength(closingLine) + 1
      let taken = 0

      while (taken < pendingLines.length) {
        const line = pendingLines[taken] ?? ''
        const cost = (lines.length > 0 ? 1 : 0) + codeLength(line)
        const reserve = taken < pendingLines.length - 1 ? closingCost : 0

        if (length + cost + reserve > limit) {
          break
        }

        pushLine(line)
        taken += 1
      }

      if (taken === 0) {
        // 1 行も収まらない: 行そのものを割って残りを次の chunk に回す
        const capacity = Math.max(1, limit - length - (lines.length > 0 ? 1 : 0) - (pendingLines.length > 1 ? closingCost : 0))
        const { head, rest } = splitLineFitting(pendingLines[0] ?? '', capacity)
        pushLine(head)

        if (rest === '') {
          pendingLines.shift()
        } else {
          pendingLines[0] = rest
        }
      } else {
        pendingLines = pendingLines.slice(taken)
      }

      const closingOnly = pendingLines.length === 1 && closesFence(block, pendingLines[0] ?? '')
      let closedHere = false

      if (pendingLines.length > 0 && length + (lines.length > 0 ? 1 : 0) + codeLength(closingLine) <= limit) {
        pushLine(closingLine)
        closedHere = true

        // 残りが本物の閉じ行だけなら、この chunk の closing と同一。同じ行を 2 回出さない
        if (closingOnly) {
          pendingLines = []
        }
      }

      current = lines
      currentLength = length
      flush()

      if (closedHere && pendingLines.length > 0) {
        fenceReopens += 1
        reopenPrefix = reopen
      } else {
        reopenPrefix = null
      }
    }
  }

  flush()

  return {
    chunks: chunks.filter((chunk) => {
      return chunk !== ''
    }),
    fenceReopens,
  }
}

export function splitDiscordChatReply(content: string, maxChars = DISCORD_REPLY_MAX_CHARS) {
  return splitDiscordChatReplyWithFences(content, maxChars).chunks
}

export function discordChatReplyNonce(messageId: string, chunkIndex: number) {
  return `araya-${createHash('sha256').update(`${messageId}:${chunkIndex}`).digest('hex').slice(0, 18)}`
}

// 取りこぼし診断用の拒否理由。message 1 件ごとに、どの許可条件を落としたか列挙する
export type DiscordChatAdmissionFailure =
  | 'guild_mismatch'
  | 'channel_mismatch'
  | 'user_not_allowed'
  | 'is_bot'
  | 'is_webhook'
  | 'is_system'
  // gateway 層のみ: Araya 自身の messageCreate echo を会話入力から除外した理由
  | 'self_message'

export function discordChatAdmissionFailures(
  message: DiscordChatMessageMetadata,
  config: DiscordConfig,
): DiscordChatAdmissionFailure[] {
  const failures: DiscordChatAdmissionFailure[] = []

  if (message.guildId !== config.guildId) {
    failures.push('guild_mismatch')
  }

  if (message.channelId !== config.channelId) {
    failures.push('channel_mismatch')
  }

  if (!config.allowedUserIds.includes(message.userId)) {
    failures.push('user_not_allowed')
  }

  if (message.isBot) {
    failures.push('is_bot')
  }

  if (message.isWebhook) {
    failures.push('is_webhook')
  }

  if (message.isSystem) {
    failures.push('is_system')
  }

  return failures
}

export function isDiscordChatMessageAllowed(
  message: DiscordChatMessageMetadata,
  config: DiscordConfig,
) {
  return discordChatAdmissionFailures(message, config).length === 0
}

export type DiscordChatSession = {
  submit(content: string, requestId: string): Promise<string>
  reset(requestId: string): Promise<void>
  stop?(): Promise<void>
  close?(): Promise<void>
  // control command の status 表示用。main conversation の durable id を返す
  describe?(): { conversationId: number | null; progress?: ProgressSnapshot | null }
}

export type DiscordChatReply = (content: string, nonce: string) => Promise<void>

// slash command の応答（ephemeral）。nonce は不要なので本文だけ渡す
export type DiscordCommandReply = (content: string) => Promise<void>

// HOOT が承認済みの dispatch を main 会話へ流すための input（Issue #31）。
// 人間の message と同じ queue で直列化するので、会話の途中に別の agent が割り込まない
export type DiscordChatInjection = {
  content: string
  // main 会話の submit の requestId。HOOT の inject request から作る（同じ案件を繰り返さない）
  requestId: string
  // 「何を自動化したか」を人間に返す 1 文
  notice: string
}

export type DiscordChatHandlerDependencies = {
  config: DiscordConfig
  botUserId: string
  session: DiscordChatSession | null
  redactor: Redactor
  log(entry: Record<string, unknown>): void
  // control command（status / hoot ...）が読む state file の位置
  dataDir: string
  nowMs?(): number
  // 省略すると createDiscordControlCommands を使う（test で差し替え可能）
  control?: DiscordControlCommands
}

export type DiscordChatHandler = {
  handle(message: DiscordChatMessage, reply: DiscordChatReply): Promise<void>
  // slash command（/araya ... / /hoot ...）を queue の外で処理する。会話の実行中でも効く
  handleCommand(request: DiscordCommandRequest, reply: DiscordCommandReply): Promise<void>
  // CLI の control request を slash command と同じ kernel で処理し、reply text を返す（Discord へは送らない）
  runControl(request: DiscordCommandRequest): Promise<string>
  inject(injection: DiscordChatInjection, reply: DiscordChatReply): Promise<string>
  stopAccepting(): void
  drain(): Promise<void>
  // 実行中の turn が CHAT_STALL_WARN_MS を超えて続いているかを log に出す（bot の poll loop から呼ぶ）
  tick(): void
  // shutdown log 用の pending 内訳（実行待ちの queue 残り と 実行中の turn。elapsedMs は turn の経過時間）
  pendingCount(): { queued: number; processing: number; elapsedMs: number | null }
}

// 「実行中」が続くturn を停滞として log に出す基準。HOOT の dispatch も含む main 会話の turn は
// 数分で終わるのが普通なので、5 分すぎたら人間が気づける証跡を残す
export const CHAT_STALL_WARN_MS = 5 * 60_000

export const CHAT_UNAVAILABLE_REPLY =
  '現在、Araya の会話機能を利用できません。管理者は discord.log を確認してください。'
const CHAT_ERROR_REPLY = '会話の処理に失敗しました。内容を短くして再度お試しください。'
// 終了時に打ち切った message。黙って捨てず、再起動後に読み直すことを伝える（#36 の取りこぼしを可視化する）
// cursor を進めていないので、restart 後の backfill が同じ message を取り直します（at-least-once）
export const CHAT_SHUTDOWN_UNPROCESSED_REPLY =
  '再起動のためこの message は今処理できませんでした。再起動後に自動的に読み直します。'

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

export function createDiscordChatHandler(deps: DiscordChatHandlerDependencies) {
  let accepting = true
  let tail = Promise.resolve()
  // 終了時に打ち切った message へ送る「未処理」返信。gateway を閉じる前に drain が待つ
  let shutdownNotices: Promise<void>[] = []
  // 受付済みで未開始の message。stop で実行中の submit とあわせて無効化する
  const queued: { message: DiscordChatMessage; reply: DiscordChatReply; cancelled: boolean }[] = []
  // 実行中の turn 数（status 表示用）
  let processing = 0
  // 実行中の turn が始まり、まだ終わっていない message id（stall log・status 表示共用）
  let processingMessageId: string | null = null
  let processingStartedAtMs: number | null = null
  // 停滞 log は turn ごとに 1 回だけ（5 秒おきの tick で log を埋めない）
  let stallLogged = false
  const nowMs = deps.nowMs ?? ((): number => Date.now())
  const control =
    deps.control ??
    createDiscordControlCommands({
      dataDir: deps.dataDir,
      nowMs,
      log: deps.log,
    })

  function sessionDescription() {
    try {
      return deps.session?.describe?.() ?? null
    } catch {
      return null
    }
  }

  // 実行中の turn が始まってからどれだけ経ったか（0 件なら null）
  function processingElapsedMs() {
    if (processingStartedAtMs === null) {
      return null
    }

    return Math.max(0, nowMs() - processingStartedAtMs)
  }

  // main 会話を待っている turn が CHAT_STALL_WARN_MS を超えたら 1 回だけ log に残す。
  // 2026-11-24 の 15h 停滞は「実行中 1 / 待ち 1」の数だけで、人間が `araya status` を見た時にしか
  // 経過時間が読めなかった（log には received / failed の間が何も無い）。経過時間を log 側にも出す
  function reportStall() {
    if (processing === 0 || stallLogged) {
      return
    }

    const elapsedMs = processingElapsedMs()

    if (elapsedMs === null || elapsedMs < CHAT_STALL_WARN_MS) {
      return
    }

    stallLogged = true
    deps.log({
      type: 'discord_chat_stalled',
      messageId: processingMessageId,
      elapsedMs,
      processing,
      queued: queued.length,
      conversationId: sessionDescription()?.conversationId ?? null,
    })
  }

  async function sendText(reply: DiscordChatReply, messageId: string, content: string) {
    const redacted = deps.redactor.redact(content)
    const { chunks, fenceReopens } = splitDiscordChatReplyWithFences(redacted)

    for (let index = 0; index < chunks.length; index += 1) {
      try {
        await reply(chunks[index] ?? '', discordChatReplyNonce(messageId, index))
      } catch (error) {
        deps.log({ type: 'discord_chat_reply_failed', messageId, errorName: errorName(error) })

        return
      }
    }

    // 複数 message に割れた境界の数値だけ残す（本文は出さない）。「code block が途中で切れた」報告の追跡用
    if (chunks.length > 1) {
      deps.log({
        type: 'discord_chat_reply_chunked',
        messageId,
        chunks: chunks.length,
        chars: codeLength(redacted),
        fenceReopens,
      })
    }
  }

  async function send(message: DiscordChatMessage, reply: DiscordChatReply, content: string) {
    await sendText(reply, message.messageId, content)
  }

  async function process(message: DiscordChatMessage, reply: DiscordChatReply) {
    const content = stripDiscordBotMention(message.content, deps.botUserId)

    if (content === '') {
      if (message.mentionsBot) {
        await send(message, reply, 'メッセージを入力してください。')
      } else {
        // mention なし空本文は会話にしない。取りこぼしと区別できるよう理由を残す
        deps.log({ type: 'discord_chat_ignored', messageId: message.messageId, reason: 'empty_content' })
      }

      return
    }

    if (deps.session === null) {
      await send(message, reply, CHAT_UNAVAILABLE_REPLY)

      return
    }

    processing += 1
    processingMessageId = message.messageId
    processingStartedAtMs = nowMs()
    stallLogged = false

    try {
      const answer = await deps.session.submit(
        `Discord user ${message.userId} said:\n${deps.redactor.redact(content)}`,
        message.messageId,
      )
      await send(message, reply, answer === '' ? '応答を生成できませんでした。' : answer)
    } catch (error) {
      deps.log({ type: 'discord_chat_turn_failed', messageId: message.messageId, errorName: errorName(error) })
      await send(message, reply, CHAT_ERROR_REPLY)
    } finally {
      processing -= 1

      if (processing === 0) {
        processingMessageId = null
        processingStartedAtMs = null
        stallLogged = false
      }
    }
  }

  // slash command は queue の外で処理する（会話の実行中・待ちでも常に効く制御系）。
  // send だけ差し替え可能にして、Discord の ephemeral reply と CLI の control request で同じ kernel を通す
  async function runCommand(request: DiscordCommandRequest, send: (text: string) => Promise<void>) {
    const cancelledCount = { value: 0 }
    const description = sessionDescription()

    await control.handle(request, {
      conversationId: description?.conversationId ?? null,
      runningCount: processing,
      runningElapsedMs: processingElapsedMs(),
      queuedCount: queued.length,
      sessionAvailable: deps.session !== null,
      progress: description?.progress ?? null,
      send,
      cancelQueued: () => {
        let cancelled = 0

        for (const item of queued) {
          if (!item.cancelled) {
            item.cancelled = true
            cancelled += 1
          }
        }

        cancelledCount.value = cancelled

        return cancelled
      },
      stopSession: async () => {
        if (deps.session === null) {
          return '会話 session が開いていないので、中止を要求できませんでした'
        }

        await deps.session.stop?.()

        return '実行中・実行待ちの作業があれば中止を要求しました'
      },
      resetSession: async (requestId) => {
        if (deps.session === null) {
          return '会話 session が開いていないので、リセットできませんでした'
        }

        await deps.session.reset(requestId)

        return 'この channel の会話をリセットしました'
      },
    })
  }

  return {
    // slash command の interaction。allowlist 検証と redaction は chat と同じ規則にする
    handleCommand: async (request: DiscordCommandRequest, reply: DiscordCommandReply) => {
      // allowlist 判定は message と同じ規則。拒否したときは落とした条件（guild / channel / user など）を
      // log に残して、事後に「どの境界で弾かれたか」特定できるようにする。
      // log に載せるのは IDs と拒否理由だけで、command の option 値・ユーザー入力・token は載せない
      const failures = discordChatAdmissionFailures(
        {
          guildId: request.guildId,
          channelId: request.channelId ?? '',
          userId: request.userId,
          isBot: false,
          isWebhook: false,
          isSystem: false,
          mentionsBot: false,
        },
        deps.config,
      )

      if (failures.length > 0) {
        deps.log({
          type: 'discord_command_denied',
          commandName: request.commandName,
          userId: request.userId,
          guildId: request.guildId,
          // interaction に channel が無い場合（DM など）は null のまま出す（空文字で channel を pseudo 化しない）
          channelId: request.channelId,
          failures,
        })

        try {
          await reply('この command を使える channel / user ではありません。')
        } catch {
          // 応答を送れない状況では何もしない（log 済み）
        }

        return
      }

      // 応答は ephemeral（command を打った人だけに見える）。長い output は 2000 字で切って followUp する
      const operation = runCommand(request, async (text) => {
        for (const chunk of splitDiscordChatReply(deps.redactor.redact(text))) {
          try {
            await reply(chunk)
          } catch (error) {
            deps.log({ type: 'discord_command_reply_failed', errorName: errorName(error) })

            return
          }
        }
      }).catch((error: unknown) => {
        deps.log({ type: 'discord_control_failed', message: errorName(error) })

        return reply('command を処理できませんでした。/araya help で一覧を見られます。').catch(() => undefined)
      })
      // shutdown の drain が command の最中も待つ（stop / reset の途中で process を切らない）
      tail = tail.then(async () => {
        await operation
      })

      await operation
    },
    // CLI の `araya status・stop・reset`（src/infrastructure/control-bus.ts の request）を slash command と
    // 同じ operation で走らせる。Discord へは送らず、ephemeral reply と同じ規則で redact した text を返す
    runControl: async (request: DiscordCommandRequest) => {
      const chunks: string[] = []
      // slash command と同じで queue を通さない（会話の実行中でも止める／リセットできる）
      const operation = runCommand(request, async (text) => {
        chunks.push(deps.redactor.redact(text))
      })
        .catch((error: unknown) => {
          deps.log({ type: 'discord_control_failed', message: errorName(error) })

          return chunks.push('command を処理できませんでした。araya --help か /araya help で一覧を見られます。')
        })

      await operation

      return chunks.join('\n')
    },
    handle: (message: DiscordChatMessage, reply: DiscordChatReply) => {
      if (!accepting) {
        // 停止中に到着した message。IDs だけ記録して本文は残さない
        deps.log({ type: 'discord_chat_ignored', messageId: message.messageId, reason: 'not_accepting' })

        return Promise.resolve()
      }

      const failures = discordChatAdmissionFailures(message, deps.config)

      if (failures.length > 0) {
        deps.log({ type: 'discord_chat_ignored', messageId: message.messageId, failures })

        return Promise.resolve()
      }

      // handler に到達した証跡。Discord 側の受信欠落と handler 後の破棄を切り分ける
      deps.log({ type: 'discord_chat_received', messageId: message.messageId, mentionsBot: message.mentionsBot })

      const content = stripDiscordBotMention(message.content, deps.botUserId)

      const item: (typeof queued)[number] = { message, reply, cancelled: false }
      queued.push(item)
      const operation = tail.then(async () => {
        const index = queued.indexOf(item)

        if (index !== -1) {
          queued.splice(index, 1)
        }

        if (item.cancelled) {
          deps.log({ type: 'discord_chat_queued_cancelled', messageId: item.message.messageId })

          return
        }

        await process(message, reply)
      })
      tail = operation.catch(() => {})

      return operation
    },
    // HOOT の承認済み dispatch を main 会話へ submit し、notice と answer を Discord に返す。
    // 人間の message と tail で直列化するので、stop の queue cancel とは別に扱う（承認済みの案件は消さない）
    inject: async (injection: DiscordChatInjection, reply: DiscordChatReply) => {
      if (!accepting) {
        throw new Error('hoot_inject_unavailable: chat handler が停止中です')
      }

      if (deps.session === null) {
        throw new Error('hoot_inject_unavailable: Discord chat session がありません')
      }

      // requestId（dedupe key）は attempt を含まない。同じ案件の再試行では Pi durable が記録済みの
      // answer を返すだけなので、notice / answer の nonce も attempt なしで送る（crash 後の再試行で
      // channel に同じ 1 文・同じ answer を 2 度流さない）
      const noticeId = `${injection.requestId}:notice`
      const answerId = `${injection.requestId}:answer`
      const operation = tail.then(async () => {
        if (!accepting || deps.session === null) {
          throw new Error('hoot_inject_unavailable: chat session を使えません')
        }

        deps.log({
          type: 'discord_hoot_inject',
          requestId: injection.requestId,
          contentChars: injection.content.length,
        })
        // inject も main 会話の turn なので、人間の message と同じ基準で経過時間を見る
        processing += 1
        processingMessageId = injection.requestId
        processingStartedAtMs = nowMs()
        stallLogged = false

        try {
          // state に残った text（model・gh 由来）を main 会話に渡す前に秘密を置き換える
          const answer = await deps.session.submit(deps.redactor.redact(injection.content), injection.requestId)

          // notice と answer は別の messageId で送る（同じ messageId / chunk index だと reply nonce が重複して
          // gateway の dedupe で answer が落ちる）
          await sendText(reply, noticeId, injection.notice)
          await sendText(reply, answerId, answer === '' ? '応答を生成できませんでした。' : answer)

          return answer
        } finally {
          processing -= 1

          if (processing === 0) {
            processingMessageId = null
            processingStartedAtMs = null
            stallLogged = false
          }
        }
      })
      // inject が失敗しても queue は止めない（tail は void を返す連鎖なので result は捨ててつなぐ）
      tail = operation.then(
        () => undefined,
        () => undefined
      )

      return operation
    },
    stopAccepting: () => {
      accepting = false

      for (const item of queued) {
        if (item.cancelled) {
          continue
        }

        item.cancelled = true
        // 実行待ちを shutdown の終了 budget の外で処理させない。代わりに gateway がまだ生きているうちに
        // 「処理できなかった」を伝えて、取りこぼさを黙らせない
        shutdownNotices.push(
          sendText(item.reply, item.message.messageId, CHAT_SHUTDOWN_UNPROCESSED_REPLY)
        )
      }
    },
    drain: async () => {
      await tail

      for (const notice of shutdownNotices) {
        await notice.catch(() => undefined)
      }
    },
    // 定期 tick（bot の poll loop から呼ぶ）。実行中の turn が CHAT_STALL_WARN_MS を超えて続いているかを
    // log に出す。会話の完了を待たずに検知するので、status を開いていない停滞もここに記録が残る
    tick: () => {
      reportStall()
    },
    pendingCount: () => {
      return { queued: queued.length, processing, elapsedMs: processingElapsedMs() }
    },
  }
}
