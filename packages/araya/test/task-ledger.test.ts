import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { REDACTED } from '../src/redaction.ts'
import {
  createTaskKey,
  isLedgerError,
  MAX_CONCURRENT_ATTEMPTS,
  openTaskLedger,
  parseRetryNote,
  parseTaskInput,
  type AttemptResult,
  type AttemptSettings,
  type LedgerErrorCode,
  type TaskInput,
  type TaskLedger
} from '../src/task-ledger.ts'

const TASK_LEDGER_MODULE = new URL('../src/task-ledger.ts', import.meta.url).href

async function makeDataDir() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-task-ledger-test-')))

  return { root, dataDir: path.join(root, 'data') }
}

function taskInput(overrides: Partial<TaskInput> = {}) {
  const input: TaskInput = {
    title: '空の入力を拒否する',
    goal: 'araya の CLI で、空の値を受け取ったら理由を表示して終了するようにする',
    constraints: [],
    targets: [],
    permissions: [],
    idempotencyKey: null,
    ...overrides
  }

  return input
}

function settings(overrides: Partial<AttemptSettings> = {}) {
  const value: AttemptSettings = {
    devRoot: '/tmp/araya-dev-root',
    agentDir: '/tmp/araya-agent-dir',
    model: { provider: 'faux', id: 'faux-1', thinkingLevel: null },
    timeoutMs: 1_200_000,
    verificationTimeoutMs: 300_000,
    ...overrides
  }

  return value
}

function result(overrides: Partial<AttemptResult> = {}) {
  const value: AttemptResult = {
    status: 'completed',
    failureReason: null,
    failureDetail: null,
    summary: '報告',
    decisionQuestion: null,
    model: { provider: 'faux', id: 'faux-1', thinkingLevel: 'medium', source: 'araya-config' },
    evidence: { taskKey: 'x', outcome: 'completed', worktrees: [] },
    ...overrides
  }

  return value
}

function assertLedgerError(code: LedgerErrorCode) {
  return (error: unknown) => {
    assert.ok(isLedgerError(error), String(error))
    assert.equal(error.code, code)

    return true
  }
}

function eventTypes(ledger: TaskLedger, taskId: number) {
  return ledger.showTask(taskId, { events: 10_000 }).events.map((event) => {
    return event.type
  })
}

// 取り込んで結果を記録し、最新の試行を終わらせる
function finishLatest(ledger: TaskLedger, attemptResult: AttemptResult) {
  const claimed = ledger.claimNextAttempt(MAX_CONCURRENT_ATTEMPTS, settings())
  assert.ok(claimed)
  assert.deepEqual(ledger.recordResult(claimed.taskKey, attemptResult, { taskKey: claimed.taskKey, addMs: 10 }), {
    recorded: true,
    status: attemptResult.status,
    failureReason: attemptResult.failureReason
  })

  return claimed
}

test('ledger: dataDir と logs を 0700、台帳を 0600 で作り、busy_timeout・WAL・foreign_keys を設定する', async () => {
  const { root, dataDir } = await makeDataDir()

  try {
    const ledger = openTaskLedger(dataDir)

    try {
      assert.deepEqual(ledger.pragmas(), { busyTimeout: 5000, journalMode: 'wal', foreignKeys: 1 })
      assert.equal(ledger.path, path.join(dataDir, 'tasks.sqlite'))
    } finally {
      ledger.close()
    }

    assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(path.join(dataDir, 'logs'))).mode & 0o777, 0o700)
    assert.equal((await fs.stat(path.join(dataDir, 'tasks.sqlite'))).mode & 0o777, 0o600)

    const db = new DatabaseSync(path.join(dataDir, 'tasks.sqlite'))

    try {
      assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      assert.deepEqual(tables.map((row) => row.name), ['runner', 'runs', 'task_events', 'tasks'])
    } finally {
      db.close()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 既にある台帳の file の mode は変えない', async () => {
  const { root, dataDir } = await makeDataDir()

  try {
    await fs.mkdir(dataDir, { mode: 0o755 })
    await fs.writeFile(path.join(dataDir, 'tasks.sqlite'), '', { mode: 0o640 })
    await fs.chmod(path.join(dataDir, 'tasks.sqlite'), 0o640)
    openTaskLedger(dataDir).close()

    assert.equal((await fs.stat(path.join(dataDir, 'tasks.sqlite'))).mode & 0o777, 0o640)
    assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o755)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: busy_timeout は 5000 で、4 process の同時書き込みが SQLITE_BUSY にならない', async () => {
  const { root, dataDir } = await makeDataDir()
  // 空の dataDir に4つの process が同時に初めて開き、接続ごとに開き直しながら 50 件ずつ作る
  const script = `
    const { openTaskLedger } = await import(${JSON.stringify(TASK_LEDGER_MODULE)})
    const [dataDir, name] = process.argv.slice(1)
    for (let index = 0; index < 50; index += 1) {
      const ledger = openTaskLedger(dataDir)
      try {
        ledger.createTask({ title: name + '-' + index, goal: 'goal', constraints: [], targets: [], permissions: [], idempotencyKey: null })
      } finally {
        ledger.close()
      }
    }
  `

  try {
    const exits = await Promise.all(['p0', 'p1', 'p2', 'p3'].map((name) => {
      return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir, name], { stdio: ['ignore', 'ignore', 'pipe'] })
        const stderr: string[] = []
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))
        child.once('error', reject)
        child.once('close', (code) => resolve({ code, stderr: stderr.join('') }))
      })
    }))

    assert.deepEqual(exits, Array.from({ length: 4 }, () => ({ code: 0, stderr: '' })))

    const ledger = openTaskLedger(dataDir)

    try {
      const tasks = ledger.listTasks({ limit: 200 })
      assert.equal(tasks.length, 200)
      assert.equal(new Set(tasks.map((task) => task.id)).size, 200)
      assert.deepEqual(ledger.queueView(MAX_CONCURRENT_ATTEMPTS), { limit: 1, running: 0, queued: 200 })
    } finally {
      ledger.close()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 未知の user_version と、0 なのに table がある台帳は変更せずに失敗する', async () => {
  for (const [version, expectedMessage] of [[99, /unsupported schema version 99/u], [0, /has tables but no schema version/u]] as const) {
    const { root, dataDir } = await makeDataDir()
    const ledgerPath = path.join(dataDir, 'tasks.sqlite')

    try {
      await fs.mkdir(dataDir, { recursive: true })
      const setup = new DatabaseSync(ledgerPath)
      setup.exec('PRAGMA journal_mode = WAL')
      setup.exec('CREATE TABLE other (value TEXT); INSERT INTO other (value) VALUES (\'keep\')')
      setup.exec(`PRAGMA user_version = ${version}`)
      setup.close()

      assert.throws(() => openTaskLedger(dataDir), (error: unknown) => {
        assert.ok(isLedgerError(error))
        assert.equal(error.code, 'ledger_unsupported_version')
        assert.match(error.message, expectedMessage)

        return true
      })

      const check = new DatabaseSync(ledgerPath)

      try {
        assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, version)
        const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        assert.deepEqual(tables.map((row) => row.name), ['other'])
        assert.deepEqual(check.prepare('SELECT value FROM other').all().map((row) => row.value), ['keep'])
      } finally {
        check.close()
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test('ledger: Task と queued の1回目の試行を作り、taskKey は task-<id>-<試行>-<a-z2-7 の6文字>', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir, { now: () => new Date('2026-10-24T00:00:00.000Z') })

  try {
    const created = ledger.createTask(taskInput({ constraints: ['依存を追加しない'], targets: ['araya'], permissions: ['npm test'] }))

    assert.equal(created.created, true)
    assert.deepEqual(created.task, {
      id: 1,
      title: '空の入力を拒否する',
      status: 'queued',
      attempt: 1,
      failureReason: null,
      decisionQuestion: null,
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
      goal: 'araya の CLI で、空の値を受け取ったら理由を表示して終了するようにする',
      constraints: ['依存を追加しない'],
      targets: ['araya'],
      permissions: ['npm test'],
      summary: null,
      cancelRequested: false
    })

    const shown = ledger.showTask(1, { events: 50 })
    assert.equal(shown.attempts.length, 1)
    assert.match(shown.attempts[0]?.taskKey ?? '', /^task-1-1-[a-z2-7]{6}$/u)
    assert.equal(shown.attempts[0]?.status, 'queued')
    assert.equal(shown.attempts[0]?.queuedAt, '2026-10-24T00:00:00.000Z')
    assert.deepEqual(shown.events.map((event) => [event.type, event.attempt, event.data]), [['task.created', 1, {}]])
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: createTaskKey は暗号学的乱数の byte を a-z2-7 に写す', () => {
  assert.equal(createTaskKey(12, 1, () => Uint8Array.from([0, 25, 26, 31, 32, 255])), 'task-12-1-az27a7')
})

test('ledger: 同じ idempotencyKey は created false で同じ Task を返し、値が違えば idempotency_conflict', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const first = ledger.createTask(taskInput({ idempotencyKey: 'example-1', constraints: ['a'] }))
    const second = ledger.createTask(taskInput({ idempotencyKey: 'example-1', constraints: ['a'] }))

    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.deepEqual(second.task, first.task)
    assert.equal(ledger.showTask(first.task.id, { events: 50 }).attempts.length, 1)

    for (const changed of [
      { title: '別の題名' },
      { goal: '別の目的を持つ Task' },
      { constraints: [] },
      { targets: ['other'] },
      { permissions: ['push'] }
    ]) {
      assert.throws(() => ledger.createTask(taskInput({ idempotencyKey: 'example-1', constraints: ['a'], ...changed })), assertLedgerError('idempotency_conflict'))
    }

    assert.equal(ledger.listTasks({ limit: 50 }).length, 1)
    assert.equal(ledger.createTask(taskInput({ idempotencyKey: 'example-2' })).created, true)
    assert.equal(ledger.listTasks({ limit: 50 }).length, 2)
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 入力の検証は既定値を補い、上限ちょうどを受け付ける', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

  assert.deepEqual(parseTaskInput(encode({ title: 't', goal: 'g' })), {
    title: 't', goal: 'g', constraints: [], targets: [], permissions: [], idempotencyKey: null
  })
  assert.doesNotThrow(() => parseTaskInput(encode({
    title: 'x'.repeat(200),
    goal: 'x'.repeat(20_000),
    constraints: Array.from({ length: 32 }, () => 'c'.repeat(312)),
    targets: Array.from({ length: 16 }, () => 't'.repeat(200)),
    permissions: Array.from({ length: 16 }, () => 'p'.repeat(312)),
    idempotencyKey: 'k'.repeat(200)
  })))
  assert.equal(parseRetryNote(''), null)
  assert.equal(parseRetryNote('n'.repeat(10_000)), 'n'.repeat(10_000))
  assert.throws(() => parseRetryNote('n'.repeat(10_001)), assertLedgerError('invalid_note'))
  assert.throws(() => parseRetryNote('a\0b'), assertLedgerError('invalid_note'))
})

test('ledger: 取り込みは空きがあるときだけ最も古い queued を running にし、Task の値と前回の試行を返す', async () => {
  const { root, dataDir } = await makeDataDir()
  let clock = Date.parse('2026-10-24T00:00:00.000Z')
  const ledger = openTaskLedger(dataDir, {
    now: () => {
      clock += 1000

      return new Date(clock)
    }
  })

  try {
    const first = ledger.createTask(taskInput({ title: 'first', constraints: ['c'], targets: ['t'], permissions: ['p'] })).task
    const second = ledger.createTask(taskInput({ title: 'second' })).task

    assert.equal(ledger.hasClaimableAttempt(1), true)
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)
    assert.equal(claimed.taskId, first.id)
    assert.deepEqual({ ...claimed, taskKey: '' }, {
      taskId: first.id,
      attempt: 1,
      taskKey: '',
      title: 'first',
      goal: first.goal,
      constraints: ['c'],
      targets: ['t'],
      permissions: ['p'],
      note: null,
      settings: settings(),
      previous: null
    })

    // 上限 1 では2件目を取り込まない
    assert.equal(ledger.hasClaimableAttempt(1), false)
    assert.equal(ledger.claimNextAttempt(1, settings()), null)
    assert.deepEqual(ledger.queueView(1), { limit: 1, running: 1, queued: 1 })

    const shown = ledger.showTask(first.id, { events: 50 })
    assert.equal(shown.task.status, 'running')
    assert.equal(shown.attempts[0]?.status, 'running')
    assert.notEqual(shown.attempts[0]?.startedAt, null)
    assert.deepEqual(shown.events.at(-1)?.data, { taskKey: claimed.taskKey })
    assert.deepEqual(ledger.listRunningAttempts().map((attempt) => [attempt.taskKey, attempt.settings]), [[claimed.taskKey, settings()]])

    // 上限 2 なら2件目も取り込める
    assert.equal(ledger.claimNextAttempt(2, settings())?.taskId, second.id)
    assert.equal(ledger.claimNextAttempt(2, settings()), null)
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 結果の記録は running のときだけ行い、稼働時間を精算して run.finished を1件書く', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)
    ledger.appendRunResumed(claimed.taskKey)
    ledger.heartbeat('inv', [{ taskKey: claimed.taskKey, addMs: 1500 }])

    const recorded = ledger.recordResult(claimed.taskKey, result({ summary: 's'.repeat(5000) }), { taskKey: claimed.taskKey, addMs: 500 })
    assert.deepEqual(recorded, { recorded: true, status: 'completed', failureReason: null })
    assert.deepEqual(ledger.recordResult(claimed.taskKey, result(), { taskKey: claimed.taskKey, addMs: 500 }), { recorded: false })

    const shown = ledger.showTask(task.id, { events: 50 })
    const attempt = shown.attempts[0]
    assert.equal(shown.task.status, 'completed')
    assert.equal(attempt?.activeMs, 2000)
    assert.equal(attempt?.summary?.length, 4000)
    assert.deepEqual(attempt?.model, { provider: 'faux', id: 'faux-1', thinkingLevel: 'medium', source: 'araya-config' })
    assert.deepEqual(attempt?.evidence, { taskKey: 'x', outcome: 'completed', worktrees: [], resumes: 1, activeMs: 2000 })
    assert.deepEqual(eventTypes(ledger, task.id), ['task.created', 'run.started', 'run.resumed', 'run.finished'])
    assert.deepEqual(shown.events.at(-1)?.data, { status: 'completed', failureReason: null })
    assert.deepEqual(ledger.queueView(1), { limit: 1, running: 0, queued: 0 })
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: queued の中止はその場で failed（cancelled）にし、その試行は取り込まれない', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    const cancelled = ledger.cancelTask(task.id)

    assert.equal(cancelled.cancel, 'cancelled')
    assert.equal(cancelled.task.status, 'failed')
    assert.equal(cancelled.task.failureReason, 'cancelled')
    assert.equal(cancelled.task.cancelRequested, false)

    const attempt = ledger.showTask(task.id, { events: 50 }).attempts[0]
    assert.equal(attempt?.status, 'failed')
    assert.equal(attempt?.failureReason, 'cancelled')
    assert.notEqual(attempt?.cancelRequestedAt, null)
    assert.equal(attempt?.cancelRequestedAt, attempt?.finishedAt)
    assert.equal(attempt?.stopReason, null)
    assert.equal(attempt?.startedAt, null)
    assert.equal(ledger.claimNextAttempt(1, settings()), null)
    assert.deepEqual(eventTypes(ledger, task.id), ['task.created', 'task.cancel_requested', 'run.finished'])
    assert.deepEqual(ledger.showTask(task.id, { events: 50 }).events.map((event) => event.data), [
      {},
      { while: 'queued' },
      { status: 'failed', failureReason: 'cancelled' }
    ])
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: running の中止は印だけを付け、2回目は already_requested、終わった Task は task_not_cancellable', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)

    const requested = ledger.cancelTask(task.id)
    assert.equal(requested.cancel, 'requested')
    assert.equal(requested.task.status, 'running')
    assert.equal(requested.task.cancelRequested, true)
    assert.equal(ledger.cancelTask(task.id).cancel, 'already_requested')
    assert.deepEqual(eventTypes(ledger, task.id), ['task.created', 'run.started', 'task.cancel_requested'])
    assert.equal(ledger.listRunningAttempts()[0]?.cancelRequestedAt !== null, true)

    for (const status of ['completed', 'failed', 'blocked'] as const) {
      const other = ledger.createTask(taskInput({ title: status })).task
      ledger.recordResult(claimed.taskKey, result(), { taskKey: claimed.taskKey, addMs: 0 })
      finishLatest(ledger, result({
        status,
        failureReason: status === 'completed' ? null : 'verification_failed'
      }))
      assert.throws(() => ledger.cancelTask(other.id), assertLedgerError('task_not_cancellable'))
    }

    assert.throws(() => ledger.cancelTask(999), assertLedgerError('task_not_found'))
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 中止を求めた試行は、試行の task の結果にかかわらず failed（cancelled）で記録し、元の結果を resultBeforeCancel に残す', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir, { secretValues: ['super-secret-value'] })

  try {
    const task = ledger.createTask(taskInput()).task
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)
    assert.equal(ledger.cancelTask(task.id).cancel, 'requested')

    const recorded = ledger.recordResult(claimed.taskKey, result({
      status: 'failed',
      failureReason: 'verification_failed',
      failureDetail: 'detail super-secret-value',
      evidence: { taskKey: claimed.taskKey, outcome: 'failed', failureReason: 'verification_failed', worktrees: [{ worktreePath: '/w', branch: 'b' }] }
    }), { taskKey: claimed.taskKey, addMs: 0 })

    assert.deepEqual(recorded, { recorded: true, status: 'failed', failureReason: 'cancelled' })
    const attempt = ledger.showTask(task.id, { events: 50 }).attempts[0]
    assert.equal(attempt?.failureReason, 'cancelled')
    assert.equal(attempt?.failureDetail, null)
    assert.equal(attempt?.summary, '報告')
    assert.deepEqual(attempt?.evidence, {
      taskKey: claimed.taskKey,
      outcome: 'failed',
      failureReason: 'cancelled',
      worktrees: [{ worktreePath: '/w', branch: 'b' }],
      resumes: 0,
      activeMs: 0,
      resultBeforeCancel: { status: 'failed', failureReason: 'verification_failed', failureDetail: `detail ${REDACTED}` }
    })

    // 記録した後の中止は拒否され、run.finished は1件のまま
    assert.throws(() => ledger.cancelTask(task.id), assertLedgerError('task_not_cancellable'))
    assert.equal(eventTypes(ledger, task.id).filter((type) => type === 'run.finished').length, 1)
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 結果を記録した後の cancel は task_not_cancellable', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    finishLatest(ledger, result())

    assert.throws(() => ledger.cancelTask(task.id), assertLedgerError('task_not_cancellable'))
    assert.equal(ledger.getTask(task.id).status, 'completed')
    assert.deepEqual(eventTypes(ledger, task.id), ['task.created', 'run.started', 'run.finished'])
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: failed と blocked だけ再実行でき、新しい taskKey の queued の試行を作る', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    assert.throws(() => ledger.retryTask(task.id, { note: null, confirmSideEffects: false }), assertLedgerError('task_not_retryable'))

    const first = ledger.claimNextAttempt(1, settings())
    assert.ok(first)
    assert.throws(() => ledger.retryTask(task.id, { note: null, confirmSideEffects: false }), assertLedgerError('task_not_retryable'))

    ledger.recordResult(first.taskKey, result({
      status: 'failed',
      failureReason: 'verification_failed',
      summary: '前回の報告',
      evidence: { worktrees: [{ worktreePath: '/dev/repo/.worktree/araya-x', branch: 'araya/x', diff: 'body' }] }
    }), { taskKey: first.taskKey, addMs: 0 })

    const retried = ledger.retryTask(task.id, { note: '追加の指示', confirmSideEffects: false })
    assert.equal(retried.status, 'queued')
    assert.equal(retried.attempt, 2)
    assert.equal(retried.failureReason, null)

    const shown = ledger.showTask(task.id, { events: 50 })
    assert.deepEqual(shown.attempts.map((attempt) => [attempt.attempt, attempt.status]), [[1, 'failed'], [2, 'queued']])
    assert.match(shown.attempts[1]?.taskKey ?? '', /^task-1-2-[a-z2-7]{6}$/u)
    assert.notEqual(shown.attempts[1]?.taskKey, first.taskKey)
    assert.equal(shown.attempts[1]?.note, '追加の指示')
    assert.deepEqual(shown.events.at(-1), {
      seq: shown.events.at(-1)?.seq,
      attempt: 2,
      at: shown.events.at(-1)?.at,
      type: 'task.retried',
      data: { hasNote: true, confirmedSideEffects: false }
    })

    const second = ledger.claimNextAttempt(1, settings())
    assert.ok(second)
    assert.equal(second.note, '追加の指示')
    assert.deepEqual(second.previous, {
      attempt: 1,
      status: 'failed',
      failureReason: 'verification_failed',
      summary: '前回の報告',
      decisionQuestion: null,
      worktrees: [{ worktreePath: '/dev/repo/.worktree/araya-x', branch: 'araya/x' }],
      interrupted: false
    })

    ledger.recordResult(second.taskKey, result({ status: 'blocked', failureReason: null, decisionQuestion: 'どちら？' }), { taskKey: second.taskKey, addMs: 0 })
    assert.equal(ledger.retryTask(task.id, { note: null, confirmSideEffects: false }).attempt, 3)

    const third = ledger.claimNextAttempt(1, settings())
    assert.ok(third)
    ledger.recordResult(third.taskKey, result(), { taskKey: third.taskKey, addMs: 0 })
    assert.throws(() => ledger.retryTask(task.id, { note: null, confirmSideEffects: false }), assertLedgerError('task_not_retryable'))
    assert.throws(() => ledger.retryTask(999, { note: null, confirmSideEffects: false }), assertLedgerError('task_not_found'))
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 中断された試行または外部変更の可能性がある試行の再実行は確認が必要で、--confirm-side-effects で confirmedSideEffects true', async () => {
  const interruptedResults: AttemptResult[] = [
    result({ status: 'failed', failureReason: 'cancelled' }),
    result({ status: 'blocked', failureReason: 'restart_limit' }),
    result({ status: 'failed', failureReason: 'attempt_error', failureDetail: 'failed' }),
    result({ status: 'failed', failureReason: 'termination_unconfirmed' }),
    result({ status: 'failed', failureReason: 'agent_timeout' }),
    result({ status: 'failed', failureReason: 'agent_failed', evidence: { agent: { error: 'model_error' }, worktrees: [] } }),
    result({
      status: 'failed',
      failureReason: 'draft_pr_failed',
      evidence: { draftPrDelivery: { worktrees: [{ draftPrStatus: 'pushed' }] }, worktrees: [] }
    }),
    result({
      status: 'failed',
      failureReason: 'draft_pr_failed',
      evidence: { draftPrDelivery: { worktrees: [{ draftPrStatus: 'failed', remoteSideEffectsUnconfirmed: true }] }, worktrees: [] }
    })
  ]

  for (const interrupted of interruptedResults) {
    const { root, dataDir } = await makeDataDir()
    const ledger = openTaskLedger(dataDir)

    try {
      const task = ledger.createTask(taskInput()).task
      finishLatest(ledger, {
        ...interrupted,
        evidence: { ...interrupted.evidence, worktrees: [{ worktreePath: '/dev/repo/.worktree/araya-y', branch: 'araya/y' }] }
      })

      assert.throws(() => ledger.retryTask(task.id, { note: null, confirmSideEffects: false }), (error: unknown) => {
        assert.ok(isLedgerError(error))
        assert.equal(error.code, 'side_effects_unconfirmed')
        assert.deepEqual(error.previousWorktrees, [{ worktreePath: '/dev/repo/.worktree/araya-y', branch: 'araya/y' }])

        return true
      }, String(interrupted.failureReason))
      assert.equal(ledger.showTask(task.id, { events: 50 }).attempts.length, 1)

      ledger.retryTask(task.id, { note: null, confirmSideEffects: true })
      const shown = ledger.showTask(task.id, { events: 50 })
      assert.equal(shown.attempts.length, 2)
      assert.deepEqual(shown.events.at(-1)?.data, { hasNote: false, confirmedSideEffects: true })

      // 取り込みのときに、前回が途中で止まった試行であることを返す
      assert.equal(ledger.claimNextAttempt(1, settings())?.previous?.interrupted, true)
    } finally {
      ledger.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test('ledger: 利用者の中止を優先して cancelled にした試行も、途中で止まった試行として扱う', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)
    ledger.cancelTask(task.id)
    ledger.recordResult(claimed.taskKey, result({ status: 'failed', failureReason: 'verification_failed' }), { taskKey: claimed.taskKey, addMs: 0 })

    assert.throws(() => ledger.retryTask(task.id, { note: null, confirmSideEffects: false }), assertLedgerError('side_effects_unconfirmed'))
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: model_unavailable と取り込み前の中止は確認なしで再実行できる', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const unavailable = ledger.createTask(taskInput({ title: 'unavailable' })).task
    finishLatest(ledger, result({
      status: 'failed',
      failureReason: 'agent_failed',
      evidence: { agent: { error: 'model_unavailable', errorMessage: 'no model' }, worktrees: [] }
    }))
    ledger.retryTask(unavailable.id, { note: null, confirmSideEffects: false })
    assert.equal(ledger.claimNextAttempt(1, settings())?.previous?.interrupted, false)

    const queuedCancel = ledger.createTask(taskInput({ title: 'queued cancel' })).task
    ledger.cancelTask(queuedCancel.id)
    const retried = ledger.retryTask(queuedCancel.id, { note: null, confirmSideEffects: false })
    assert.equal(retried.attempt, 2)
    assert.deepEqual(ledger.showTask(queuedCancel.id, { events: 1 }).events[0]?.data, { hasNote: false, confirmedSideEffects: false })

    // 途中で止まっていない試行に --confirm-side-effects を付けても受け付ける
    const verificationFailed = ledger.createTask(taskInput({ title: 'verification failed' })).task
    const running = ledger.listRunningAttempts()[0]
    assert.ok(running)
    ledger.recordResult(running.taskKey, result(), { taskKey: running.taskKey, addMs: 0 })
    assert.equal(ledger.claimNextAttempt(1, settings())?.taskId, queuedCancel.id)
    const queuedRetry = ledger.listRunningAttempts()[0]
    assert.ok(queuedRetry)
    ledger.recordResult(queuedRetry.taskKey, result(), { taskKey: queuedRetry.taskKey, addMs: 0 })
    finishLatest(ledger, result({ status: 'failed', failureReason: 'verification_failed' }))
    ledger.retryTask(verificationFailed.id, { note: null, confirmSideEffects: true })
    assert.deepEqual(ledger.showTask(verificationFailed.id, { events: 1 }).events[0]?.data, { hasNote: false, confirmedSideEffects: true })
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 中止を始めるのは running で stop_reason が空のときだけで、agent_timeout は SHIKI の終わりが未記録のときだけ', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir, { secretValues: ['secret-detail-value'] })

  try {
    ledger.createTask(taskInput({ title: 'a' }))
    ledger.createTask(taskInput({ title: 'b' }))
    const first = ledger.claimNextAttempt(2, settings())
    const second = ledger.claimNextAttempt(2, settings())
    assert.ok(first)
    assert.ok(second)

    // SHIKI の終わりが先に記録されると、期限による中止は効かない
    assert.equal(ledger.recordAgentFinished(first.taskKey), 'recorded')
    assert.equal(ledger.recordAgentFinished(first.taskKey), 'already_recorded')
    assert.equal(ledger.beginStop(first.taskKey, 'agent_timeout', null), false)
    // 利用者の中止は SHIKI の終わりの後でも始められる
    assert.equal(ledger.beginStop(first.taskKey, 'cancelled', null), true)
    assert.equal(ledger.recordAgentFinished(first.taskKey), 'stopping')

    // 期限が先なら SHIKI の終わりは記録されない
    assert.equal(ledger.beginStop(second.taskKey, 'attempt_error', `x${'d'.repeat(3000)} secret-detail-value`), true)
    assert.equal(ledger.beginStop(second.taskKey, 'agent_timeout', null), false)
    assert.equal(ledger.recordAgentFinished(second.taskKey), 'stopping')

    const stop = ledger.readStop(second.taskKey)
    assert.equal(stop.stopReason, 'attempt_error')
    assert.equal(stop.stopDetail?.length, 2000)
    assert.deepEqual(ledger.readStop(first.taskKey), { stopReason: 'cancelled', stopDetail: null })

    const events = ledger.showTask(second.taskId, { events: 50 }).events
    assert.deepEqual(events.map((event) => [event.type, event.data]), [
      ['task.created', {}],
      ['run.started', { taskKey: second.taskKey }],
      ['run.stopping', { reason: 'attempt_error' }]
    ])

    ledger.recordResult(second.taskKey, result({ status: 'failed', failureReason: 'attempt_error' }), { taskKey: second.taskKey, addMs: 0 })
    assert.equal(ledger.beginStop(second.taskKey, 'cancelled', null), false)
    assert.equal(ledger.recordAgentFinished(second.taskKey), 'not_running')
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 秘密の値と URL の userinfo を summary・質問・失敗の詳細・evidence に書く前に置き換える', async () => {
  const { root, dataDir } = await makeDataDir()
  const secret = 'ledger-secret-0123456789'
  const ledger = openTaskLedger(dataDir, { secretValues: [secret] })

  try {
    const task = ledger.createTask(taskInput({ title: `入力は置き換えない ${secret}` })).task
    finishLatest(ledger, result({
      status: 'blocked',
      summary: `summary ${secret}`,
      decisionQuestion: `question https://user:pw@example.invalid ${secret}`,
      failureDetail: `detail ${secret}`,
      evidence: { worktrees: [{ worktreePath: '/w', branch: 'b', note: `n ${secret}` }], list: [secret] }
    }))

    const db = new DatabaseSync(path.join(dataDir, 'tasks.sqlite'))

    try {
      const runs = JSON.stringify(db.prepare('SELECT * FROM runs').all())
      assert.equal(runs.includes(secret), false)
      assert.equal(runs.includes('user:pw'), false)
      // 利用者が書いた Task の入力は置き換えない
      assert.equal(JSON.stringify(db.prepare('SELECT title FROM tasks').all()).includes(secret), true)
    } finally {
      db.close()
    }

    const attempt = ledger.showTask(task.id, { events: 50 }).attempts[0]
    assert.equal(attempt?.summary, `summary ${REDACTED}`)
    assert.equal(attempt?.decisionQuestion, `question https://${REDACTED}@example.invalid ${REDACTED}`)
    assert.equal(attempt?.failureDetail, `detail ${REDACTED}`)
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 途中経過は 2 KiB に収めて秘密を置き換え、2000 件を超えると events.truncated を1件だけ書く', async () => {
  const { root, dataDir } = await makeDataDir()
  const secret = 'event-secret-0123456789'
  const ledger = openTaskLedger(dataDir, { secretValues: [secret] })

  try {
    const task = ledger.createTask(taskInput()).task
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)

    assert.equal(ledger.appendToolEvent(claimed.taskKey, 'tool.started', { tool: 'read', path: `/x/${secret}/${'p'.repeat(4000)}` }), 'written')
    const written = ledger.showTask(task.id, { events: 1 }).events[0]
    assert.equal(written?.type, 'tool.started')
    assert.equal(written?.data.tool, 'read')
    assert.ok(Buffer.byteLength(JSON.stringify(written?.data), 'utf8') <= 2048)
    assert.equal(JSON.stringify(written?.data).includes(secret), false)
    assert.ok(String(written?.data.path).startsWith(`/x/${REDACTED}/`))

    // run.* の event は上限に数えない
    ledger.appendRunResumed(claimed.taskKey)
    for (let index = 1; index < 2000; index += 1) {
      assert.equal(ledger.appendToolEvent(claimed.taskKey, index % 2 === 0 ? 'tool.started' : 'tool.finished', { tool: 'bash', isError: false }), 'written')
    }

    assert.equal(ledger.appendToolEvent(claimed.taskKey, 'tool.started', { tool: 'bash' }), 'truncated')
    assert.equal(ledger.appendToolEvent(claimed.taskKey, 'tool.finished', { tool: 'bash', isError: true }), 'dropped')
    assert.equal(ledger.appendToolEvent('task-999-1-aaaaaa', 'tool.started', { tool: 'bash' }), 'dropped')

    const types = eventTypes(ledger, task.id)
    assert.equal(types.filter((type) => type === 'tool.started' || type === 'tool.finished').length, 2000)
    assert.equal(types.filter((type) => type === 'events.truncated').length, 1)
    assert.equal(types.at(-1), 'events.truncated')
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: runner の行は heartbeat・stopped を自分の invocation のときだけ書き、heartbeat が 60 秒より前なら not_responding', async () => {
  const { root, dataDir } = await makeDataDir()
  let wall = Date.parse('2026-10-24T00:00:00.000Z')
  const ledger = openTaskLedger(dataDir, { now: () => new Date(wall) })
  const unit = 'araya-runner-000000000000.service'

  try {
    assert.deepEqual(ledger.readRunner(unit, wall), {
      unit, state: 'not_started', pid: null, startedAt: null, heartbeatAt: null, stoppedAt: null
    })

    ledger.markRunnerStarted({ unit, invocationId: 'inv-1', pid: 1234 })
    assert.deepEqual(ledger.readRunner('ignored.service', wall), {
      unit,
      state: 'running',
      pid: 1234,
      startedAt: '2026-10-24T00:00:00.000Z',
      heartbeatAt: '2026-10-24T00:00:00.000Z',
      stoppedAt: null
    })
    assert.equal(ledger.readRunner(unit, wall + 60_000).state, 'running')
    assert.equal(ledger.readRunner(unit, wall + 60_001).state, 'not_responding')

    ledger.createTask(taskInput())
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)

    wall += 30_000
    ledger.heartbeat('inv-other', [])
    assert.equal(ledger.readRunner(unit, wall).heartbeatAt, '2026-10-24T00:00:00.000Z')
    ledger.heartbeat('inv-1', [{ taskKey: claimed.taskKey, addMs: 1200.7 }])
    assert.equal(ledger.readRunner(unit, wall).heartbeatAt, '2026-10-24T00:00:30.000Z')
    ledger.settleActiveTime([{ taskKey: claimed.taskKey, addMs: 300 }])
    assert.equal(ledger.listRunningAttempts()[0]?.activeMs, 1500)

    ledger.markRunnerStopped('inv-other', [])
    assert.equal(ledger.readRunner(unit, wall).state, 'running')
    ledger.markRunnerStopped('inv-1', [{ taskKey: claimed.taskKey, addMs: 500 }])
    assert.deepEqual(ledger.readRunner(unit, wall + 120_000), {
      unit,
      state: 'stopped',
      pid: 1234,
      startedAt: '2026-10-24T00:00:00.000Z',
      heartbeatAt: '2026-10-24T00:00:30.000Z',
      stoppedAt: '2026-10-24T00:00:30.000Z'
    })
    assert.equal(ledger.listRunningAttempts()[0]?.activeMs, 2000)

    // 起動し直すと自分の行に書き換え、stopped_at を空にする
    ledger.markRunnerStarted({ unit, invocationId: 'inv-2', pid: 5678 })
    assert.equal(ledger.readRunner(unit, wall).state, 'running')
    assert.equal(ledger.readRunner(unit, wall).stoppedAt, null)
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ledger: 状態 directory はまだ記録されていないときだけ記録する', async () => {
  const { root, dataDir } = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const task = ledger.createTask(taskInput()).task
    const claimed = ledger.claimNextAttempt(1, settings())
    assert.ok(claimed)
    ledger.recordStateDir(claimed.taskKey, '/data/development/a')
    ledger.recordStateDir(claimed.taskKey, '/data/development/b')

    assert.equal(ledger.showTask(task.id, { events: 0 }).attempts[0]?.stateDir, '/data/development/a')
    assert.deepEqual(ledger.showTask(task.id, { events: 0 }).events, [])
  } finally {
    ledger.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
