import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { scopePattern } from '../src/infrastructure/systemd.ts'
import { answer, toolCall, worktreePathFrom, type FauxView } from './support/faux-shiki.ts'
import { findMarkedProcesses } from './support/fake-systemd.ts'
import { taskInput, waitUntil, type RunnerFixture } from './support/runner-fixture.ts'
import {
  openLedger,
  parseLogLines,
  readRunnerLog,
  startRunner,
  teardownRunner,
  waitForTaskStatus,
  type RunnerSetup,
  type StartedRunner
} from './support/runner-loop.ts'
import {
  completingStep,
  createLoopCounter,
  createTasks,
  isAlive,
  isRecord,
  PASS_COMMAND,
  readEvents,
  readPid,
  records,
  setupWithRepository
} from './support/runner-scenarios.ts'

// 期限（稼働時間で数える timeoutMs）と、SHIKI の終わりの記録と期限による中止の順番の test。時計は差し替えて test から進める

const TIMEOUT_MS = 5000
const FINAL_STATUSES = ['completed', 'failed', 'blocked']

function setupWithTimeout() {
  return setupWithRepository({ env: { ARAYA_DEVELOPMENT_TIMEOUT_MS: String(TIMEOUT_MS) } })
}

function eventsOf(setup: RunnerSetup, taskId: number, type: string) {
  return readEvents(setup.fixture).filter((event) => {
    return event.taskId === taskId && event.type === type
  })
}

function readActiveMs(fixture: RunnerFixture, taskKey: string) {
  const db = new DatabaseSync(path.join(fixture.dataDir, 'tasks.sqlite'))

  try {
    return Number(db.prepare('SELECT active_ms FROM runs WHERE task_key = ?').get(taskKey)?.active_ms)
  } finally {
    db.close()
  }
}

function firstAttempt(setup: RunnerSetup, taskId: number) {
  const ledger = openLedger(setup)

  try {
    const attempt = ledger.showTask(taskId, { events: 0 }).attempts[0]

    if (attempt === undefined) {
      throw new Error(`Task ${taskId} has no attempt`)
    }

    return attempt
  } finally {
    ledger.close()
  }
}

// worktree を作り、検証を登録し、worktree を変えてから bash で待ち続ける SHIKI（期限まで終わらない）
function hangingStep(view: FauxView, pidFile: string) {
  const results = view.toolResults

  switch (results.length) {
    case 0:
      return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
    case 1:
      return toolCall('araya_register_verification', { repository: 'repo', command: [...PASS_COMMAND] })
    case 2:
      return toolCall('bash', { command: `printf 'changed\\n' >> ${worktreePathFrom(results[0])}/README.md; echo $$ > ${pidFile}; sleep 30` })
    default:
      return answer('終わりました')
  }
}

async function readEvidenceFile(stateDir: string | null) {
  const value: unknown = JSON.parse(await fs.readFile(path.join(stateDir ?? '', 'evidence.json'), 'utf8'))

  return isRecord(value) ? value : {}
}

test('runner: 稼働時間で timeoutMs を過ぎると agent_timeout になり、差分を集め、検証は not_run、bash の process group は止まる', async () => {
  const setup = await setupWithTimeout()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  setup.models.script((view) => {
    return hangingStep(view, pidFile)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)

  try {
    const bashPid = await readPid(pidFile)
    assert.equal(firstAttempt(setup, taskId).stopReason, null)
    const launchesBeforeTimeout = setup.systemd.launches().length
    setup.clock.advance(TIMEOUT_MS)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'agent_timeout')
    assert.equal(attempt?.stopReason, 'agent_timeout')
    assert.equal(attempt?.agentFinishedAt, null)
    assert.equal(attempt?.activeMs, TIMEOUT_MS)
    // 実行中だった bash の process group は止まる
    assert.equal(isAlive(bashPid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(setup.fixture.hash)), [])

    const evidence = attempt?.evidence ?? {}
    assert.equal(evidence.outcome, 'failed')
    assert.equal(evidence.failureReason, 'agent_timeout')
    assert.ok(isRecord(evidence.agent))
    assert.equal(evidence.agent.error, 'agent_timeout')
    assert.equal(evidence.bodiesStored, true)
    const worktree = records(evidence.worktrees)[0]
    const verification = records(worktree?.verifications)[0]
    assert.equal(verification?.status, 'not_run')
    assert.equal(verification?.reason, 'agent_timeout')
    // 差分は集める（evidence.json の本文）。検証のコマンドは起動しない
    const evidenceFile = await readEvidenceFile(attempt?.stateDir ?? null)
    assert.match(String(records(evidenceFile.worktrees)[0]?.diff), /\+changed/u)
    const launchesAfterTimeout = setup.systemd.launches().slice(launchesBeforeTimeout)
    assert.ok(launchesAfterTimeout.some((launch) => launch.unit.includes('-git-')))
    assert.equal(launchesAfterTimeout.some((launch) => launch.unit.includes('-verify-')), false)

    assert.deepEqual(eventsOf(setup, taskId, 'run.stopping').map((event) => event.data), [{ reason: 'agent_timeout' }])
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'agent_timeout' }])
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 止まっていた時間は期限に数えず、timeoutMs より長く止めてから起動し直しても期限で中止されない', async () => {
  const setup = await setupWithTimeout()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  setup.models.script((view) => {
    const results = view.toolResults

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1:
        return toolCall('bash', { command: `echo $$ > ${pidFile}; sleep 30` })
      case 2:
        return toolCall('bash', { command: `printf 'changed\\n' >> ${worktreePathFrom(results[0])}/README.md` })
      case 3:
        return toolCall('araya_register_verification', { repository: 'repo', command: [...PASS_COMMAND] })
      default:
        return answer('再開して終わりました')
    }
  })
  const [taskId = 0] = createTasks(setup, 1)
  const firstRunner = startRunner(setup)
  let secondRunner: StartedRunner | undefined

  try {
    await readPid(pidFile)
    setup.clock.advance(1000)
    assert.equal(await firstRunner.stop(), 0)
    const taskKey = firstAttempt(setup, taskId).taskKey
    assert.equal(readActiveMs(setup.fixture, taskKey), 1000)

    // runner が止まっている間に、timeoutMs より長い時間がたつ
    setup.clock.advance(TIMEOUT_MS * 12)
    secondRunner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'completed')
    assert.equal(attempt?.stopReason, null)
    assert.equal(attempt?.activeMs, 1000)
    assert.equal(attempt?.evidence?.resumes, 1)
    assert.deepEqual(eventsOf(setup, taskId, 'run.stopping'), [])
  } finally {
    await teardownRunner(setup, secondRunner ?? firstRunner)
  }
})

test('runner: 起動時に active_ms が timeoutMs 以上の試行は、resume の前に中止を始め、その試行の model を呼ばない', async () => {
  const setup = await setupWithTimeout()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  setup.models.script((view) => {
    return hangingStep(view, pidFile)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const firstRunner = startRunner(setup)
  let secondRunner: StartedRunner | undefined

  try {
    await readPid(pidFile)
    assert.equal(await firstRunner.stop(), 0)
    const taskKey = firstAttempt(setup, taskId).taskKey
    // 前の process が精算した稼働時間が timeoutMs に達している状態にする
    const db = new DatabaseSync(path.join(setup.fixture.dataDir, 'tasks.sqlite'))

    try {
      db.prepare('UPDATE runs SET active_ms = ? WHERE task_key = ?').run(TIMEOUT_MS, taskKey)
    } finally {
      db.close()
    }

    const callsBeforeRestart = setup.models.faux.state.callCount
    const logLinesBeforeRestart = parseLogLines(await readRunnerLog(setup.fixture)).length
    secondRunner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'agent_timeout')
    assert.equal(attempt?.stopReason, 'agent_timeout')
    // 再開した会話は model を呼ばない
    assert.equal(setup.models.faux.state.callCount, callsBeforeRestart)
    // 開き直したときの確認（resume() の前）の中で中止を始めた
    const log = parseLogLines(await readRunnerLog(setup.fixture)).slice(logLinesBeforeRestart).map((entry) => entry.type)
    const stopping = log.indexOf('attempt_stopping')
    assert.ok(stopping >= 0, JSON.stringify(log))
    assert.ok(stopping < log.indexOf('reconciled'), JSON.stringify(log))
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'agent_timeout' }])
  } finally {
    await teardownRunner(setup, secondRunner ?? firstRunner)
  }
})

test('runner: SHIKI の終わりの記録が期限より先なら、期限を過ぎても検証まで進む', async () => {
  const setup = await setupWithTimeout()
  const loops = createLoopCounter()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup, {
    faults: {
      afterCancelCheck: loops.afterCancelCheck,
      // SHIKI の終わりを記録した後、agent の phase の commit の前に期限を過ぎさせ、loop が期限を確かめるのを待つ
      beforePhaseCommit: async (phase) => {
        if (phase === 'agent') {
          setup.clock.advance(TIMEOUT_MS * 2)
          await loops.waitForLoops(3)
        }
      }
    }
  })

  try {
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'completed')
    assert.equal(attempt?.stopReason, null)
    assert.notEqual(attempt?.agentFinishedAt, null)
    assert.ok(Number(attempt?.activeMs) >= TIMEOUT_MS)
    const verification = records(records(attempt?.evidence?.worktrees)[0]?.verifications)[0]
    assert.equal(verification?.status, 'passed')
    assert.deepEqual(eventsOf(setup, taskId, 'run.stopping'), [])
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'completed', failureReason: null }])
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 期限による中止が SHIKI の終わりの記録より先なら agent_timeout になる', async () => {
  const setup = await setupWithTimeout()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const ledger = openLedger(setup)
  const runner = startRunner(setup, {
    faults: {
      // SHIKI の会話は終わったが、その記録の前に期限を過ぎさせ、runner が中止を始めるのを待つ
      beforeRecordAgentFinished: async (taskKey) => {
        setup.clock.advance(TIMEOUT_MS)
        await waitUntil(() => {
          return ledger.readStop(taskKey).stopReason === 'agent_timeout'
        }, 'agent_timeout is written')
      }
    }
  })

  try {
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'agent_timeout')
    assert.equal(attempt?.agentFinishedAt, null)
    // 差分は集め、登録された検証は実行しない
    assert.equal(attempt?.evidence?.bodiesStored, true)
    const verification = records(records(attempt?.evidence?.worktrees)[0]?.verifications)[0]
    assert.equal(verification?.status, 'not_run')
    assert.equal(verification?.reason, 'agent_timeout')
    assert.equal(setup.systemd.launches().some((launch) => launch.unit.includes('-verify-')), false)
    assert.deepEqual(eventsOf(setup, taskId, 'run.stopping').map((event) => event.data), [{ reason: 'agent_timeout' }])
    assert.deepEqual(eventsOf(setup, taskId, 'run.finished').map((event) => event.data), [{ status: 'failed', failureReason: 'agent_timeout' }])
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

test('runner: heartbeat の 8 秒後に取り込んだ timeoutMs 5000 の試行は、取り込みから 5 秒たつまで期限で中止しない', async () => {
  const setup = await setupWithTimeout()
  const loops = createLoopCounter()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  setup.models.script((view) => {
    return hangingStep(view, pidFile)
  })
  const runner = startRunner(setup, { faults: { afterCancelCheck: loops.afterCancelCheck } })
  const ledger = openLedger(setup)

  try {
    await waitUntil(() => {
      return ledger.readRunner('', Date.now()).state === 'running'
    }, 'runner row')
    // runner が runner の行（heartbeat_at）を書いてから 8 秒後に登録して取り込ませる
    setup.clock.advance(8000)
    const taskId = ledger.createTask(taskInput({ title: '期限' })).task.id
    const bashPid = await readPid(pidFile)
    const taskKey = firstAttempt(setup, taskId).taskKey

    // 取り込みから 4,999 ms（heartbeat からは 12,999 ms）では中止しない
    setup.clock.advance(TIMEOUT_MS - 1)
    await loops.waitForLoops(3)
    assert.equal(ledger.readStop(taskKey).stopReason, null)
    assert.equal(ledger.getTask(taskId).status, 'running')
    assert.equal(isAlive(bashPid), true)
    // heartbeat が取り込みからの時間を精算した
    assert.equal(readActiveMs(setup.fixture, taskKey), TIMEOUT_MS - 1)

    setup.clock.advance(1)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)

    assert.equal(shown.attempts[0]?.failureReason, 'agent_timeout')
    assert.equal(shown.attempts[0]?.activeMs, TIMEOUT_MS)
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

test('runner: heartbeat の間に終わった試行の activeMs は、取り込みから記録までの時間になる', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    // model を呼ぶたびに 250 ms 進める（4回で 1,000 ms。heartbeat の間隔より短い）
    setup.clock.advance(250)

    return completingStep(view)
  })
  const runner = startRunner(setup)
  const ledger = openLedger(setup)

  try {
    await waitUntil(() => {
      return ledger.readRunner('', Date.now()).state === 'running'
    }, 'runner row')
    // 待ちの間の時間は数えない
    setup.clock.advance(7000)
    const taskId = ledger.createTask(taskInput({ title: '稼働時間' })).task.id
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const runnerView = ledger.readRunner('', Date.now())

    assert.equal(shown.task.status, 'completed')
    // heartbeat は起動のときの1回だけ
    assert.equal(runnerView.heartbeatAt, runnerView.startedAt)
    assert.equal(shown.attempts[0]?.activeMs, 1000)
    assert.equal(shown.attempts[0]?.evidence?.activeMs, 1000)
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

test('runner: heartbeat の間隔より短い一時停止と起動をくり返しても稼働時間は足され、timeoutMs で agent_timeout になる', async () => {
  const setup = await setupWithTimeout()
  // 再開のたびに、途中だった bash の結果を受けて新しい bash で待ち続ける
  setup.models.script((view) => {
    const index = view.toolResults.length

    return toolCall('bash', { command: `echo $$ > ${path.join(setup.fixture.root, `bash-${index}.pid`)}; sleep 30` })
  })
  const [taskId = 0] = createTasks(setup, 1)
  let runner = startRunner(setup)

  try {
    for (const [index, expected] of [[0, 2000], [1, 4000]] as const) {
      await readPid(path.join(setup.fixture.root, `bash-${index}.pid`))
      setup.clock.advance(2000)
      assert.equal(await runner.stop(), 0)
      const attempt = firstAttempt(setup, taskId)
      assert.equal(attempt.status, 'running')
      assert.equal(readActiveMs(setup.fixture, attempt.taskKey), expected)
      runner = startRunner(setup)
    }

    await readPid(path.join(setup.fixture.root, 'bash-2.pid'))
    assert.equal(firstAttempt(setup, taskId).stopReason, null)
    setup.clock.advance(1000)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)

    assert.equal(shown.attempts[0]?.failureReason, 'agent_timeout')
    assert.equal(shown.attempts[0]?.activeMs, TIMEOUT_MS)
    assert.equal(shown.attempts[0]?.evidence?.resumes, 2)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  } finally {
    await teardownRunner(setup, runner)
  }
})

test('runner: 判断を求めた後に期限で止まると、質問を残して failed（agent_timeout）になる', async () => {
  const setup = await setupWithTimeout()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  const question = 'どちらの API を使うか決めてください'
  setup.models.script((view) => {
    const results = view.toolResults

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1:
        return toolCall('araya_request_decision', { question })
      case 2:
        return toolCall('bash', { command: `echo $$ > ${pidFile}; sleep 30` })
      default:
        return answer('質問しました')
    }
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)

  try {
    await readPid(pidFile)
    setup.clock.advance(TIMEOUT_MS)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'agent_timeout')
    assert.equal(attempt?.decisionQuestion, question)
    assert.equal(attempt?.evidence?.decisionQuestion, question)
  } finally {
    await teardownRunner(setup, runner)
  }
})
