import assert from 'node:assert/strict'
import test from 'node:test'

import { discordNotificationPayload } from '../src/discord/gateway.ts'

test('discord gateway: nonce payload は enforce_nonce を有効にする', () => {
  assert.deepEqual(discordNotificationPayload('Task update', 'nonce-1'), {
    content: 'Task update',
    nonce: 'nonce-1',
    enforceNonce: true,
    allowedMentions: { parse: [] },
  })
})
