import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOT_STARTED_TEXT,
  RESTART_STARTED_TEXT,
  RESTART_STOPPING_TEXT,
  discordRestartStartedText,
  postDiscordRestartNotice,
} from './restart-notice.ts'

const BOT_TOKEN = 'synthetic-token'
const CHANNEL_ID = '32345678901234567'

test('restart notice: 停止通知を permission channel 宛に Bot token 付き POST する', async () => {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = []

  const ok = await postDiscordRestartNotice({
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    text: RESTART_STOPPING_TEXT,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })

      return { ok: true }
    },
  })

  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`)
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(calls[0]?.init.headers['Content-Type'], 'application/json')
  assert.equal(JSON.parse(calls[0]?.init.body ?? '{}').content, RESTART_STOPPING_TEXT)
})

test('restart notice: POST 失敗は throw せず false を返す（restart を止めない）', async () => {
  const notOk = await postDiscordRestartNotice({
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    text: RESTART_STOPPING_TEXT,
    fetchImpl: async () => {
      return { ok: false }
    },
  })
  assert.equal(notOk, false)

  const threw = await postDiscordRestartNotice({
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    text: RESTART_STOPPING_TEXT,
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(threw, false)
})

test('restart notice: 前回 ready の有無で起動 message を分ける', () => {
  assert.equal(discordRestartStartedText(null), BOT_STARTED_TEXT)
  assert.equal(discordRestartStartedText('2026-11-22T00:00:00.000Z'), RESTART_STARTED_TEXT)
})

test('restart notice: 通知本文に token を含めない', async () => {
  let body = ''

  await postDiscordRestartNotice({
    botToken: BOT_TOKEN,
    channelId: CHANNEL_ID,
    text: RESTART_STOPPING_TEXT,
    fetchImpl: async (_url, init) => {
      body = init.body

      return { ok: true }
    },
  })

  assert.ok(!body.includes(BOT_TOKEN), body)
})
