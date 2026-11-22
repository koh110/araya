import { createHash } from 'node:crypto'
import type { Redactor } from '../infrastructure/redaction.ts'
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

export function splitDiscordChatReply(content: string, maxChars = 1900) {
  const trimmed = content.trim()

  if (trimmed === '') {
    return []
  }

  const limit = Math.max(1, Math.floor(maxChars))
  const characters = Array.from(trimmed)
  const chunks: string[] = []
  let start = 0

  while (start < characters.length) {
    let end = start
    let length = 0

    while (end < characters.length) {
      const nextLength = characters[end]?.length ?? 0

      if (length + nextLength > limit) {
        break
      }

      length += nextLength
      end += 1
    }

    if (end === characters.length) {
      chunks.push(characters.slice(start).join(''))
      break
    }

    // 上限ちょうどの後が空白なら単語を分けずにそのまま切る。
    let breakAt = characters[end]?.trim() === '' ? end : -1

    if (breakAt < 0) {
      for (let index = end - 1; index > start; index -= 1) {
        if (characters[index]?.trim() === '') {
          breakAt = index
          break
        }
      }
    }

    if (breakAt > start) {
      chunks.push(characters.slice(start, breakAt).join('').trimEnd())
      start = breakAt

      while (characters[start]?.trim() === '') {
        start += 1
      }
    } else {
      chunks.push(characters.slice(start, end).join(''))
      start = end
    }
  }

  return chunks.filter((chunk) => {
    return chunk !== ''
  })
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
  describe?(): { conversationId: number | null }
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
  inject(injection: DiscordChatInjection, reply: DiscordChatReply): Promise<string>
  stopAccepting(): void
  drain(): Promise<void>
}

export const CHAT_UNAVAILABLE_REPLY =
  '現在、Araya の会話機能を利用できません。管理者は discord.log を確認してください。'
const CHAT_ERROR_REPLY = '会話の処理に失敗しました。内容を短くして再度お試しください。'

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

export function createDiscordChatHandler(deps: DiscordChatHandlerDependencies) {
  let accepting = true
  let tail = Promise.resolve()
  // 受付済みで未開始の message。stop で実行中の submit とあわせて無効化する
  const queued: { message: DiscordChatMessage; reply: DiscordChatReply; cancelled: boolean }[] = []
  // 実行中の turn 数（status 表示用）
  let processing = 0
  const control =
    deps.control ??
    createDiscordControlCommands({
      dataDir: deps.dataDir,
      nowMs: deps.nowMs ?? ((): number => Date.now()),
      log: deps.log,
    })

  function conversationIdOf() {
    try {
      return deps.session?.describe?.().conversationId ?? null
    } catch {
      return null
    }
  }

  async function sendText(reply: DiscordChatReply, messageId: string, content: string) {
    const chunks = splitDiscordChatReply(deps.redactor.redact(content))

    for (let index = 0; index < chunks.length; index += 1) {
      try {
        await reply(chunks[index] ?? '', discordChatReplyNonce(messageId, index))
      } catch (error) {
        deps.log({ type: 'discord_chat_reply_failed', messageId, errorName: errorName(error) })

        return
      }
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
    }
  }

  // slash command は queue の外で処理する（会話の実行中・待ちでも常に効く制御系）
  async function processCommand(request: DiscordCommandRequest, reply: DiscordCommandReply) {
    const cancelledCount = { value: 0 }
    // 応答は ephemeral（command を打った人だけに見える）。長い output は 2000 字で切って followUp する
    const send = async (text: string) => {
      for (const chunk of splitDiscordChatReply(deps.redactor.redact(text))) {
        try {
          await reply(chunk)
        } catch (error) {
          deps.log({ type: 'discord_command_reply_failed', errorName: errorName(error) })

          return
        }
      }
    }

    await control.handle(request, {
      conversationId: conversationIdOf(),
      runningCount: processing,
      queuedCount: queued.length,
      sessionAvailable: deps.session !== null,
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
      const allowed = isDiscordChatMessageAllowed(
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

      if (!allowed) {
        deps.log({ type: 'discord_command_denied', commandName: request.commandName, userId: request.userId })

        try {
          await reply('この command を使える channel / user ではありません。')
        } catch {
          // 応答を送れない状況では何もしない（log 済み）
        }

        return
      }

      const operation = processCommand(request, reply).catch((error: unknown) => {
        deps.log({ type: 'discord_control_failed', message: errorName(error) })

        return reply('command を処理できませんでした。/araya help で一覧を見られます。').catch(() => undefined)
      })
      // shutdown の drain が command の最中も待つ（stop / reset の途中で process を切らない）
      tail = tail.then(async () => {
        await operation
      })

      await operation
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
        // state に残った text（model・gh 由来）を main 会話に渡す前に秘密を置き換える
        const answer = await deps.session.submit(deps.redactor.redact(injection.content), injection.requestId)

        // notice と answer は別の messageId で送る（同じ messageId / chunk index だと reply nonce が重複して
        // gateway の dedupe で answer が落ちる）
        await sendText(reply, noticeId, injection.notice)
        await sendText(reply, answerId, answer === '' ? '応答を生成できませんでした。' : answer)

        return answer
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
    },
    drain: async () => {
      await tail
    },
  }
}
