import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDiscordChatHandler,
  discordChatReplyNonce,
  isDiscordChatMessageAllowed,
  splitDiscordChatReply,
  stripDiscordBotMention,
  type DiscordChatMessageMetadata,
} from '../src/discord/chat.ts'
import { createRedactor } from '../src/infrastructure/redaction.ts'
import type { DiscordConfig } from '../src/discord/config.ts'

const config: DiscordConfig = {
  botToken: 'synthetic-token',
  applicationId: '12345678901234567',
  guildId: '22345678901234567',
  channelId: '32345678901234567',
  allowedUserIds: ['42345678901234567'],
}

const message: DiscordChatMessageMetadata = {
  guildId: config.guildId,
  channelId: config.channelId,
  userId: '42345678901234567',
  isBot: false,
  isWebhook: false,
  mentionsBot: true,
}

test('discord chat: 設定 guild/channel の許可 user が bot を mention したときだけ受け付ける', () => {
  assert.equal(isDiscordChatMessageAllowed(message, config), true)
  assert.equal(isDiscordChatMessageAllowed({ ...message, guildId: null }, config), false)
  assert.equal(
    isDiscordChatMessageAllowed({ ...message, guildId: '52345678901234567' }, config),
    false,
  )
  assert.equal(
    isDiscordChatMessageAllowed({ ...message, channelId: '62345678901234567' }, config),
    false,
  )
  assert.equal(
    isDiscordChatMessageAllowed({ ...message, userId: '72345678901234567' }, config),
    false,
  )
  assert.equal(isDiscordChatMessageAllowed({ ...message, isBot: true }, config), false)
  assert.equal(isDiscordChatMessageAllowed({ ...message, isWebhook: true }, config), false)
  assert.equal(isDiscordChatMessageAllowed({ ...message, mentionsBot: false }, config), false)
})

test('discord chat: bot mention を本文から除き、他の user mention は残す', () => {
  assert.equal(
    stripDiscordBotMention(
      '<@12345678901234567> こんにちは <@!12345678901234567>',
      '12345678901234567',
    ),
    'こんにちは',
  )
  assert.equal(
    stripDiscordBotMention('<@12345678901234567> hi <@72345678901234567>', '12345678901234567'),
    'hi <@72345678901234567>',
  )
})

test('discord chat: reply を Discord の上限より短く分割し、surrogate pair を切らない', () => {
  assert.deepEqual(splitDiscordChatReply('one two three', 7), ['one two', 'three'])
  assert.deepEqual(splitDiscordChatReply('ab🙂cd', 4), ['ab🙂', 'cd'])
  assert.ok(
    splitDiscordChatReply('a'.repeat(4001)).every((chunk) => {
      return chunk.length <= 1900
    }),
  )
})

test('discord chat: reply nonce は同じ message/chunk で安定し、25文字以内', () => {
  assert.equal(
    discordChatReplyNonce('123456789012345678', 0),
    discordChatReplyNonce('123456789012345678', 0),
  )
  assert.notEqual(
    discordChatReplyNonce('123456789012345678', 0),
    discordChatReplyNonce('123456789012345678', 1),
  )
  assert.ok(discordChatReplyNonce('123456789012345678', 0).length <= 25)
})

test('discord chat: 許可 message は mention を外して redaction 後に同じ message ID で submit する', async () => {
  const submitted: { content: string; requestId: string }[] = []
  const replies: { content: string; nonce: string }[] = []
  await createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    redactor: createRedactor(['secret-token']),
    session: {
      submit: async (content, requestId) => {
        submitted.push({ content, requestId })

        return '回答 secret-tokenです'
      },
      reset: async () => {},
    },
    log: () => {},
  }).handle(
    {
      ...message,
      messageId: '82345678901234567',
      content: '<@12345678901234567> secret-tokenを確認して',
    },
    async (content, nonce) => {
      replies.push({ content, nonce })
    },
  )

  assert.deepEqual(submitted, [
    {
      content: `Discord user ${message.userId} said:\n[REDACTED]を確認して`,
      requestId: '82345678901234567',
    },
  ])
  assert.deepEqual(
    replies.map(({ content }) => {
      return content
    }),
    ['回答 [REDACTED]です'],
  )
  assert.ok(replies[0]?.nonce.startsWith('araya-'))
})

test('discord chat: reset command は Pi session を reset し model には送らない', async () => {
  const resetRequestIds: Array<string | undefined> = []
  let submitCount = 0
  const replies: string[] = []
  await createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        submitCount += 1

        return 'unexpected'
      },
      reset: async (requestId?: string) => {
        resetRequestIds.push(requestId)
      },
    },
    log: () => {},
  }).handle(
    { ...message, messageId: '92345678901234567', content: '<@12345678901234567> reset' },
    async (content) => {
      replies.push(content)
    },
  )

  assert.deepEqual(resetRequestIds, ['92345678901234567'])
  assert.equal(submitCount, 0)
  assert.deepEqual(replies, ['この channel の会話をリセットしました'])
})

test('discord chat: 会話ターンは到着順に直列化する', async () => {
  const started: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        started.push(content.includes('first') ? 'first' : 'second')

        if (started.length === 1) {
          await firstGate
        }

        return 'ok'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  async function reply() {}

  const firstTurn = handler.handle(
    { ...message, messageId: 'a', content: '<@12345678901234567> first' },
    reply,
  )
  const secondTurn = handler.handle(
    { ...message, messageId: 'b', content: '<@12345678901234567> second' },
    reply,
  )

  await Promise.resolve()
  assert.deepEqual(started, ['first'])
  if (releaseFirst === undefined) {
    throw new Error('first turn gate was not initialized')
  }

  releaseFirst()
  await Promise.all([firstTurn, secondTurn])
  assert.deepEqual(started, ['first', 'second'])
})

test('discord chat: stopAccepting は受付を止めても進行中のturnをdrainする', async () => {
  let releaseFirst: (() => void) | undefined
  let signalFirstStarted: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve
  })
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const submitted: string[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)
        signalFirstStarted?.()
        await firstGate

        return 'first reply'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  const firstTurn = handler.handle(
    { ...message, messageId: 'stop-first', content: '<@12345678901234567> first' },
    async (content) => {
      replies.push(content)
    },
  )
  await firstStarted
  handler.stopAccepting()
  await handler.handle(
    { ...message, messageId: 'stop-second', content: '<@12345678901234567> second' },
    async (content) => {
      replies.push(content)
    },
  )
  releaseFirst?.()
  await firstTurn
  await handler.drain()

  assert.equal(submitted.length, 1)
  assert.deepEqual(replies, ['first reply'])
})
