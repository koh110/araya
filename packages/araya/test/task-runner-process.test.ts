import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { runCli } from '../src/cli.ts'
import { scopePattern } from '../src/systemd-units.ts'
import { AttemptsDoc, ATTEMPT_TASK_NAME } from '../src/task-attempt.ts'
import { findMarkedProcesses } from './support/fake-systemd.ts'
import { ctx, taskInput, waitUntil } from './support/runner-fixture.ts'
import { openLedger, parseLogLines, readRunnerLog, waitForTaskStatus, type RunnerSetup } from './support/runner-loop.ts'
import {
  processFiles,
  readProcessRecords,
  scriptGoal,
  startRunnerProcess,
  stopRunnerProcess,
  waitForExit,
  withRunnerProcesses,
  type ProcessScript
} from './support/runner-process.ts'
import { isAlive, isRecord, readEvents, readPid, records, setupWithRepository } from './support/runner-scenarios.ts'

// process をまたぐ runner の test。test 用の entrypoint（test/support/task-runner-entry.ts）を子 process で起動し、
// SIGKILL（落ちたとき）と SIGTERM（一時停止）の後に、同じ dataDir で起動し直す

const FINAL_STATUSES = ['completed', 'failed', 'blocked']

function createScriptTask(setup: RunnerSetup, script: ProcessScript, title: string) {
  const ledger = openLedger(setup)

  try {
    return ledger.createTask(taskInput({ title, goal: scriptGoal(script) })).task.id
  } finally {
    ledger.close()
  }
}

function eventsOf(setup: RunnerSetup, taskId: number, type: string) {
  return readEvents(setup.fixture).filter((event) => {
    return event.taskId === taskId && event.type === type
  })
}

// runner が試行を取り込むのを待ち、taskKey を返す
async function waitForTaskKey(setup: RunnerSetup, taskId: number) {
  const ledger = openLedger(setup)

  try {
    await waitUntil(() => {
      return ledger.showTask(taskId, { events: 0 }).attempts.at(-1)?.startedAt !== null
    }, `Task ${taskId} is claimed`)
    const attempt = ledger.showTask(taskId, { events: 0 }).attempts.at(-1)

    if (attempt === undefined) {
      throw new Error(`Task ${taskId} has no attempt`)
    }

    return attempt.taskKey
  } finally {
    ledger.close()
  }
}

function showTask(setup: RunnerSetup, taskId: number) {
  const ledger = openLedger(setup)

  try {
    return ledger.showTask(taskId, { events: 500 })
  } finally {
    ledger.close()
  }
}

function runnerState(setup: RunnerSetup) {
  const ledger = openLedger(setup)

  try {
    return ledger.readRunner('', Date.now()).state
  } finally {
    ledger.close()
  }
}

async function readLog(setup: RunnerSetup) {
  return parseLogLines(await readRunnerLog(setup.fixture))
}

// 偽物の systemd の記録のうち、その試行の scope で起動した command
async function launchesOf(setup: RunnerSetup, taskKey: string) {
  return (await readProcessRecords(setup)).filter((record) => {
    return record.type === 'launch' && typeof record.unit === 'string' && record.unit.includes(`-${taskKey}-`)
  }).map((record) => {
    return { unit: String(record.unit), argv: Array.isArray(record.argv) ? record.argv.map(String) : [] }
  })
}

// runner が止まっている間に storage を開き、終わっていない task の record を読む（runner の process は storage を開いていない）
async function inspectTasks(setup: RunnerSetup) {
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(setup.fixture.dataDir, 'runner', 'durable.sqlite')), {
    models: setup.models.runtime,
    registry: createRegistry()
  }, ctx)

  try {
    return (await harness.inspect(ctx)).tasks
  } finally {
    await harness.close(ctx)
  }
}

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

async function runTaskShow(setup: RunnerSetup, args: string[]) {
  const stdout: string[] = []
  await runCli(['task', 'show', ...args], async () => {
    throw new Error('Pi を起動しない')
  }, { ARAYA_DATA_DIR: setup.fixture.dataDir, HOME: setup.fixture.home, PI_CODING_AGENT_DIR: setup.fixture.agentDir }, {
    platform: 'linux',
    stdin: Readable.from([]),
    stdout: (text) => stdout.push(text),
    stderr: () => {}
  })
  const output: unknown = JSON.parse(stdout.join('\n'))

  if (!isRecord(output)) {
    throw new Error('task show did not print an object')
  }

  const attempt = records(output.attempts)[0]

  return { attempt: attempt ?? {}, evidence: isRecord(attempt?.evidence) ? attempt.evidence : {} }
}

async function sha256Of(file: string) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

test('runner process: 取り込みの後、試行の task を作る前に落ちても、起動し直すと試行の task を1つだけ作って終わる', async (t) => {
  const setup = await setupWithRepository()
  const taskId = createScriptTask(setup, 'complete', 'Task 1')

  await withRunnerProcesses(t, setup, async (runners) => {
    const first = await startRunnerProcess(setup, { run: 1, fault: 'kill_after_claim' })
    runners.push(first)
    assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })

    // 取り込みの transaction は commit され、試行は running のまま
    const claimed = showTask(setup, taskId)
    const taskKey = claimed.attempts[0]?.taskKey ?? ''
    assert.equal(claimed.task.status, 'running')
    assert.notEqual(claimed.attempts[0]?.startedAt, null)
    assert.equal(eventsOf(setup, taskId, 'run.started').length, 1)
    assert.equal(await readAttemptsDoc(setup).then((doc) => doc?.byTaskKey[taskKey]), undefined)

    const second = await startRunnerProcess(setup, { run: 2 })
    runners.push(second)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    assert.deepEqual(await stopRunnerProcess(second), { code: 0, signal: null })

    assert.equal(shown.task.status, 'completed')
    assert.equal(eventsOf(setup, taskId, 'run.started').length, 1)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
    // 起動し直した runner が、開き直したときの確認で試行の task を作った
    const reconciled = (await readLog(setup)).filter((entry) => entry.type === 'reconciled')
    assert.deepEqual(reconciled.map((entry) => [entry.running, entry.created, entry.resumed]), [[[], [], []], [[taskKey], [taskKey], []]])
    // 試行の task と会話は1つだけ
    const doc = await readAttemptsDoc(setup)
    assert.deepEqual(Object.keys(doc?.byTaskKey ?? {}), [taskKey])
    assert.deepEqual(Object.values(doc?.byConversation ?? {}).map((entry) => entry.taskKey), [taskKey])
  })
})

test('runner process: bash の実行中に SIGKILL しても、起動し直すと会話が続きから進み、bash は interrupted で返り、完了していた tool は再実行されない', async (t) => {
  const setup = await setupWithRepository()
  const taskId = createScriptTask(setup, 'bash_sleep', 'Task 1')

  await withRunnerProcesses(t, setup, async (runners) => {
    const first = await startRunnerProcess(setup, { run: 1 })
    runners.push(first)
    const taskKey = await waitForTaskKey(setup, taskId)
    const files = processFiles(setup.fixture.root, taskKey)
    const bashPid = await readPid(files.bashPid)
    first.signal('SIGKILL')
    assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })
    // bash の process group は runner が落ちても残る（本物では ExecStopPost、ここでは次の起動の後始末が止める）
    assert.equal(isAlive(bashPid), true)
    // 落ちたときは、開き直すと試行の task の restarts が1つ増える（SIGTERM の test と比べるため）
    const attemptTasks = (await inspectTasks(setup)).filter((item) => item.record.kind === ATTEMPT_TASK_NAME)
    assert.deepEqual(attemptTasks.map((item) => item.record.restarts), [1])

    const second = await startRunnerProcess(setup, { run: 2 })
    runners.push(second)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    assert.deepEqual(await stopRunnerProcess(second), { code: 0, signal: null })
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'completed')
    assert.equal(attempt?.summary, `${taskKey} を再開して終わりました`)
    assert.equal(isAlive(bashPid), false)
    // 途中だった bash は interrupted の誤りとして model に返った
    assert.equal((await fs.readFile(files.interrupted, 'utf8')).trim(), 'interrupted')
    // 完了していた araya_create_worktree と途中だった bash は、もう一度は起動されない
    const launches = await launchesOf(setup, taskKey)
    assert.equal(launches.filter((launch) => launch.argv.includes('worktree') && launch.argv.includes('add')).length, 1)
    assert.equal(launches.filter((launch) => launch.argv.some((arg) => arg.includes('sleep 30'))).length, 1)
    const worktrees = (await fs.readFile(path.join(attempt?.stateDir ?? '', 'worktrees.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(worktrees.length, 1)
    assert.equal(eventsOf(setup, taskId, 'run.resumed').length, 1)
    assert.equal(attempt?.evidence?.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  })
})

test('runner process: bash の実行中の SIGTERM は試行を中止せずに 0 で終わり、running のまま stopped になり、起動し直すと続きから進み restarts は増えない', async (t) => {
  const setup = await setupWithRepository()
  const taskId = createScriptTask(setup, 'bash_sleep', 'Task 1')

  await withRunnerProcesses(t, setup, async (runners) => {
    const first = await startRunnerProcess(setup, { run: 1 })
    runners.push(first)
    const taskKey = await waitForTaskKey(setup, taskId)
    const files = processFiles(setup.fixture.root, taskKey)
    const bashPid = await readPid(files.bashPid)
    assert.deepEqual(await stopRunnerProcess(first), { code: 0, signal: null })

    const stopped = showTask(setup, taskId)
    assert.equal(stopped.task.status, 'running')
    assert.equal(stopped.attempts[0]?.stopReason, null)
    assert.equal(stopped.attempts[0]?.failureReason, null)
    assert.equal(runnerState(setup), 'stopped')
    assert.equal(isAlive(bashPid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(setup.fixture.hash)), [])
    // Harness を閉じた後に dataDir の scope を止めた
    const lastRecord = (await readProcessRecords(setup)).at(-1)
    assert.deepEqual([lastRecord?.type, lastRecord?.pattern], ['stop', scopePattern(setup.fixture.hash)])
    // close() は restartLimit に数えない（試行の task も、その会話の中の task も）
    const tasks = await inspectTasks(setup)
    assert.equal(tasks.filter((item) => item.record.kind === ATTEMPT_TASK_NAME).length, 1)
    assert.deepEqual(tasks.map((item) => item.record.restarts ?? 0).filter((restarts) => restarts !== 0), [])

    const second = await startRunnerProcess(setup, { run: 2 })
    runners.push(second)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    assert.deepEqual(await stopRunnerProcess(second), { code: 0, signal: null })

    assert.equal(shown.task.status, 'completed')
    assert.equal((await fs.readFile(files.interrupted, 'utf8')).trim(), 'interrupted')
    assert.equal(shown.attempts[0]?.evidence?.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.resumed').length, 1)
    assert.equal(eventsOf(setup, taskId, 'run.stopping').length, 0)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  })
})

test('runner process: 止まっている間に登録した Task と求めた中止は起動し直した後に行われ、中止は resume の前に始まる', async (t) => {
  const setup = await setupWithRepository()
  const cancelledId = createScriptTask(setup, 'bash_sleep', 'Task 1')

  await withRunnerProcesses(t, setup, async (runners) => {
    const first = await startRunnerProcess(setup, { run: 1 })
    runners.push(first)
    const cancelledKey = await waitForTaskKey(setup, cancelledId)
    await readPid(processFiles(setup.fixture.root, cancelledKey).bashPid)
    assert.deepEqual(await stopRunnerProcess(first), { code: 0, signal: null })

    // 止まっている間に Task を登録し、動いていた試行の中止を求める
    const queuedId = createScriptTask(setup, 'complete', 'Task 2')
    const ledger = openLedger(setup)

    try {
      assert.equal(ledger.cancelTask(cancelledId).cancel, 'requested')
      assert.equal(ledger.getTask(queuedId).status, 'queued')
    } finally {
      ledger.close()
    }

    const linesBeforeRestart = (await readLog(setup)).length
    const second = await startRunnerProcess(setup, { run: 2 })
    runners.push(second)
    const cancelled = await waitForTaskStatus(setup, cancelledId, FINAL_STATUSES)
    const queued = await waitForTaskStatus(setup, queuedId, FINAL_STATUSES)
    assert.deepEqual(await stopRunnerProcess(second), { code: 0, signal: null })

    assert.equal(cancelled.task.status, 'failed')
    assert.equal(cancelled.attempts[0]?.failureReason, 'cancelled')
    assert.equal(queued.task.status, 'completed')
    // 中止は開き直したときの確認（resume の前）で始まり、登録した Task は loop で取り込まれる
    const log = (await readLog(setup)).slice(linesBeforeRestart)
    const stoppingIndex = log.findIndex((entry) => entry.type === 'attempt_stopping' && entry.taskKey === cancelledKey)
    const reconciledIndex = log.findIndex((entry) => entry.type === 'reconciled')
    const claimedIndex = log.findIndex((entry) => entry.type === 'attempt_claimed')
    assert.ok(stoppingIndex >= 0 && stoppingIndex < reconciledIndex, `${stoppingIndex} < ${reconciledIndex}`)
    assert.equal(log[stoppingIndex]?.reason, 'cancelled')
    assert.ok(reconciledIndex < claimedIndex, `${reconciledIndex} < ${claimedIndex}`)
    // 中止した試行の bash は、起動し直した後に起動されない
    const bashLaunches = (await launchesOf(setup, cancelledKey)).filter((launch) => !launch.unit.includes('-git-') && !launch.unit.includes('-verify-'))
    assert.equal(bashLaunches.length, 1)
    assert.equal(eventsOf(setup, cancelledId, 'run.finished').length, 1)
    assert.equal(eventsOf(setup, queuedId, 'run.started').length, 1)
  })
})

test('runner process: 検証の実行中の SIGTERM で検証のコマンドは止まり 30 秒以内に終わり、起動し直すと evidence の phase がやり直される', async (t) => {
  const setup = await setupWithRepository()
  const taskId = createScriptTask(setup, 'verify_sleep', 'Task 1')

  await withRunnerProcesses(t, setup, async (runners) => {
    const first = await startRunnerProcess(setup, { run: 1 })
    runners.push(first)
    const taskKey = await waitForTaskKey(setup, taskId)
    const verifyPid = await readPid(processFiles(setup.fixture.root, taskKey).verifyPid)
    const startedAt = Date.now()
    assert.deepEqual(await stopRunnerProcess(first), { code: 0, signal: null })
    assert.ok(Date.now() - startedAt < 30_000, `${Date.now() - startedAt} ms`)
    assert.equal(isAlive(verifyPid), false)

    // SHIKI の終わりは記録済みで、試行は running のまま
    const stopped = showTask(setup, taskId)
    assert.equal(stopped.task.status, 'running')
    assert.notEqual(stopped.attempts[0]?.agentFinishedAt, null)
    assert.equal(stopped.attempts[0]?.stopReason, null)

    const second = await startRunnerProcess(setup, { run: 2 })
    runners.push(second)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    assert.deepEqual(await stopRunnerProcess(second), { code: 0, signal: null })
    const evidence = shown.attempts[0]?.evidence ?? {}

    assert.equal(shown.task.status, 'completed')
    assert.equal(records(records(evidence.worktrees)[0]?.verifications)[0]?.status, 'passed')
    // 検証のコマンドは、止める前と起動し直した後の2回、同じ scope の名前で起動された
    const verifications = (await launchesOf(setup, taskKey)).filter((launch) => launch.unit.endsWith('-verify-0.scope'))
    assert.equal(verifications.length, 2)
    assert.equal(evidence.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  })
})

test('runner process: evidence.json を書いた後、outcome の commit の前に落ちても結果は1回だけ記録され、show --full は一致する本文を出し、書き換えると digest_mismatch', async (t) => {
  const setup = await setupWithRepository()
  const taskId = createScriptTask(setup, 'complete', 'Task 1')

  await withRunnerProcesses(t, setup, async (runners) => {
    const first = await startRunnerProcess(setup, { run: 1, fault: 'kill_after_evidence_file' })
    runners.push(first)
    assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' })

    // evidence.json は書かれたが、結果は記録されていない
    const crashed = showTask(setup, taskId)
    const stateDir = crashed.attempts[0]?.stateDir ?? ''
    const evidenceFile = path.join(stateDir, 'evidence.json')
    assert.equal(crashed.task.status, 'running')
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 0)
    assert.equal((await fs.stat(evidenceFile)).isFile(), true)

    const second = await startRunnerProcess(setup, { run: 2 })
    runners.push(second)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES)
    assert.deepEqual(await stopRunnerProcess(second), { code: 0, signal: null })
    const evidence = shown.attempts[0]?.evidence ?? {}

    assert.equal(shown.task.status, 'completed')
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
    assert.equal(evidence.resumes, 1)
    assert.equal(evidence.bodiesStored, true)
    // 記録された bodiesSha256 は、やり直した evidence の phase が書き直した evidence.json のもの
    assert.equal(evidence.bodiesSha256, await sha256Of(evidenceFile))

    const full = await runTaskShow(setup, [String(taskId), '--full'])
    assert.equal('fullEvidenceError' in full.attempt, false)
    assert.match(String(records(full.evidence.worktrees)[0]?.diff), /\+changed/u)
    assert.equal(full.evidence.bodiesSha256, evidence.bodiesSha256)
    assert.equal(full.evidence.resumes, 1)

    await fs.appendFile(evidenceFile, ' ', 'utf8')
    const mismatched = await runTaskShow(setup, [String(taskId), '--full'])
    assert.equal(mismatched.attempt.fullEvidenceError, 'digest_mismatch')
    assert.equal('diff' in (records(mismatched.evidence.worktrees)[0] ?? {}), false)
  })
})
