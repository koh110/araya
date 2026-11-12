import { createHash } from 'node:crypto'
import type { Redactor } from '../infrastructure/redaction.ts'
import type { DiscordConfig } from './config.ts'

export type DiscordChatMessageMetadata = {
  guildId: string | null
  channelId: string
  userId: string
  isBot: boolean
  isWebhook: boolean
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

export function isDiscordChatMessageAllowed(
  message: DiscordChatMessageMetadata,
  config: DiscordConfig,
) {
  return (
    message.guildId === config.guildId &&
    message.channelId === config.channelId &&
    config.allowedUserIds.includes(message.userId) &&
    !message.isBot &&
    !message.isWebhook &&
    message.mentionsBot
  )
}

export type DiscordChatSession = {
  submit(content: string, requestId: string): Promise<string>
  reset(requestId: string): Promise<void>
  close?(): Promise<void>
}

export type DiscordChatReply = (content: string, nonce: string) => Promise<void>

export type DiscordChatHandlerDependencies = {
  config: DiscordConfig
  botUserId: string
  session: DiscordChatSession | null
  redactor: Redactor
  log(entry: Record<string, unknown>): void
}

export type DiscordChatHandler = {
  handle(message: DiscordChatMessage, reply: DiscordChatReply): Promise<void>
  stopAccepting(): void
  drain(): Promise<void>
}

const CHAT_UNAVAILABLE_REPLY =
  '現在、Araya の会話機能を利用できません。管理者は discord.log を確認してください。'
const CHAT_ERROR_REPLY = '会話の処理に失敗しました。内容を短くして再度お試しください。'

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

export function createDiscordChatHandler(deps: DiscordChatHandlerDependencies) {
  let accepting = true
  let tail = Promise.resolve()

  async function send(message: DiscordChatMessage, reply: DiscordChatReply, content: string) {
    const chunks = splitDiscordChatReply(deps.redactor.redact(content))

    for (let index = 0; index < chunks.length; index += 1) {
      try {
        await reply(chunks[index] ?? '', discordChatReplyNonce(message.messageId, index))
      } catch (error) {
        deps.log({ type: 'discord_chat_reply_failed', errorName: errorName(error) })

        return
      }
    }
  }

  async function process(message: DiscordChatMessage, reply: DiscordChatReply) {
    if (deps.session === null) {
      await send(message, reply, CHAT_UNAVAILABLE_REPLY)

      return
    }

    const content = stripDiscordBotMention(message.content, deps.botUserId)

    if (content === '') {
      await send(message, reply, 'メンションの後にメッセージを入力してください。')

      return
    }

    try {
      if (/^reset$/iu.test(content)) {
        await deps.session.reset(message.messageId)
        await send(message, reply, 'この channel の会話をリセットしました')

        return
      }

      const answer = await deps.session.submit(
        `Discord user ${message.userId} said:\n${deps.redactor.redact(content)}`,
        message.messageId,
      )
      await send(message, reply, answer === '' ? '応答を生成できませんでした。' : answer)
    } catch (error) {
      deps.log({ type: 'discord_chat_turn_failed', errorName: errorName(error) })
      await send(message, reply, CHAT_ERROR_REPLY)
    }
  }

  return {
    handle: (message: DiscordChatMessage, reply: DiscordChatReply) => {
      if (!accepting || !isDiscordChatMessageAllowed(message, deps.config)) {
        return Promise.resolve()
      }

      const operation = tail.then(async () => {
        await process(message, reply)
      })
      tail = operation.catch(() => {})

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
