import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
