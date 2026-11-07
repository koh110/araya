import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRedactor } from '../src/infrastructure/redaction.ts'
import {
  MAX_NOTIFICATION_ATTEMPTS,
  notificationBackoffMs,
  notificationTick,
} from '../src/discord/notifier.ts'
import {
  discordStateFilePath,
  newState,
  readDiscordBotState,
  writeDiscordBotState,
} from '../src/discord/state.ts'
import { openTaskLedger, type TaskLedger } from '../src/runner/ledger.ts'

type Sent = { content: string; nonce: string }
const BOT_TOKEN = 'synthetic-notifier-bot-token'

type Harness = {
  dataDir: string
  ledger: TaskLedger
  sent: Sent[]
  logs: Record<string, unknown>[]
  clock: { now: number }
  tick(sendFails: boolean): Promise<{ sent: number; skipped: number }>
  state(): ReturnType<typeof readDiscordBotState>
}

async function makeHarness(options: { failing?: boolean } = {}) {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-notifier-test-')),
  )
  const ledger = openTaskLedger(dataDir)
  const sent: Sent[] = []
  const logs: Record<string, unknown>[] = []
  const clock = { now: Date.parse('2026-10-31T00:00:00.000Z') }
  const redactor = createRedactor([BOT_TOKEN])

  async function tick(sendFails = options.failing === true) {
    const state = readDiscordBotState(dataDir) ?? newState('araya-discord-test.service')

    return notificationTick({
      dataDir,
      ledger,
      state,
      redactor,
      send: async (content, nonce) => {
        if (sendFails) {
          throw new Error('send failed')
        }

        sent.push({ content, nonce })
      },
      nowMs: () => {
        return clock.now
      },
      log: (entry) => {
        logs.push(entry)
      },
    })
  }

  function state() {
    return readDiscordBotState(dataDir)
  }

  return { dataDir, ledger, sent, logs, clock, tick, state }
}

async function withHarness(run: (harness: Harness) => Promise<void>) {
  const harness = await makeHarness()

  try {
    await run(harness)
  } finally {
    harness.ledger.close()
    await fs.rm(harness.dataDir, { recursive: true, force: true })
  }
}

test('discord-notifier: 台帳の event を 1 通ずつ nonce 付きで送り、state の cursor を進める', async () => {
  await withHarness(async ({ dataDir, ledger, tick, sent, state }) => {
    // event が無いときは何も送らない・書かない
    assert.deepEqual(await tick(false), { sent: 0, skipped: 0 })
    assert.equal(state(), null)

    ledger.createTask({
      title: '通知テスト',
      goal: 'goal',
      constraints: [],
      targets: [],
      permissions: [],
      idempotencyKey: null,
    })
    assert.deepEqual(await tick(false), { sent: 1, skipped: 0 })
    assert.deepEqual(sent, [
      { content: 'Task #1 を登録しました（待ち）: 通知テスト', nonce: 'araya-ev1' },
    ])

    // 同じ event を二重に送らない（state file から続き読む = process 再起動と同じ）
    assert.deepEqual(await tick(false), { sent: 0, skipped: 0 })
    assert.equal(sent.length, 1)
    assert.equal(state()!.cursor, 1)

    ledger.cancelTask(1)
    assert.deepEqual(await tick(false), { sent: 2, skipped: 0 })
    assert.deepEqual(sent.slice(1), [
      { content: 'Task #1 の中止を受け付けました（待ち）', nonce: 'araya-ev2' },
      { content: 'Task #1（試行 1）は失敗で終わりました（理由: 中止）', nonce: 'araya-ev3' },
    ])
    assert.equal(state()!.cursor, 3)

    const persisted = state()!

    assert.equal(persisted.version, 1)
    assert.equal(persisted.unit, 'araya-discord-test.service')
    assert.equal((await fs.stat(discordStateFilePath(dataDir))).mode & 0o777, 0o600)
  })
})

test('discord-notifier: 送信に失敗した event は exponential backoff で送り直し、待っている間は後続を送らない', async () => {
  await withHarness(async ({ ledger, tick, sent, logs, clock, state }) => {
    ledger.createTask({
      title: 'backoff',
      goal: 'goal',
      constraints: [],
      targets: [],
      permissions: [],
      idempotencyKey: null,
    })

    // 1 通目失败 → backoff を記録
    assert.deepEqual(await tick(true), { sent: 0, skipped: 0 })
    assert.deepEqual(
      logs.map((entry) => {
        return entry.type
      }),
      ['discord_notification_retry_scheduled'],
    )
    assert.equal(state()!.backoff!.attempts, 1)
    assert.equal(state()!.backoff!.eventSeq, 1)

    // 待ち終わり前は何もしない
    clock.now += notificationBackoffMs(1) - 1
    assert.deepEqual(await tick(true), { sent: 0, skipped: 0 })
    assert.equal(sent.length, 0)

    // 待ち終わり → 同じ event を同じ nonce で送り直す
    clock.now += 2
    assert.deepEqual(await tick(false), { sent: 1, skipped: 0 })
    assert.deepEqual(sent, [
      { content: 'Task #1 を登録しました（待ち）: backoff', nonce: 'araya-ev1' },
    ])
    assert.equal(state()!.cursor, 1)
    assert.equal(state()!.backoff, null)

    // backoff の間隔は Attempts で伸び、上限がある
    assert.ok(notificationBackoffMs(1) < notificationBackoffMs(3))
    assert.equal(notificationBackoffMs(50), 60_000)
  })
})

test('discord-notifier: bot token を含む既存 task title を通知文へ出さない', async () => {
  const secret = BOT_TOKEN

  await withHarness(async ({ ledger, tick, sent }) => {
    ledger.createTask({
      title: `Task ${secret}`,
      goal: 'goal',
      constraints: [],
      targets: [],
      permissions: [],
      idempotencyKey: null,
    })

    await tick(false)

    const notification = sent[0]

    assert.ok(notification)
    assert.equal(notification.content.includes(secret), false, notification.content)
    assert.ok(notification.content.includes('[REDACTED]'), notification.content)
  })
})

test('discord-notifier: 送信失敗が続く event は上限で諦めて次へ進む', async () => {
  await withHarness(async ({ ledger, tick, logs, clock, state }) => {
    ledger.createTask({
      title: '諦める',
      goal: 'goal',
      constraints: [],
      targets: [],
      permissions: [],
      idempotencyKey: null,
    })
    await tick(true)

    let attempts = 0

    while (attempts < MAX_NOTIFICATION_ATTEMPTS + 2 && state()!.backoff !== null) {
      clock.now += 120_000
      await tick(true)
      attempts += 1
    }

    assert.equal(state()!.backoff, null)
    assert.equal(state()!.cursor, 1)
    assert.ok(
      logs.some((entry) => {
        return (
          entry.type === 'discord_notification_abandoned' &&
          entry.eventSeq === 1 &&
          entry.attempts === MAX_NOTIFICATION_ATTEMPTS
        )
      }),
      JSON.stringify(
        logs.map((entry) => {
          return entry.type
        }),
      ),
    )
  })
})

test('discord-notifier: 台帳に無い・送れない event は待たずに cursor を進める', async () => {
  await withHarness(async ({ tick, logs, state, dataDir }) => {
    const stateValue = newState('araya-discord-test.service')

    stateValue.cursor = 4
    stateValue.backoff = { eventSeq: 999, attempts: 1, nextAttemptAtMs: 0 }
    writeDiscordBotState(dataDir, stateValue)

    assert.deepEqual(await tick(true), { sent: 0, skipped: 1 })
    assert.equal(state()!.cursor, 999)
    assert.equal(state()!.backoff, null)
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_notification_skipped' && entry.reason === 'unrenderable'
      }),
    )
  })
})

test('discord-notifier: 通知でない event（agent の tool 記録）は送らずに飛ばす', async () => {
  await withHarness(async ({ ledger, tick, sent, state, dataDir }) => {
    const { created } = ledger.createTask({
      title: 'tool',
      goal: 'goal',
      constraints: [],
      targets: [],
      permissions: [],
      idempotencyKey: null,
    })

    assert.equal(created, true)

    // tool step の記録は runner が書く form の event を直接足す
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(dataDir, 'tasks.sqlite'))

    try {
      db.prepare(
        "INSERT INTO task_events (task_id, attempt, at, type, data_json) VALUES (1, 1, '2026-10-31T00:00:00.000Z', 'agent.tool', '{}')",
      ).run()
    } finally {
      db.close()
    }

    const result = await tick(false)

    assert.equal(result.sent, 1)
    assert.equal(result.skipped, 1)
    assert.deepEqual(
      sent.map((item) => {
        return item.nonce
      }),
      ['araya-ev1'],
    )
    assert.equal(state()!.cursor, 2)
  })
})
