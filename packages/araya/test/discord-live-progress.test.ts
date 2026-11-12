import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runDiscordBot } from '../src/discord/bot.ts'
import {
  progressSocketPath,
  sendProgressWake,
} from '../src/infrastructure/progress-socket.ts'
import { openTaskLedger } from '../src/runner/ledger.ts'

const BOT_TOKEN = 'synthetic-live-progress-token'
const ENV = {
  ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
  ARAYA_DISCORD_APPLICATION_ID: '12345678901234567',
  ARAYA_DISCORD_GUILD_ID: '22345678901234567',
  ARAYA_DISCORD_CHANNEL_ID: '32345678901234567',
  ARAYA_DISCORD_ALLOWED_USER_IDS: '42345678901234567',
}
const SETTINGS = {
  devRoot: '/tmp/araya-live-progress-dev',
  agentDir: '/tmp/araya-live-progress-agent',
  model: null,
  timeoutMs: 60_000,
  verificationTimeoutMs: 60_000,
}

async function makeDataDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-live-progress-test-')))
}

async function waitUntil(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 2_000

  while (!await condition()) {
    if (Date.now() >= deadline) {
      assert.fail(message)
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function launchBot(
  dataDir: string,
  pollMs: number,
  notifications: string[],
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
  gatewayOverrides?: {
    sendText?: (content: string, nonce: string) => Promise<void>
  },
) {
  const stop = new AbortController()
  const logs: Record<string, unknown>[] = []
  const running = runDiscordBot({
    dataDir,
    env: ENV,
    stopSignal: stop.signal,
    verifyUnit: false,
    pollMs,
    ...(sleep === undefined ? {} : { sleep }),
    createGateway: async (_config, handlers) => {
      return {
        connect: async () => {
          handlers.onReady()
        },
        sendText: async (content, nonce) => {
          if (gatewayOverrides?.sendText !== undefined) {
            await gatewayOverrides.sendText(content, nonce)
          } else {
            notifications.push(content)
          }
        },
        close: async () => {},
      }
    },
    log: (entry) => logs.push(entry),
  })

  await waitUntil(async () => {
    try {
      return (await fs.lstat(progressSocketPath(dataDir))).isSocket()
    } catch {
      return false
    }
  }, 'Discord progress socket が起動しなかった')

  return { stop, running, logs }
}

function createRunningAttempt(ledger: ReturnType<typeof openTaskLedger>) {
  ledger.createTask({
    title: 'live progress',
    goal: 'verify tool progress notifications',
    constraints: [],
    targets: [],
    permissions: [],
    idempotencyKey: null,
  })
  const claimed = ledger.claimNextAttempt(1, SETTINGS)

  assert.ok(claimed)
  return claimed
}

test('discord live progress: wake は poll interval を待たずに通知し、重複 wake は二重投稿しない', async () => {
  const dataDir = await makeDataDir()
  const notifications: string[] = []
  const bot = await launchBot(dataDir, 30_000, notifications)
  const ledger = openTaskLedger(dataDir, { secretValues: [BOT_TOKEN] })

  try {
    const claimed = createRunningAttempt(ledger)
    ledger.appendToolEvent(claimed.taskKey, 'tool.started', {
      tool: 'bash',
      command: 'printf hidden-command',
      output: 'hidden-tool-output',
      llmResponse: 'hidden-model-response',
    })

    assert.equal(await sendProgressWake(dataDir), true)
    assert.equal(await sendProgressWake(dataDir), true)
    await waitUntil(
      () => notifications.some((content) => content.includes('bash を開始しました')),
      'tool.started 通知が poll interval を待たずに届かなかった',
    )
    await new Promise((resolve) => setTimeout(resolve, 30))

    const progress = notifications.filter((content) => content.includes('bash を開始しました'))
    assert.equal(progress.length, 1, notifications.join('\n'))
    assert.equal(progress[0], 'Task #1（試行 1）: bash を開始しました')
    assert.equal(notifications.join('\n').includes('hidden-command'), false)
    assert.equal(notifications.join('\n').includes('hidden-tool-output'), false)
    assert.equal(notifications.join('\n').includes('hidden-model-response'), false)
    assert.equal(notifications.join('\n').includes(BOT_TOKEN), false)
    assert.equal(ledger.listEventsSince(0, 50).some((event) => event.type === 'tool.started'), true)
  } finally {
    ledger.close()
    bot.stop.abort()
    assert.equal(await bot.running, 0)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord live progress: shutdown waits for an in-flight notification before releasing the process lock', async () => {
  const dataDir = await makeDataDir()
  let markSendStarted = () => {}
  let releaseSend = () => {}
  let sendStarted = false
  let firstStoppedEarly = false
  const firstSendStarted = new Promise<void>((resolve) => {
    markSendStarted = () => {
      sendStarted = true
      resolve()
    }
  })
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve
  })
  const first = await launchBot(dataDir, 30_000, [], undefined, {
    sendText: async () => {
      markSendStarted()
      await sendGate
    },
  })
  const ledger = openTaskLedger(dataDir, { secretValues: [BOT_TOKEN] })

  try {
    const claimed = createRunningAttempt(ledger)
    ledger.appendToolEvent(claimed.taskKey, 'tool.started', { tool: 'read' })
    assert.equal(await sendProgressWake(dataDir), true)
    await firstSendStarted
    assert.equal(sendStarted, true)

    first.stop.abort()
    const firstResult = first.running.then((result) => {
      firstStoppedEarly = true
      return result
    })
    const grace = new Promise((resolve) => setTimeout(resolve, 100))
    await Promise.race([firstResult, grace])
    const stoppedBeforeDrain = firstStoppedEarly

    releaseSend()
    assert.equal(await firstResult, 0)
    assert.equal(stoppedBeforeDrain, false, 'shutdown must wait for the notification tick to settle')
  } finally {
    releaseSend()
    first.stop.abort()
    await first.running.catch(() => {})
    ledger.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord live progress: socket wake 後に未使用の poll timer を中断し、待機を積み上げない', async () => {
  const dataDir = await makeDataDir()
  const notifications: string[] = []
  let activeSleeps = 0
  let maximumActiveSleeps = 0
  const bot = await launchBot(dataDir, 30_000, notifications, async (_ms, signal) => {
    await new Promise<void>((resolve) => {
      activeSleeps += 1
      maximumActiveSleeps = Math.max(maximumActiveSleeps, activeSleeps)

      const finish = () => {
        activeSleeps -= 1
        signal.removeEventListener('abort', finish)
        resolve()
      }

      if (signal.aborted) {
        finish()
      } else {
        signal.addEventListener('abort', finish, { once: true })
      }
    })
  })
  const ledger = openTaskLedger(dataDir, { secretValues: [BOT_TOKEN] })

  try {
    const claimed = createRunningAttempt(ledger)
    await waitUntil(() => activeSleeps === 1, 'bot が poll/wake wait に入らなかった')

    for (const tool of ['read', 'edit', 'write']) {
      ledger.appendToolEvent(claimed.taskKey, 'tool.started', { tool })
      assert.equal(await sendProgressWake(dataDir), true)
      await waitUntil(
        () => notifications.some((content) => content.includes(`${tool} を開始しました`)),
        `${tool} の通知が届かなかった`,
      )
      await waitUntil(() => activeSleeps === 1, 'wake 後に古い poll wait が残った')
      assert.equal(maximumActiveSleeps, 1, 'socket wake ごとに未使用 poll wait が増えない')
    }
  } finally {
    ledger.close()
    bot.stop.abort()
    assert.equal(await bot.running, 0)
    assert.equal(activeSleeps, 0)
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord live progress: bot 停止中のevent はledgerに残り、再起動後にcursorから回収される', async () => {
  const dataDir = await makeDataDir()
  const firstNotifications: string[] = []
  const firstBot = await launchBot(dataDir, 30_000, firstNotifications)
  const ledger = openTaskLedger(dataDir, { secretValues: [BOT_TOKEN] })

  try {
    const claimed = createRunningAttempt(ledger)
    firstBot.stop.abort()
    assert.equal(await firstBot.running, 0)
    assert.equal(await sendProgressWake(dataDir), false)

    ledger.appendToolEvent(claimed.taskKey, 'tool.finished', { tool: 'read', isError: false })
    assert.equal(ledger.listEventsSince(0, 50).some((event) => event.type === 'tool.finished'), true)

    const replayed: string[] = []
    const restarted = await launchBot(dataDir, 30_000, replayed)

    try {
      await waitUntil(
        () => replayed.some((content) => content.includes('read を完了しました')),
        'bot 再起動後に cursor から未配信 event を回収できなかった',
      )
      assert.equal(replayed.filter((content) => content.includes('read を完了しました')).length, 1)
    } finally {
      restarted.stop.abort()
      assert.equal(await restarted.running, 0)
    }
  } finally {
    ledger.close()
    firstBot.stop.abort()
    await firstBot.running.catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
