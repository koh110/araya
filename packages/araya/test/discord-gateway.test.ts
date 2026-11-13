import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDiscordTypingIndicator,
  discordGatewayIntents,
  discordNotificationPayload,
  flattenDiscordCommandOptions,
} from '../src/discord/gateway.ts'

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

test('discord gateway: typing indicator is refreshed while any accepted response is pending', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] })
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

  context.mock.timers.tick(8_000)
  await Promise.resolve()
  assert.equal(refreshes, 2)

  releaseFirst?.()
  await pending[0]
  context.mock.timers.tick(8_000)
  await Promise.resolve()
  assert.equal(refreshes, 3)

  releaseSecond?.()
  await pending[1]
  context.mock.timers.tick(16_000)
  assert.equal(refreshes, 3)
  indicator.close()
  assert.deepEqual(errors, [])
})

test('discord gateway: a missed refresh is sent when the current typing request settles', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] })
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

  context.mock.timers.tick(8_000)
  assert.equal(refreshes, 1)
  context.mock.timers.tick(1_000)
  releaseFirstSend?.()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(refreshes, 2)

  context.mock.timers.tick(7_000)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(refreshes, 3)

  releaseOperation?.()
  await pending
  context.mock.timers.tick(16_000)
  assert.equal(refreshes, 3)
  indicator.close()
})

test('discord gateway: typing failure does not fail the chat response', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] })
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

test('discord gateway: typing heartbeat stops when a response rejects', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] })
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

  context.mock.timers.tick(16_000)
  assert.equal(refreshes, 1)
  indicator.close()
})

test('discord gateway: closing the typing indicator stops an active heartbeat', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] })
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
  context.mock.timers.tick(16_000)
  assert.equal(refreshes, 1)

  release?.()
  await pending[0]
})
