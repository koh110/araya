import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { scopePattern } from '../src/systemd-units.ts'
import { AttemptsDoc } from '../src/task-attempt.ts'
import { findMarkedProcesses } from './support/fake-systemd.ts'
import { answer, toolCall } from './support/faux-shiki.ts'
import { ctx, waitUntil } from './support/runner-fixture.ts'
import {
  openLedger,
  parseLogLines,
  readRunnerLog,
  startRunner,
  teardownRunner,
  waitForTaskStatus,
  withTimeout,
  type RunnerSetup,
  type StartedRunner
} from './support/runner-loop.ts'
import {
  completingStep,
  createFailingStorage,
  createTasks,
  isAlive,
  isRecord,
  readEvents,
  readPid,
  records,
  setupWithRepository
} from './support/runner-scenarios.ts'

// runner の失敗の経路: pi-durable が止めた試行（restart_limit）、想定外の outcome（attempt_error）、storage の誤りで Harness が失敗で閉じたとき、
// 利用者の中止と結果の記録の順番、試行の scope を止められないとき、abortTask の失敗

const FINAL_STATUSES = ['completed', 'failed', 'blocked']

function eventsOf(setup: RunnerSetup, taskId: number, type: string) {
  return readEvents(setup.fixture).filter((event) => {
    return event.taskId === taskId && event.type === type
  })
}

function taskKeyOf(setup: RunnerSetup, taskId: number) {
  const ledger = openLedger(setup)

  try {
    const attempt = ledger.showTask(taskId, { events: 0 }).attempts.at(-1)

    if (attempt === undefined) {
      throw new Error(`Task ${taskId} has no attempt`)
    }

    return attempt.taskKey
  } finally {
    ledger.close()
  }
}

async function readLog(setup: RunnerSetup) {
  return parseLogLines(await readRunnerLog(setup.fixture))
}

// runner を止めた後に storage を開き、session の document（araya.attempts）を読む
async function readAttemptsDoc(setup: RunnerSetup) {
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(setup.fixture.dataDir, 'runner', 'durable.sqlite')), {
    models: setup.models.runtime,
    registry: createRegistry()
  }, ctx)

  try {
    return await harness.snapshot(AttemptsDoc, ctx)
  } finally {
    await harness.close(ctx)
  }
}

test('runner: restartLimit で止められた試行は blocked（restart_limit）で、待っていた次の試行が取り込まれる', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [first = 0, second = 0] = createTasks(setup, 2)
  const firstKey = taskKeyOf(setup, first)
  const storage = createFailingStorage()
  let injected = false
  // SHIKI が終わった後の agent の phase の commit で、storage の誤りを1回起こす（落ちたときと同じく restarts が1つ増える）
  const failingRunner = startRunner(setup, {
    restartLimit: 1,
    openStorage: storage.open,
    faults: {
      beforePhaseCommit: (phase, taskKey) => {
        if (phase === 'agent' && taskKey === firstKey && !injected) {
          injected = true
          storage.inject.armed = true
        }
      }
    }
  })
  let runner: StartedRunner = failingRunner

  try {
    assert.equal(await failingRunner.done, 1)
    assert.equal(storage.inject.hits, 1)
    const ledger = openLedger(setup)

    try {
      assert.equal(ledger.getTask(first).status, 'running')
      assert.equal(ledger.getTask(second).status, 'queued')
    } finally {
      ledger.close()
    }

    runner = startRunner(setup, { restartLimit: 1 })
    const blocked = await waitForTaskStatus(setup, first, FINAL_STATUSES)
    const attempt = blocked.attempts[0]

    assert.equal(blocked.task.status, 'blocked')
    assert.equal(attempt?.failureReason, 'restart_limit')
    assert.equal(attempt?.stopReason, 'restart_limit')
    assert.equal(attempt?.evidence?.bodiesStored, false)
    assert.deepEqual(eventsOf(setup, first, 'run.stopping').map((event) => event.data), [{ reason: 'restart_limit' }])
    assert.deepEqual(eventsOf(setup, first, 'run.finished').map((event) => event.data), [{ status: 'blocked', failureReason: 'restart_limit' }])
    // 起動し直した runner の、開き直したときの確認で見つけた
    const reconciled = (await readLog(setup)).filter((entry) => entry.type === 'reconciled').at(-1)
    assert.ok(records(reconciled?.blocked).some((entry) => entry.taskKey === firstKey && entry.reason === 'restart_limit'))

    // 待っていた次の試行が取り込まれて終わる
    assert.equal((await waitForTaskStatus(setup, second, FINAL_STATUSES)).task.status, 'completed')
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: phase が例外を投げて想定外の outcome で終わった試行は attempt_error で、failure_detail に outcome の status が入る', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup, {
    faults: {
      beforePhaseCommit: (phase) => {
        if (phase === 'evidence') {
          throw new Error('injected phase failure')
        }
      }
    }
  })

  try {
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'attempt_error')
    assert.match(attempt?.failureDetail ?? '', /^faulted: .*injected phase failure/u)
    assert.equal(attempt?.model, null)
    const evidence = attempt?.evidence ?? {}
    assert.equal(evidence.failureReason, 'attempt_error')
    assert.equal(evidence.bodiesStored, false)
    assert.deepEqual(records(evidence.worktrees).map((worktree) => Object.keys(worktree).sort()), [['branch', 'worktreePath']])
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'attempt_error' }])
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 試行の task の phase の commit が失敗すると 1 で終わり、試行は running のまま、起動し直すと続きから進んで終わる', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const storage = createFailingStorage()
  let injected = false
  const failingRunner = startRunner(setup, {
    openStorage: storage.open,
    faults: {
      beforePhaseCommit: (phase) => {
        if (phase === 'agent' && !injected) {
          injected = true
          storage.inject.armed = true
        }
      }
    }
  })
  let runner: StartedRunner = failingRunner

  try {
    assert.equal(await failingRunner.done, 1)
    assert.equal(storage.inject.hits, 1)
    const ledger = openLedger(setup)

    try {
      const shown = ledger.showTask(taskId, { events: 500 })
      const attempt = shown.attempts[0]
      // attempt_error にせず、running のまま残す。runner の行も変えない
      assert.equal(shown.task.status, 'running')
      assert.equal(attempt?.stopReason, null)
      assert.equal(attempt?.failureReason, null)
      assert.deepEqual(shown.events.filter((event) => event.type === 'run.stopping' || event.type === 'run.finished'), [])
      assert.equal(ledger.readRunner('', Date.now()).state, 'running')
    } finally {
      ledger.close()
    }

    // 閉じ終わった後に dataDir の scope を止めた
    const lastStop = setup.systemd.records().filter((record) => record.type === 'stop' || record.type === 'stop_failed').at(-1)
    assert.deepEqual(lastStop?.type === 'stop' ? lastStop.pattern : null, scopePattern(setup.fixture.hash))
    const log = await readLog(setup)
    assert.ok(log.some((entry) => entry.type === 'harness_failed'))
    assert.equal(log.some((entry) => entry.type === 'attempt_task_create_failed' || entry.type === 'unexpected_error'), false)

    runner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)

    assert.equal(shown.task.status, 'completed')
    assert.equal(shown.attempts[0]?.evidence?.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: onReport の message は秘密を置き換えてから 2000 文字で切り、URL の userinfo と秘密の値が境界をまたいでも log に一部も残らない', async () => {
  const secret = 'Pf5gT9sK1dM4hQ7z'
  // log の message は 2000 文字で切る。その境界を、userinfo の @ の前と、秘密の値の途中に置く
  const messages = [
    `${'x'.repeat(2000 - 'https://user:pass'.length)}https://user:pass@example.invalid/repo.git`,
    `${'y'.repeat(2000 - 6)}${secret} remains`
  ]

  for (const message of messages) {
    const setup = await setupWithRepository({ env: { ARAYA_TEST_TOKEN: secret } })
    setup.models.script((view) => {
      return completingStep(view)
    })
    createTasks(setup, 1)
    const storage = createFailingStorage(message)
    const runner = startRunner(setup, {
      openStorage: storage.open,
      faults: {
        beforePhaseCommit: (phase) => {
          if (phase === 'agent' && storage.inject.hits === 0) {
            storage.inject.armed = true
          }
        }
      }
    })

    try {
      assert.equal(await runner.done, 1)
      const text = await readRunnerLog(setup.fixture)
      const reports = parseLogLines(text).filter((entry) => entry.type === 'report' && entry.report === 'session_failed')

      assert.equal(reports.length, 1)
      assert.equal(String(reports[0]?.message).length, 2000)
      assert.equal(text.includes('user:pass'), false)
      assert.equal(text.includes(secret.slice(0, 6)), false)
    } finally {
      await teardownRunner(setup, runner)
    }
  }
})

test('runner: 取り込みの後の createTask の commit が失敗すると 1 で終わり、起動し直すと試行の task を1つだけ作って終わる', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  // 1件目で root の会話を作らせ、2件目の取り込みの後の commit（createTask）を失敗させる
  const [first = 0, second = 0] = createTasks(setup, 2)
  const secondKey = taskKeyOf(setup, second)
  const storage = createFailingStorage()
  const failingRunner = startRunner(setup, {
    openStorage: storage.open,
    faults: {
      afterClaimCommit: (taskKey) => {
        if (taskKey === secondKey) {
          storage.inject.armed = true
        }
      }
    }
  })
  let runner: StartedRunner = failingRunner

  try {
    assert.equal(await failingRunner.done, 1)
    assert.equal(storage.inject.hits, 1)
    const ledger = openLedger(setup)

    try {
      assert.equal(ledger.getTask(first).status, 'completed')
      assert.equal(ledger.getTask(second).status, 'running')
      assert.equal(ledger.readStop(secondKey).stopReason, null)
    } finally {
      ledger.close()
    }

    const log = await readLog(setup)
    assert.ok(log.some((entry) => entry.type === 'harness_failed'))
    // Harness が閉じ始めた後の失敗は、task の作成の失敗として扱わない
    assert.equal(log.some((entry) => entry.type === 'attempt_task_create_failed'), false)

    runner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, second, FINAL_STATUSES)
    assert.equal(shown.task.status, 'completed')
    assert.equal(eventsOf(setup, second, 'run.finished').length, 1)
    const reconciled = (await readLog(setup)).filter((entry) => entry.type === 'reconciled').at(-1)
    assert.deepEqual(reconciled?.created, [secondKey])

    assert.equal(await runner.stop(), 0)
    const attempts = await readAttemptsDoc(setup)
    // 試行の task と会話は、試行ごとに1つだけ
    assert.equal(Object.keys(attempts?.byTaskKey ?? {}).length, 2)
    assert.deepEqual(Object.values(attempts?.byConversation ?? {}).map((entry) => entry.taskKey).filter((key) => key === secondKey), [secondKey])
  } finally {
    await teardownRunner(setup, runner)
  }
})

function assertCancelledWithResultBefore(shown: Awaited<ReturnType<typeof waitForTaskStatus>>) {
  const attempt = shown.attempts[0]
  const evidence = attempt?.evidence ?? {}

  assert.equal(shown.task.status, 'failed')
  assert.equal(attempt?.status, 'failed')
  assert.equal(attempt?.failureReason, 'cancelled')
  assert.equal(attempt?.failureDetail, null)
  assert.equal(evidence.outcome, 'failed')
  assert.equal(evidence.failureReason, 'cancelled')
  assert.deepEqual(evidence.resultBeforeCancel, { status: 'completed', failureReason: null, failureDetail: null })
  // 試行の task が集めた差分と検証の結果は残す
  assert.equal(evidence.bodiesStored, true)
  const verification = records(records(evidence.worktrees)[0]?.verifications)[0]
  assert.equal(verification?.status, 'passed')
  assert.equal(attempt?.summary, `${attempt?.taskKey ?? ''} の作業を終えました`)
  assert.deepEqual(shown.events.filter((event) => event.type === 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'cancelled' }])
}

test('runner: 試行の task が outcome を commit した後、記録の前の中止は requested で、abortTask は terminal を返し、結果は cancelled で resultBeforeCancel が残る', async () => {
  // 記録の前の1回だけ、その試行の scope を止められなくして、中止の求めを次の loop の中止の確認で見つけさせる
  const blocked = new Set<string>()
  const setup = await setupWithRepository({
    systemd: {
      failStop: (pattern) => {
        return blocked.has(pattern)
      }
    }
  })
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const ledger = openLedger(setup)
  const cancels: string[] = []
  let recordCalls = 0
  const runner = startRunner(setup, {
    faults: {
      beforeRecordResult: (taskKey) => {
        recordCalls += 1

        if (recordCalls === 1) {
          cancels.push(ledger.cancelTask(taskId).cancel)
          blocked.add(scopePattern(setup.fixture.hash, taskKey))
        } else {
          blocked.clear()
        }
      }
    }
  })

  try {
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const taskKey = shown.attempts[0]?.taskKey

    assert.deepEqual(cancels, ['requested'])
    assertCancelledWithResultBefore(shown)
    assert.equal(shown.attempts[0]?.stopReason, 'cancelled')
    const log = await readLog(setup)
    assert.deepEqual(log.filter((entry) => entry.type === 'attempt_abort' && entry.taskKey === taskKey).map((entry) => entry.result), ['terminal'])

    // 結果を記録した後の中止は拒否する
    assert.throws(() => ledger.cancelTask(taskId), { code: 'task_not_cancellable' })
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

test('runner: loop が中止の求めを確かめた後、結果を記録する前に中止を求めても cancelled になる', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const ledger = openLedger(setup)
  const checked = new Set<string>()
  const cancels: string[] = []
  const runner = startRunner(setup, {
    faults: {
      afterCancelCheck: (taskKey) => {
        checked.add(taskKey)
      },
      // 同じ loop の中止の確認（手順 3）の後、記録（手順 6）の前
      beforeRecordResult: (taskKey) => {
        assert.ok(checked.has(taskKey))
        cancels.push(ledger.cancelTask(taskId).cancel)
      }
    }
  })

  try {
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const taskKey = shown.attempts[0]?.taskKey

    assert.deepEqual(cancels, ['requested'])
    assertCancelledWithResultBefore(shown)
    // runner は中止を始めていない（記録の transaction で中止の求めを見つけた）
    assert.equal(shown.attempts[0]?.stopReason, null)
    assert.deepEqual(eventsOf(setup, taskId, 'run.stopping'), [])
    assert.equal((await readLog(setup)).some((entry) => entry.type === 'attempt_abort' && entry.taskKey === taskKey), false)
    assert.throws(() => ledger.cancelTask(taskId), { code: 'task_not_cancellable' })
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

test('runner: 記録の前に試行の scope を止められなければ running のまま枠を使い続け、止められるようになると記録する', async () => {
  let blocking = false
  let blockedPattern = ''
  const setup = await setupWithRepository({
    systemd: {
      failStop: (pattern) => {
        return blocking && pattern === blockedPattern
      }
    }
  })
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [first = 0, second = 0] = createTasks(setup, 2)
  const firstKey = taskKeyOf(setup, first)
  const runner = startRunner(setup, {
    faults: {
      beforeRecordResult: (taskKey) => {
        if (taskKey === firstKey && blockedPattern === '') {
          blockedPattern = scopePattern(setup.fixture.hash, taskKey)
          blocking = true
        }
      }
    }
  })
  const ledger = openLedger(setup)

  try {
    // 記録をやり直し続ける間、結果は記録されず、枠も空かない
    await waitUntil(async () => {
      return (await readLog(setup)).filter((entry) => entry.type === 'scope_stop_failed' && entry.taskKey === firstKey).length >= 3
    }, 'scope_stop_failed is retried')
    assert.equal(ledger.getTask(first).status, 'running')
    assert.equal(ledger.getTask(second).status, 'queued')
    assert.deepEqual(ledger.queueView(1), { limit: 1, running: 1, queued: 1 })
    assert.deepEqual(eventsOf(setup, first, 'run.finished'), [])

    blocking = false
    assert.equal((await waitForTaskStatus(setup, first, FINAL_STATUSES)).task.status, 'completed')
    assert.equal((await waitForTaskStatus(setup, second, FINAL_STATUSES)).task.status, 'completed')
    const order = readEvents(setup.fixture).flatMap((event) => {
      return event.type === 'run.started' || event.type === 'run.finished' ? [`${event.type}:${event.taskId}`] : []
    })
    assert.deepEqual(order, [`run.started:${first}`, `run.finished:${first}`, `run.started:${second}`, `run.finished:${second}`])
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

test('runner: 結果を記録する前の scope の停止の最中に止めるように求めると、記録せずに running のまま 0 で終わり、active_ms は求めた時点まで、起動し直すと記録する', async () => {
  let recording: string | null = null
  let runner: StartedRunner | undefined
  const setup = await setupWithRepository({
    systemd: {
      // 記録の前の scope の停止の最中に、1.5 秒たった時点で止めるように求め、その後さらに 5 秒進める
      beforeStop: (pattern) => {
        if (recording !== null && pattern === scopePattern(setup.fixture.hash, recording) && runner !== undefined) {
          recording = null
          setup.clock.advance(1500)
          runner.controller.abort()
          setup.clock.advance(5000)
        }
      }
    }
  })
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  runner = startRunner(setup, {
    faults: {
      beforeRecordResult: (taskKey) => {
        recording = taskKey
      }
    }
  })

  try {
    assert.equal(await withTimeout(runner.done, 'runner stop'), 0)
    const ledger = openLedger(setup)

    try {
      const shown = ledger.showTask(taskId, { events: 500 })
      const attempt = shown.attempts[0]
      // 結果は記録せず、試行は running のまま。稼働時間は止めるように求めた時点まで
      assert.equal(shown.task.status, 'running')
      assert.equal(attempt?.status, 'running')
      assert.equal(attempt?.activeMs, 1500)
      assert.equal(attempt?.stopReason, null)
      assert.deepEqual(shown.events.filter((event) => event.type === 'run.finished'), [])
      assert.equal(ledger.readRunner('', Date.now()).state, 'stopped')
    } finally {
      ledger.close()
    }

    const log = await readLog(setup)
    assert.equal(log.some((entry) => entry.type === 'attempt_finished'), false)

    // 起動し直すと、待ち直して記録する
    runner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)

    assert.equal(shown.task.status, 'completed')
    assert.equal(shown.attempts[0]?.activeMs, 1500)
    assert.equal(shown.attempts[0]?.evidence?.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 結果を記録する前の scope の停止の最中に Harness が失敗で閉じ始めると、記録せずに 1 で終わり、active_ms は閉じ始めた時点まで、起動し直すと記録する', async () => {
  let recording: string | null = null
  const storage = createFailingStorage()
  const setup = await setupWithRepository({
    systemd: {
      // 記録の前の scope の停止の最中に、1.5 秒たった時点で、もう1つの試行の commit を失敗させて Harness を閉じさせ、その後さらに 5 秒進める
      beforeStop: async (pattern) => {
        if (recording === null || pattern !== scopePattern(setup.fixture.hash, recording)) {
          return
        }

        recording = null
        setup.clock.advance(1500)
        storage.inject.armed = true
        await fs.writeFile(release, '', 'utf8')
        await waitUntil(async () => {
          return (await readLog(setup)).some((entry) => entry.type === 'report' && entry.report === 'session_failed')
        }, 'the harness fails')
        setup.clock.advance(5000)
      }
    }
  })
  const release = path.join(setup.fixture.root, 'release')
  const [recordedId = 0, otherId = 0] = createTasks(setup, 2)
  setup.models.script((view) => {
    // 2件目は、1件目の記録の前の scope の停止の最中に release が書かれるまで bash で待つ
    if (view.taskKey.startsWith(`task-${otherId}-`)) {
      return view.toolResults.length === 0
        ? toolCall('bash', { command: `while [ ! -f ${release} ]; do sleep 0.05; done` })
        : answer('待ち終えました')
    }

    return completingStep(view)
  })
  let runner = startRunner(setup, {
    maxConcurrent: 2,
    openStorage: storage.open,
    faults: {
      beforeRecordResult: (taskKey) => {
        if (taskKey.startsWith(`task-${recordedId}-`)) {
          recording = taskKey
        }
      }
    }
  })

  try {
    assert.equal(await withTimeout(runner.done, 'runner exit'), 1)
    assert.equal(storage.inject.hits, 1)
    const ledger = openLedger(setup)

    try {
      const shown = ledger.showTask(recordedId, { events: 500 })
      const attempt = shown.attempts[0]
      // 結果は記録せず、試行は running のまま。稼働時間は閉じ始めた時点まで。runner の行は変えない
      assert.equal(shown.task.status, 'running')
      assert.equal(attempt?.status, 'running')
      assert.equal(attempt?.activeMs, 1500)
      assert.deepEqual(shown.events.filter((event) => event.type === 'run.finished'), [])
      assert.equal(ledger.readRunner('', Date.now()).state, 'running')
    } finally {
      ledger.close()
    }

    const log = await readLog(setup)
    assert.ok(log.some((entry) => entry.type === 'harness_failed'))
    assert.equal(log.some((entry) => entry.type === 'attempt_finished'), false)

    // 起動し直すと、待ち直して記録する
    runner = startRunner(setup, { maxConcurrent: 2 })
    const shown = await waitForTaskStatus(setup, recordedId, FINAL_STATUSES)
    await waitForTaskStatus(setup, otherId, FINAL_STATUSES)

    assert.equal(shown.task.status, 'completed')
    assert.equal(shown.attempts[0]?.activeMs, 1500)
    assert.equal(eventsOf(setup, recordedId, 'run.finished').length, 1)
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 開き直したときの確認の最中に止めるように求めると、それ以降の中止を始めずに 0 で終わり、起動し直すと残りを中止する', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return view.toolResults.length === 0 ? toolCall('bash', { command: 'sleep 30' }) : answer('終えました')
  })
  const taskIds = createTasks(setup, 2)
  let runner = startRunner(setup, { maxConcurrent: 2 })

  try {
    await waitUntil(() => {
      return setup.systemd.launches().length >= 2
    }, 'two bash commands start')
    assert.equal(await runner.stop(), 0)
    const ledger = openLedger(setup)

    try {
      assert.deepEqual(taskIds.map((taskId) => ledger.cancelTask(taskId).cancel), ['requested', 'requested'])
    } finally {
      ledger.close()
    }

    // 開き直したときの確認で、1件目の中止を始めた直後に止めるように求める
    let restarted: StartedRunner | undefined
    const aborted: string[] = []
    restarted = startRunner(setup, {
      maxConcurrent: 2,
      faults: {
        beforeAbortTask: (taskKey) => {
          aborted.push(taskKey)
          restarted?.controller.abort()
        }
      }
    })
    runner = restarted
    assert.equal(await withTimeout(restarted.done, 'runner stop'), 0)
    assert.equal(aborted.length, 1)
    const stopReasons = taskIds.map((taskId) => {
      const view = openLedger(setup)

      try {
        return view.showTask(taskId, { events: 0 }).attempts[0]?.stopReason ?? null
      } finally {
        view.close()
      }
    })
    // 止めるように求められた後は、2件目の中止を始めない
    assert.equal(stopReasons.filter((reason) => reason === 'cancelled').length, 1)
    assert.equal(stopReasons.filter((reason) => reason === null).length, 1)
    assert.equal((await readLog(setup)).filter((entry) => entry.type === 'attempt_stopping').length, 1)

    runner = startRunner(setup, { maxConcurrent: 2 })

    for (const taskId of taskIds) {
      const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
      assert.equal(shown.task.status, 'failed')
      assert.equal(shown.attempts[0]?.failureReason, 'cancelled')
    }
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 開き直したときの確認で台帳に無い試行の task を中止している最中に Harness が失敗で閉じ始めると、それ以降の中止を始めずに 1 で終わり、起動し直すと残りを中止する', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return view.toolResults.length === 0 ? toolCall('bash', { command: 'sleep 30' }) : answer('終えました')
  })
  createTasks(setup, 2)
  let runner = startRunner(setup, { maxConcurrent: 2 })

  try {
    await waitUntil(() => {
      return setup.systemd.launches().length >= 2
    }, 'two bash commands start')
    assert.equal(await runner.stop(), 0)
    // 台帳を作り直すと、2つの試行の task は台帳に無い（開き直したときの確認で、台帳に何も書かずに中止する）
    for (const name of ['tasks.sqlite', 'tasks.sqlite-wal', 'tasks.sqlite-shm']) {
      await fs.rm(path.join(setup.fixture.dataDir, name), { force: true })
    }

    // 1件目の abortTask の commit を失敗させ、Harness を閉じさせる
    const logBefore = (await readLog(setup)).length
    const storage = createFailingStorage()
    const aborted: string[] = []
    runner = startRunner(setup, {
      maxConcurrent: 2,
      openStorage: storage.open,
      faults: {
        beforeAbortTask: (taskKey) => {
          aborted.push(taskKey)
          storage.inject.armed = true
        }
      }
    })
    assert.equal(await withTimeout(runner.done, 'runner exit'), 1)
    assert.equal(storage.inject.hits, 1)
    // Harness が閉じ始めた後は、2件目の中止を始めない
    assert.equal(aborted.length, 1)
    const log = (await readLog(setup)).slice(logBefore)
    assert.ok(log.some((entry) => entry.type === 'harness_failed'))
    assert.equal(log.some((entry) => entry.type === 'reconciled'), false)

    // 起動し直すと、2件とも中止する（失敗した commit は記録されていない）
    const logBeforeRestart = (await readLog(setup)).length
    const restartedAborts: string[] = []
    runner = startRunner(setup, {
      maxConcurrent: 2,
      faults: {
        beforeAbortTask: (taskKey) => {
          restartedAborts.push(taskKey)
        }
      }
    })
    await waitUntil(async () => {
      return (await readLog(setup)).slice(logBeforeRestart).some((entry) => entry.type === 'reconciled')
    }, 'the restarted runner reconciles')
    assert.equal(restartedAborts.length, 2)
    assert.ok(restartedAborts.includes(aborted[0] ?? ''))
    assert.equal(await runner.stop(), 0)
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: evidence の phase の始めに試行の scope を止められなければ、差分の収集と検証を行わずに termination_unconfirmed になる', async () => {
  let armedPattern = ''
  const setup = await setupWithRepository({
    systemd: {
      // その試行の scope の最初の停止（evidence の phase の始め）だけを失敗させる
      failStop: (pattern) => {
        if (pattern !== armedPattern) {
          return false
        }

        armedPattern = ''

        return true
      }
    }
  })
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  armedPattern = scopePattern(setup.fixture.hash, taskKeyOf(setup, taskId))
  const runner = startRunner(setup)

  try {
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]
    const evidence = attempt?.evidence ?? {}

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'termination_unconfirmed')
    assert.equal(evidence.bodiesStored, false)
    assert.deepEqual(records(evidence.worktrees).map((worktree) => Object.keys(worktree).sort()), [['branch', 'worktreePath']])
    // SHIKI の終わり方は evidence に残る
    assert.ok(isRecord(evidence.agent))
    // 失敗した停止の後に、差分の収集の git も検証のコマンドも起動しない
    const all = setup.systemd.records()
    const failedAt = all.findIndex((record) => record.type === 'stop_failed')
    assert.ok(failedAt >= 0)
    assert.deepEqual(all.slice(failedAt).filter((record) => record.type === 'launch'), [])
    assert.equal(setup.systemd.launches().some((launch) => launch.unit.includes('-verify-')), false)
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'termination_unconfirmed' }])
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: abortTask が失敗すると log に書き、Harness を閉じて scope を止め、稼働時間を精算して 1 で終わり、起動し直すと abortTask を呼び直して cancelled になる', async () => {
  const setup = await setupWithRepository()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  setup.models.script((view) => {
    switch (view.toolResults.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1:
        return toolCall('bash', { command: `echo $$ > ${pidFile}; sleep 30` })
      default:
        return answer('中止されずに終わりました')
    }
  })
  const [taskId = 0] = createTasks(setup, 1)
  const taskKey = taskKeyOf(setup, taskId)
  let abortFailures = 0
  const failingRunner = startRunner(setup, {
    faults: {
      // 最初の abortTask だけを失敗させる
      beforeAbortTask: () => {
        if (abortFailures === 0) {
          abortFailures += 1
          throw new Error('injected abortTask failure')
        }
      }
    }
  })
  let runner: StartedRunner = failingRunner

  try {
    const bashPid = await readPid(pidFile)
    // 取り込みから 1.5 秒動かしてから中止を求める
    setup.clock.advance(1500)
    const cancelling = openLedger(setup)

    try {
      assert.equal(cancelling.cancelTask(taskId).cancel, 'requested')
    } finally {
      cancelling.close()
    }

    assert.equal(await withTimeout(failingRunner.done, 'runner exit after the abortTask failure'), 1)
    assert.equal(abortFailures, 1)
    const ledger = openLedger(setup)

    try {
      const shown = ledger.showTask(taskId, { events: 500 })
      const attempt = shown.attempts[0]
      // stop_reason は書かれ、試行は running のまま。稼働時間は今の時点まで精算し、runner の行は変えない
      assert.equal(shown.task.status, 'running')
      assert.equal(attempt?.stopReason, 'cancelled')
      assert.equal(attempt?.failureReason, null)
      assert.equal(attempt?.activeMs, 1500)
      assert.equal(eventsOf(setup, taskId, 'run.stopping').length, 1)
      assert.equal(eventsOf(setup, taskId, 'run.finished').length, 0)
      assert.equal(ledger.readRunner('', Date.now()).state, 'running')
    } finally {
      ledger.close()
    }

    // Harness を閉じ、dataDir の scope を止めた
    assert.equal(isAlive(bashPid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(setup.fixture.hash)), [])
    const lastStop = setup.systemd.records().filter((record) => record.type === 'stop' || record.type === 'stop_failed').at(-1)
    assert.deepEqual(lastStop?.type === 'stop' ? lastStop.pattern : null, scopePattern(setup.fixture.hash))
    const failedLog = await readLog(setup)
    const abortFailed = failedLog.filter((entry) => entry.type === 'attempt_abort_failed')
    assert.equal(abortFailed.length, 1)
    assert.equal(abortFailed[0]?.taskKey, taskKey)
    assert.match(String(abortFailed[0]?.message), /injected abortTask failure/u)
    assert.equal(failedLog.some((entry) => entry.type === 'harness_failed' || entry.type === 'unexpected_error' || entry.type === 'runner_stopped'), false)
    const linesBeforeRestart = failedLog.length

    // 起動し直した runner は、開き直したときの確認で abortTask をもう一度呼び、試行は中止の理由どおりに終わる
    runner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'cancelled')
    assert.equal(eventsOf(setup, taskId, 'run.stopping').length, 1)
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'cancelled' }])
    const restartedLog = (await readLog(setup)).slice(linesBeforeRestart)
    const abortIndex = restartedLog.findIndex((entry) => entry.type === 'attempt_abort' && entry.taskKey === taskKey)
    const reconciledIndex = restartedLog.findIndex((entry) => entry.type === 'reconciled')
    assert.ok(abortIndex >= 0)
    assert.equal(restartedLog[abortIndex]?.result, 'marked')
    assert.ok(abortIndex < reconciledIndex, `${abortIndex} < ${reconciledIndex}`)
    // stop_reason は書かれているので、中止を始め直さずに abortTask だけを呼ぶ
    assert.equal(restartedLog.some((entry) => entry.type === 'attempt_stopping'), false)
  } finally {
    await teardownRunner(setup, runner)
  }
})
