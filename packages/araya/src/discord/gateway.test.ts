import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vite-plus/test'

import { MessageFlags } from 'discord.js'

import {
  createDiscordTypingIndicator,
  discordGatewayIntents,
  discordNotificationPayload,
  flattenDiscordCommandOptions,
  handleDiscordMessageCreate,
  OBSOLETE_COMMAND_REPLY,
  wireSlashCommandInteractions,
  type DiscordGatewayHandlers,
  type DiscordMessageCreateEvent,
  type DiscordTypingChannel,
} from './gateway.ts'
import { discordChatReplyNonce, type DiscordChatMessage, type DiscordChatMessageMetadata } from './chat.ts'
import type { DiscordConfig } from './config.ts'

afterEach(() => {
  vi.useRealTimers()
})

test('discord gateway: nonce payload は enforce_nonce を有効にする', () => {
  assert.deepEqual(discordNotificationPayload('Task update', 'nonce-1'), {
    content: 'Task update',
    nonce: 'nonce-1',
    enforceNonce: true,
    allowedMentions: { parse: [] },
  })
})

test('discord gateway: mention なしの会話は Message Content privileged intent を使う', () => {
  assert.deepEqual(
    discordGatewayIntents({ Guilds: 1, GuildMessages: 512, MessageContent: 32768 }),
    [1, 512, 32768],
  )
})

test('discord gateway: nested task group options reach the retry handler as leaf values', () => {
  assert.deepEqual(
    flattenDiscordCommandOptions([
      {
        type: 2,
        name: 'task',
        options: [
          {
            type: 1,
            name: 'retry',
            options: [
              { type: 4, name: 'task', value: 17 },
              { type: 3, name: 'note', value: '続きから' },
              { type: 5, name: 'confirm_side_effects', value: true },
            ],
          },
        ],
      },
    ]),
    {
      task: 17,
      note: '続きから',
      confirm_side_effects: true,
    },
  )
})

test('discord gateway: typing indicator is refreshed while any accepted response is pending', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let refreshes = 0
  const errors: string[] = []
  const channel = {
    sendTyping: async () => {
      refreshes += 1
    },
  }
  const indicator = createDiscordTypingIndicator((message) => {
    errors.push(message)
  })
  let releaseFirst: (() => void) | undefined
  let releaseSecond: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })

  const pending = [
    indicator.run(channel, async () => {
      await firstGate
    }),
    indicator.run(channel, async () => {
      await secondGate
    }),
  ]
  await Promise.resolve()
  assert.equal(refreshes, 1)

  await vi.advanceTimersByTimeAsync(8_000)
  await Promise.resolve()
  assert.equal(refreshes, 2)

  releaseFirst?.()
  await pending[0]
  await vi.advanceTimersByTimeAsync(8_000)
  await Promise.resolve()
  assert.equal(refreshes, 3)

  releaseSecond?.()
  await pending[1]
  await vi.advanceTimersByTimeAsync(16_000)
  assert.equal(refreshes, 3)
  indicator.close()
  assert.deepEqual(errors, [])
})

test('discord gateway: a missed refresh is sent when the current typing request settles', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let refreshes = 0
  let releaseFirstSend: (() => void) | undefined
  const firstSend = new Promise<void>((resolve) => {
    releaseFirstSend = resolve
  })
  let releaseOperation: (() => void) | undefined
  const operation = new Promise<void>((resolve) => {
    releaseOperation = resolve
  })
  const indicator = createDiscordTypingIndicator(() => {})
  const pending = indicator.run(
    {
      sendTyping: async () => {
        refreshes += 1

        if (refreshes === 1) {
          await firstSend
        }
      },
    },
    async () => {
      await operation
    },
  )
  assert.equal(typeof pending.then, 'function')
  await Promise.resolve()
  assert.equal(refreshes, 1)

  await vi.advanceTimersByTimeAsync(8_000)
  assert.equal(refreshes, 1)
  await vi.advanceTimersByTimeAsync(1_000)
  releaseFirstSend?.()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(refreshes, 2)

  await vi.advanceTimersByTimeAsync(7_000)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(refreshes, 3)

  releaseOperation?.()
  await pending
  await vi.advanceTimersByTimeAsync(16_000)
  assert.equal(refreshes, 3)
  indicator.close()
})

test('discord gateway: typing failure does not fail the chat response', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const errors: string[] = []
  const indicator = createDiscordTypingIndicator((message) => {
    errors.push(message)
  })
  assert.equal(
    await indicator.run(
      {
        sendTyping: async () => {
          throw new Error('missing permission')
        },
      },
      async () => {
        return 'chat response'
      },
    ),
    'chat response',
  )
  await Promise.resolve()

  assert.deepEqual(errors, ['Discord typing indicator failed: missing permission'])
  indicator.close()
})

test('discord gateway: typing heartbeat stops when a response rejects', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let refreshes = 0
  const indicator = createDiscordTypingIndicator(() => {})
  await assert.rejects(
    indicator.run(
      {
        sendTyping: async () => {
          refreshes += 1
        },
      },
      async () => {
        throw new Error('chat response failed')
      },
    ),
    /chat response failed/u,
  )

  await vi.advanceTimersByTimeAsync(16_000)
  assert.equal(refreshes, 1)
  indicator.close()
})

test('discord gateway: closing the typing indicator stops an active heartbeat', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let refreshes = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const indicator = createDiscordTypingIndicator(() => {})
  const pending = [
    indicator.run(
      {
        sendTyping: async () => {
          refreshes += 1
        },
      },
      async () => {
        await gate
      },
    ),
  ]
  assert.equal(typeof pending[0]?.then, 'function')
  await Promise.resolve()
  assert.equal(refreshes, 1)

  indicator.close()
  await vi.advanceTimersByTimeAsync(16_000)
  assert.equal(refreshes, 1)

  release?.()
  await pending[0]
})

type FakeCommandReply = { content: string; flags: number | undefined }

function makeFakeSlashCommandInteraction(options: {
  commandName: string
  subcommand: string
  leafOptions: { name: string; value: string | number }[]
}) {
  const replies: FakeCommandReply[] = []
  let resolveReply: () => void
  const replied = new Promise<void>((resolve) => {
    resolveReply = resolve
  })

  function capture(payload: { content: string; flags?: number }) {
    replies.push({ content: payload.content, flags: payload.flags })
    resolveReply()
  }

  return {
    replies,
    replied,
    interaction: {
      isChatInputCommand: () => true,
      commandName: options.commandName,
      id: 'interaction-1',
      user: { id: 'user-1' },
      guildId: 'guild-1',
      channelId: 'channel-1',
      options: {
        data: options.leafOptions.map((entry) => ({ type: 3, ...entry })),
        getSubcommandGroup: (required = true) => {
          if (required) {
            throw new Error('subcommand group が無い interaction')
          }

          return null
        },
        getSubcommand: () => options.subcommand,
      },
      reply: async (payload: { content: string; flags?: number }) => {
        capture(payload)
      },
      followUp: async (payload: { content: string; flags?: number }) => {
        capture(payload)
      },
    },
  }
}

test('discord gateway: interactionCreate 配線は撤去済み command に ephemeral の撤去案内を返し option 値を混ぜない', async () => {
  let interactionListener: ((interaction: never) => void) | undefined

  const client = {
    on(event: 'interactionCreate', listener: (interaction: never) => void) {
      assert.equal(event, 'interactionCreate')
      interactionListener = listener
    },
  }
  const errors: string[] = []

  wireSlashCommandInteractions(
    client as unknown as Parameters<typeof wireSlashCommandInteractions>[0],
    {
      onReady: () => {},
      onMessage: () => {},
      onError: (message: string) => {
        errors.push(message)
      },
    },
  )
  assert.ok(
    interactionListener !== undefined,
    'wireSlashCommandInteractions は client.on("interactionCreate") を配線する',
  )

  const removed = makeFakeSlashCommandInteraction({
    commandName: 'araya',
    subcommand: 'retry',
    leafOptions: [{ name: 'task', value: 17 }],
  })
  const otherCommand = makeFakeSlashCommandInteraction({
    commandName: 'other',
    subcommand: 'submit',
    leafOptions: [],
  })

  interactionListener?.(removed.interaction as never)
  await removed.replied
  interactionListener?.(otherCommand.interaction as never)
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })

  assert.deepEqual(removed.replies, [
    { content: OBSOLETE_COMMAND_REPLY, flags: MessageFlags.Ephemeral },
  ])
  assert.equal(removed.replies[0]?.content.includes('17'), false)
  assert.deepEqual(otherCommand.replies, [])
  assert.deepEqual(errors, [])
})

const gatewayConfig: DiscordConfig = {
  botToken: 'synthetic-token',
  applicationId: '12345678901234567',
  guildId: '22345678901234567',
  channelId: '32345678901234567',
  allowedUserIds: ['42345678901234567'],
}

function makeFakeMessageCreate(options: {
  id: string
  channelId?: string
  userId?: string
  isBot?: boolean
  isSystem?: boolean
  content?: string
}): DiscordMessageCreateEvent {
  return {
    id: options.id,
    guildId: gatewayConfig.guildId,
    channelId: options.channelId ?? gatewayConfig.channelId,
    author: { id: options.userId ?? '42345678901234567', bot: options.isBot ?? false },
    webhookId: null,
    system: options.isSystem ?? false,
    mentions: { users: { has: () => false } },
    content: options.content ?? 'hello',
    inGuild: () => true,
    channel: {
      isTextBased: () => true,
      sendTyping: async () => {},
    },
    reply: async () => ({}),
  }
}

const fakeTypingIndicator = {
  run: async <T>(_target: DiscordTypingChannel, operation: () => Promise<T> | T): Promise<T> => {
    return await operation()
  },
  close: () => {},
}

function makeGatewayHandlerCapture() {
  const messages: DiscordChatMessage[] = []
  const ignored: {
    metadata: DiscordChatMessageMetadata & { messageId: string }
    failures: string[]
  }[] = []
  const errors: string[] = []
  const handlers: DiscordGatewayHandlers = {
    onReady: () => {},
    onMessage: (message) => {
      messages.push(message)
    },
    onError: (message) => {
      errors.push(message)
    },
    onIgnored: (metadata, failures) => {
      ignored.push({ metadata, failures })
    },
  }

  return { messages, ignored, errors, handlers }
}

test('discord gateway: 許可条件に落ちる message は onIgnored に messageId と failures を渡し本文を渡さない', () => {
  const capture = makeGatewayHandlerCapture()
  const message = makeFakeMessageCreate({
    id: '92345678901234611',
    channelId: '62345678901234567',
    content: '別 channel の投稿',
  })

  handleDiscordMessageCreate(
    message,
    gatewayConfig,
    capture.handlers,
    fakeTypingIndicator,
    '12345678901234567',
  )

  assert.equal(capture.ignored.length, 1)
  assert.equal(capture.ignored[0]?.metadata.messageId, '92345678901234611')
  assert.equal(capture.ignored[0]?.metadata.channelId, '62345678901234567')
  assert.deepEqual(capture.ignored[0]?.failures, ['channel_mismatch'])
  assert.deepEqual(capture.messages, [])
  assert.equal(JSON.stringify(capture.ignored).includes('別 channel の投稿'), false)
})

test('discord gateway: 許可された message は onMessage に渡り onIgnored を呼ばない', () => {
  const capture = makeGatewayHandlerCapture()
  const message = makeFakeMessageCreate({ id: '92345678901234612', content: 'hello' })

  handleDiscordMessageCreate(
    message,
    gatewayConfig,
    capture.handlers,
    fakeTypingIndicator,
    '12345678901234567',
  )

  assert.deepEqual(capture.ignored, [])
  assert.equal(capture.messages.length, 1)
  assert.equal(capture.messages[0]?.messageId, '92345678901234612')
  assert.equal(capture.messages[0]?.content, 'hello')
  assert.equal(capture.messages[0]?.mentionsBot, false)
})

test('discord gateway: bot 自身の message echo は onMessage に渡さず is_bot 理由で onIgnored に記録する（M1）', () => {
  const capture = makeGatewayHandlerCapture()
  const message = makeFakeMessageCreate({
    id: '92345678901234613',
    userId: '12345678901234567',
    isBot: true,
    content: 'Araya の返信 echo',
  })

  handleDiscordMessageCreate(
    message,
    gatewayConfig,
    capture.handlers,
    fakeTypingIndicator,
    '12345678901234567',
  )

  assert.deepEqual(capture.messages, [])
  assert.equal(capture.ignored.length, 1)
  assert.equal(capture.ignored[0]?.metadata.messageId, '92345678901234613')
  assert.deepEqual(capture.ignored[0]?.failures, ['is_bot'])
  assert.equal(JSON.stringify(capture.ignored).includes('Araya の返信 echo'), false)
})

test('discord gateway: Araya 自身の user id の message（bot flag なし）は self_message 理由で onIgnored に記録する（M1）', () => {
  const capture = makeGatewayHandlerCapture()
  const message = makeFakeMessageCreate({ id: '92345678901234614', userId: '42345678901234567' })

  handleDiscordMessageCreate(
    message,
    gatewayConfig,
    capture.handlers,
    fakeTypingIndicator,
    '42345678901234567',
  )

  assert.deepEqual(capture.messages, [])
  assert.equal(capture.ignored.length, 1)
  assert.deepEqual(capture.ignored[0]?.failures, ['self_message'])
})

test('discord gateway: onIgnored を持たない handlers でも許可外 message で throw しない', () => {
  const errors: string[] = []

  handleDiscordMessageCreate(
    makeFakeMessageCreate({ id: '92345678901234615', userId: '72345678901234567' }),
    gatewayConfig,
    {
      onReady: () => {},
      onMessage: () => {},
      onError: (message) => {
        errors.push(message)
      },
    },
    fakeTypingIndicator,
    '12345678901234567',
  )
  assert.deepEqual(errors, [])
})

test('discord gateway: onMessage の失敗は onError に message を渡す', async () => {
  const errors: string[] = []
  const handlers: DiscordGatewayHandlers = {
    onReady: () => {},
    onMessage: () => {
      throw new Error('model submit failed')
    },
    onError: (message) => {
      errors.push(message)
    },
  }

  handleDiscordMessageCreate(
    makeFakeMessageCreate({ id: '92345678901234616' }),
    gatewayConfig,
    handlers,
    fakeTypingIndicator,
    '12345678901234567',
  )
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })
  assert.deepEqual(errors, ['model submit failed'])
})

// #36 の restart 取り直しで、live の応答と取り直しの応答が channel 上で寄らないための nonce 設計を固定する。
// vendored 実装の計測（この test の前提）:
// - gateway.ts の discordNotificationPayload は nonce と enforceNonce: true を message.reply / channel.send
//   の payload に載せる（上の「nonce payload は enforce_nonce を有効にする」で測っている）
// - discord.js 14.27.0 は options.enforceNonce を body の enforce_nonce に変換し nonce と一緒に送る
//   （node_modules/discord.js/src/structures/MessagePayload.js:137, :258-259）
// - discord-api-types の docs は enforce_nonce を "checked for uniqueness in the past few minutes"、
//   同じ author + 同じ nonce の message があれば "no new message will be created"（既存を返す）と定義する
//   （node_modules/discord-api-types/rest/v10/channel.d.ts:325-327）
// Discord 側の動作は live の service を触らずには測れないので、docs の rule を model して固定する。
// window の精確な値は docs に書かれていないので windowMs は test の parameter とし、
// 「数分以内の再送は 1 通 / 数分以上離れると別の message」という定性だけ固定する
type NonceSend = { nonce: string; atMs: number }

function modelDiscordNonceDedupe(sends: NonceSend[], windowMs: number) {
  const lastAcceptedAt = new Map<string, number>()
  let createdMessages = 0
  let collapsedSends = 0

  for (const send of sends) {
    const previous = lastAcceptedAt.get(send.nonce)

    if (previous !== undefined && send.atMs - previous <= windowMs) {
      collapsedSends += 1

      continue
    }

    createdMessages += 1
    lastAcceptedAt.set(send.nonce, send.atMs)
  }

  return { createdMessages, collapsedSends }
}

function makeCapturingFakeMessageCreate(options: { id: string; content?: string }) {
  const payloads: { content: string; nonce?: string; enforceNonce?: boolean }[] = []
  const event = {
    ...makeFakeMessageCreate(options),
    reply: async (payload: string | { content?: string; nonce?: string; enforceNonce?: boolean }) => {
      const body = typeof payload === 'string' ? { content: payload } : payload

      payloads.push({ content: body.content ?? '', nonce: body.nonce, enforceNonce: body.enforceNonce })

      return {}
    },
  } as unknown as DiscordMessageCreateEvent

  return { event, payloads }
}

test('discord gateway: 同じ message の同じ chunk index は同じ nonce で 1 通にまとまり、chunk が違えば別の message になる', async () => {
  const messageId = '1574711804037308467'
  const { event, payloads } = makeCapturingFakeMessageCreate({ id: messageId, content: '取り直しの対象' })
  const handlers: DiscordGatewayHandlers = {
    onReady: () => {},
    onError: () => {},
    onIgnored: () => {},
    // 実接线と同じ形: chat.ts が chunk 順で reply(content, discordChatReplyNonce(messageId, index)) を呼び、
    // gateway が discordNotificationPayload(content, nonce) を message.reply へ渡す
    onMessage: async (message, reply) => {
      await reply('応答 chunk 0', discordChatReplyNonce(message.messageId, 0))
      // 同じ message をもう一度取り直した（同じ chunk index なので同じ nonce）
      await reply('応答 chunk 0', discordChatReplyNonce(message.messageId, 0))
      await reply('応答 chunk 1', discordChatReplyNonce(message.messageId, 1))
    },
  }

  handleDiscordMessageCreate(event, gatewayConfig, handlers, fakeTypingIndicator, '12345678901234567')
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })

  assert.equal(payloads.length, 3)

  for (const payload of payloads) {
    assert.equal(payload.enforceNonce, true, 'nonce を Discord 側で check させる')
  }

  const first = payloads[0]?.nonce ?? ''
  const repeated = payloads[1]?.nonce ?? ''
  const otherChunk = payloads[2]?.nonce ?? ''

  assert.ok(first.length > 0 && repeated.length > 0 && otherChunk.length > 0)
  assert.equal(first, repeated, '同じ messageId + 同じ chunk index は同じ nonce')
  assert.notEqual(first, otherChunk, 'chunk が違えば別の nonce（別の message として残る）')

  const postedAt = Date.UTC(2026, 10, 24, 9, 2, 30)
  const deduped = modelDiscordNonceDedupe(
    [
      { nonce: first, atMs: postedAt },
      { nonce: repeated, atMs: postedAt + 10_000 },
      { nonce: otherChunk, atMs: postedAt + 10_000 },
    ],
    5 * 60_000,
  )

  assert.deepEqual(
    deduped,
    { createdMessages: 2, collapsedSends: 1 },
    '同じ nonce の再送は 1 通にまとまり、違う chunk は別の message になる（取り直しの応答が消えない）',
  )
})

test('discord gateway: enforce_nonce の check は数分のあいだだけなので時間を置いた再送は 2 通になる（restart 後の重複は state.json で抑える）', () => {
  const messageId = '1574795431291125812'
  const nonce = discordChatReplyNonce(messageId, 0)
  const windowMs = 5 * 60_000

  assert.deepEqual(
    modelDiscordNonceDedupe(
      [
        { nonce, atMs: 0 },
        { nonce, atMs: windowMs },
      ],
      windowMs,
    ),
    { createdMessages: 1, collapsedSends: 1 },
  )
  assert.deepEqual(
    modelDiscordNonceDedupe(
      [
        { nonce, atMs: 0 },
        { nonce, atMs: 11 * 60_000 },
        { nonce, atMs: 105 * 60_000 },
      ],
      windowMs,
    ),
    { createdMessages: 3, collapsedSends: 0 },
    '数分以上離れると同じ nonce でも別の message として channel に届く',
  )
  // 2026-11-24 の incident の restart 間隔（11 分と 1 時間 45 分）は後者なので、restart 後の再応答は
  // state.json の answeredMessageIds で抑える（packages/araya/test/discord-bot.test.ts で測る）
})
