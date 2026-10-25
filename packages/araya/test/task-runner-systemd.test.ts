import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createSystemdOps,
  runnerUnitName,
  runnerUnitSections,
  scopePattern,
  selectUnitEnvironment
} from '../src/systemd-units.ts'
import { taskInput, waitUntil } from './support/runner-fixture.ts'
import { openLedger, parseLogLines, readRunnerLog, waitForTaskStatus, type RunnerSetup } from './support/runner-loop.ts'
import { processFiles, scriptGoal, type ProcessFault, type ProcessScript } from './support/runner-process.ts'
import { isAlive, readEvents, readPid, setupWithRepository } from './support/runner-scenarios.ts'

// 本物の systemd の user manager を使う runner の test。ARAYA_TEST_SYSTEMD=1 のときだけ実行する。
// unit file は書かずに、unit file と同じ property（runnerUnitSections）の transient unit（systemd-run --user）で、
// test 用の entrypoint を --verify-unit 付きで動かす（unit の確認と本物の systemd の操作。model は faux）。
// unit と scope の名前は test の dataDir の hash を含むので、利用者の runner の unit には触れない

const SYSTEMD_TEST = process.env.ARAYA_TEST_SYSTEMD === '1'
const skip = SYSTEMD_TEST ? false : 'ARAYA_TEST_SYSTEMD=1 のときだけ実行する'
const ENTRY_PATH = fileURLToPath(new URL('./support/task-runner-entry.ts', import.meta.url))
const TEST_TIMEOUT_MS = 180_000
const COMMAND_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 90_000
const FINAL_STATUSES = ['completed', 'failed', 'blocked']
// 子 process（systemctl・systemd-run）が user manager に接続するための環境（XDG_RUNTIME_DIR など）
const commandEnv = { ...process.env }
// この file の test が使った dataDir の hash と、test が作った process の pid（最後の test で残りを確かめる）
const usedHashes: string[] = []
const recordedPids = new Set<number>()

type CommandOutput = { code: number | null; stdout: string; stderr: string }

function runCommand(command: string, args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise<CommandOutput>((resolve) => {
    execFile(command, args, { env: commandEnv, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout, stderr })
    })
  })
}

function systemctl(args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS) {
  return runCommand('systemctl', ['--user', ...args], timeoutMs)
}

async function listUnits(pattern: string) {
  const listed = await systemctl(['list-units', '--all', '--plain', '--no-legend', pattern])

  if (listed.code !== 0) {
    throw new Error(`systemctl list-units failed: ${listed.stderr}`)
  }

  return listed.stdout.split('\n').map((line) => {
    return line.trim().split(/\s+/u)[0] ?? ''
  }).filter((unit) => {
    return unit !== ''
  })
}

async function unitProperties(unit: string) {
  const shown = await systemctl(['show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts', '-p', 'InvocationID', unit])
  const properties = new Map<string, string>()

  for (const line of shown.stdout.split('\n')) {
    const separator = line.indexOf('=')

    if (separator > 0) {
      properties.set(line.slice(0, separator), line.slice(separator + 1))
    }
  }

  return {
    loadState: properties.get('LoadState') ?? '',
    activeState: properties.get('ActiveState') ?? '',
    subState: properties.get('SubState') ?? '',
    mainPid: Number(properties.get('MainPID') ?? '0'),
    restarts: Number(properties.get('NRestarts') ?? '0'),
    invocationId: properties.get('InvocationID') ?? ''
  }
}

function unitOf(setup: RunnerSetup) {
  return runnerUnitName(setup.fixture.hash)
}

// unit file と同じ property（[Unit] と [Service]。ExecStart は test 用の entrypoint に、[Install] は transient unit に無い）で、
// runner を transient unit として起動する。HOME と git の設定は test の一時 directory に向ける（利用者の設定を読まない・書かないため）
async function startRunnerUnit(setup: RunnerSetup, options: { fault?: ProcessFault; restartLimit?: number } = {}) {
  const { fixture } = setup
  const ops = await createSystemdOps(commandEnv)
  const sections = runnerUnitSections({
    dataDir: fixture.dataDir,
    nodePath: process.execPath,
    entrypoint: ENTRY_PATH,
    systemctlPath: ops.systemctlPath,
    environment: selectUnitEnvironment(setup.env, { dataDir: fixture.dataDir, devRoot: fixture.devRoot, piAgentDir: fixture.agentDir })
  })
  const isolation = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((name) => {
    const property: readonly [string, string] = ['Environment', `${name}=${setup.env[name] ?? ''}`]

    return property
  })
  const properties = [
    ...sections.unit,
    ...sections.service.filter(([name]) => {
      return name !== 'ExecStart'
    }),
    ...isolation
  ]
  const started = await runCommand('systemd-run', [
    '--user', '--quiet', '--collect', `--unit=${unitOf(setup)}`,
    ...properties.flatMap(([name, value]) => {
      return ['-p', `${name}=${value}`]
    }),
    process.execPath, ENTRY_PATH,
    '--data-dir', fixture.dataDir,
    '--work-dir', fixture.root,
    '--verify-unit',
    ...(options.fault === undefined ? [] : ['--fault', options.fault]),
    ...(options.restartLimit === undefined ? [] : ['--restart-limit', String(options.restartLimit)])
  ])

  return started
}

// runner が台帳の runner の行を自分の pid の running にするのを待つ
async function waitForRunnerRow(setup: RunnerSetup, previousPid: number | null = null) {
  const ledger = openLedger(setup)

  try {
    await waitUntil(async () => {
      const view = ledger.readRunner(unitOf(setup), Date.now())
      const { mainPid } = await unitProperties(unitOf(setup))

      return view.state === 'running' && view.pid === mainPid && mainPid !== 0 && mainPid !== previousPid
    }, 'the runner unit writes its runner row', 30_000)

    return ledger.readRunner(unitOf(setup), Date.now())
  } finally {
    ledger.close()
  }
}

function createScriptTask(setup: RunnerSetup, script: ProcessScript, title: string) {
  const ledger = openLedger(setup)

  try {
    return ledger.createTask(taskInput({ title, goal: scriptGoal(script) })).task.id
  } finally {
    ledger.close()
  }
}

async function waitForTaskKey(setup: RunnerSetup, taskId: number) {
  const ledger = openLedger(setup)

  try {
    await waitUntil(() => {
      return ledger.showTask(taskId, { events: 0 }).attempts.at(-1)?.startedAt !== null
    }, `Task ${taskId} is claimed`, 30_000)

    return ledger.showTask(taskId, { events: 0 }).attempts.at(-1)?.taskKey ?? ''
  } finally {
    ledger.close()
  }
}

// 試行が completed で終わったこと。違えば失敗の理由と詳細を出す
function assertCompleted(shown: Awaited<ReturnType<typeof waitForTaskStatus>>) {
  const attempt = shown.attempts.at(-1)

  assert.equal(shown.task.status, 'completed', JSON.stringify({
    failureReason: attempt?.failureReason,
    failureDetail: attempt?.failureDetail,
    evidence: attempt?.evidence
  }))
}

function eventsOf(setup: RunnerSetup, taskId: number, type: string) {
  return readEvents(setup.fixture).filter((event) => {
    return event.taskId === taskId && event.type === type
  })
}

async function readLog(setup: RunnerSetup) {
  return parseLogLines(await readRunnerLog(setup.fixture))
}

async function readRecordedPid(file: string) {
  const pid = await readPid(file)
  recordedPids.add(pid)

  return pid
}

// test の一時 directory の pid の file（bash・setsid・hook）と、runner の log の pid
async function pidsOf(setup: RunnerSetup) {
  const pids = new Set<number>()

  for (const name of await fs.readdir(setup.fixture.root)) {
    if (name.endsWith('.pid')) {
      const text = await fs.readFile(path.join(setup.fixture.root, name), 'utf8')

      for (const line of text.split('\n')) {
        if (/^\d+$/u.test(line.trim())) {
          pids.add(Number(line.trim()))
        }
      }
    }
  }

  for (const entry of await readLog(setup)) {
    if (typeof entry.pid === 'number') {
      pids.add(entry.pid)
    }
  }

  return [...pids]
}

// 後始末: runner と dataDir の scope を止め、failed の記録を消し、unit と process が残っていないことを確かめてから一時 directory を消す。
// 残っていた process は止めてから、残っていたことを返す
async function teardownSystemdRunner(setup: RunnerSetup) {
  const { hash } = setup.fixture
  await systemctl(['stop', unitOf(setup), scopePattern(hash)], STOP_TIMEOUT_MS)
  await systemctl(['reset-failed', unitOf(setup), `araya-${hash}-*`])
  const units = await listUnits(`araya-*${hash}*`)
  const pids = await pidsOf(setup)

  for (const pid of pids) {
    recordedPids.add(pid)
  }

  const alive = pids.filter(isAlive)

  for (const pid of alive) {
    process.kill(pid, 'SIGKILL')
  }

  await fs.rm(setup.fixture.root, { recursive: true, force: true })

  return { units, alive }
}

async function withSystemdRunner(t: TestContext, setup: RunnerSetup, body: () => Promise<void>) {
  usedHashes.push(setup.fixture.hash)
  let failed = false

  try {
    await body()
  } catch (error) {
    failed = true
    t.diagnostic(`runner.log:\n${await readRunnerLog(setup.fixture)}`)
    t.diagnostic(`unit: ${JSON.stringify(await unitProperties(unitOf(setup)))}`)
    throw error
  } finally {
    const left = await teardownSystemdRunner(setup)

    if (!failed) {
      assert.deepEqual(left, { units: [], alive: [] }, 'test の後に unit と process が残っていない')
    }
  }
}

test('runner systemd: main process を SIGKILL すると ExecStopPost が setsid した process を含む試行の scope を起動し直す前に止め、試行は続きから終わる', { skip, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await setupWithRepository()

  await withSystemdRunner(t, setup, async () => {
    const taskId = createScriptTask(setup, 'bash_setsid', 'SIGKILL')
    assert.equal((await startRunnerUnit(setup)).code, 0)
    const first = await waitForRunnerRow(setup)
    const taskKey = await waitForTaskKey(setup, taskId)
    const files = processFiles(setup.fixture.root, taskKey)
    const bashPid = await readRecordedPid(files.bashPid)
    const setsidPid = await readRecordedPid(files.setsidPid)
    assert.ok(isAlive(bashPid) && isAlive(setsidPid))
    // bash と setsid した process は、runner の cgroup の外（試行の scope）にいる
    assert.ok((await listUnits(scopePattern(setup.fixture.hash, taskKey))).length > 0)

    assert.ok(first.pid !== null && first.pid > 0)
    process.kill(first.pid, 'SIGKILL')
    await waitUntil(() => {
      return !isAlive(bashPid) && !isAlive(setsidPid)
    }, 'the attempt scope is stopped', 15_000)
    const stoppedAt = Date.now()
    assert.deepEqual(await listUnits(scopePattern(setup.fixture.hash, taskKey)), [])

    const second = await waitForRunnerRow(setup, first.pid)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES, 60_000)
    const attempt = shown.attempts[0]

    assertCompleted(shown)
    assert.equal((await fs.readFile(files.interrupted, 'utf8')).trim(), 'interrupted')
    assert.equal(attempt?.evidence?.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.resumed').length, 1)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
    // scope が止まったのは、起動し直した runner が起動する（runner の行を書く）前
    assert.ok(Date.parse(second.startedAt ?? '') > stoppedAt, `${second.startedAt ?? ''} > ${new Date(stoppedAt).toISOString()}`)
    const started = (await readLog(setup)).filter((entry) => entry.type === 'runner_started')
    assert.deepEqual(started.map((entry) => entry.pid), [first.pid, second.pid])
    const unit = await unitProperties(unitOf(setup))
    assert.equal(unit.restarts, 1)
    assert.equal(unit.activeState, 'active')
  })
})

test('runner systemd: systemctl --user stop では起動し直さず、試行の scope も止まり、次の起動で続きから進む', { skip, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await setupWithRepository()

  await withSystemdRunner(t, setup, async () => {
    const taskId = createScriptTask(setup, 'bash_setsid', 'stop')
    assert.equal((await startRunnerUnit(setup)).code, 0)
    const first = await waitForRunnerRow(setup)
    const taskKey = await waitForTaskKey(setup, taskId)
    const files = processFiles(setup.fixture.root, taskKey)
    const bashPid = await readRecordedPid(files.bashPid)
    const setsidPid = await readRecordedPid(files.setsidPid)

    const stopped = await systemctl(['stop', unitOf(setup)], STOP_TIMEOUT_MS)
    assert.equal(stopped.code, 0, stopped.stderr)
    assert.equal(isAlive(bashPid), false)
    assert.equal(isAlive(setsidPid), false)
    assert.deepEqual(await listUnits(scopePattern(setup.fixture.hash)), [])
    // RestartSec（1 秒）より長く待っても起動し直さない
    await new Promise((resolve) => {
      setTimeout(resolve, 2500)
    })
    assert.deepEqual(await listUnits(unitOf(setup)), [])
    assert.equal((await unitProperties(unitOf(setup))).activeState, 'inactive')
    const ledger = openLedger(setup)

    try {
      const paused = ledger.showTask(taskId, { events: 0 }).attempts[0]
      assert.equal(ledger.readRunner(unitOf(setup), Date.now()).state, 'stopped')
      assert.equal(paused?.status, 'running')
      assert.equal(paused?.stopReason, null)
    } finally {
      ledger.close()
    }

    assert.equal((await readLog(setup)).filter((entry) => entry.type === 'runner_started').length, 1)

    assert.equal((await startRunnerUnit(setup)).code, 0)
    await waitForRunnerRow(setup, first.pid)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES, 60_000)

    assertCompleted(shown)
    assert.equal((await fs.readFile(files.interrupted, 'utf8')).trim(), 'interrupted')
    assert.equal(shown.attempts[0]?.evidence?.resumes, 1)
    assert.equal(eventsOf(setup, taskId, 'run.stopping').length, 0)
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
  })
})

test('runner systemd: restartLimit で試行が止められるまで runner が落ち続けても、systemd は起動し直すのをやめない', { skip, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await setupWithRepository()
  const restartLimit = 3

  await withSystemdRunner(t, setup, async () => {
    const taskId = createScriptTask(setup, 'complete', 'crash loop')
    // 起動のたびに、agent の phase の commit の前に落ちる（状態を進めずに落ち続ける）
    assert.equal((await startRunnerUnit(setup, { fault: 'kill_before_agent_commit', restartLimit })).code, 0)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES, 120_000)
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'blocked')
    assert.equal(attempt?.failureReason, 'restart_limit')
    assert.equal(eventsOf(setup, taskId, 'run.finished').length, 1)
    const unit = await unitProperties(unitOf(setup))
    // restartLimit の回数だけ落ちて起動し直し、試行が止められた後も runner は動いている
    assert.equal(unit.restarts, restartLimit)
    assert.equal(unit.activeState, 'active')
    assert.equal(unit.subState, 'running')
    const runner = await waitForRunnerRow(setup)
    assert.equal(runner.pid, unit.mainPid)
    assert.equal((await readLog(setup)).filter((entry) => entry.type === 'runner_started').length, restartLimit + 1)
  })
})

test('runner systemd: 同じ unit 名で2つ目の runner は起動せず、unit の外で起動した runner は台帳と storage を開かずに 1 で終わる', { skip, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await setupWithRepository()

  await withSystemdRunner(t, setup, async () => {
    assert.equal((await startRunnerUnit(setup)).code, 0)
    const first = await waitForRunnerRow(setup)

    const second = await startRunnerUnit(setup)
    assert.notEqual(second.code, 0)
    assert.match(second.stderr, /already loaded|fragment file/u)

    // unit の外（この test の cgroup）では、INVOCATION_ID があっても cgroup の unit 名が違う
    const outside = spawn(process.execPath, [ENTRY_PATH, '--data-dir', setup.fixture.dataDir, '--work-dir', setup.fixture.root, '--verify-unit'], {
      env: { ...setup.env, INVOCATION_ID: 'outside-the-unit' },
      stdio: 'ignore'
    })
    const code = await new Promise<number | null>((resolve) => {
      outside.once('exit', (exitCode) => {
        resolve(exitCode)
      })
    })

    assert.equal(code, 1)
    assert.ok((await readLog(setup)).some((entry) => entry.type === 'runner_unit_mismatch'))
    const unit = await unitProperties(unitOf(setup))
    assert.equal(unit.mainPid, first.pid)
    assert.equal(unit.restarts, 0)
    const ledger = openLedger(setup)

    try {
      const runner = ledger.readRunner(unitOf(setup), Date.now())
      assert.equal(runner.pid, first.pid)
      assert.equal(runner.state, 'running')
    } finally {
      ledger.close()
    }

    assert.equal((await readLog(setup)).filter((entry) => entry.type === 'runner_started').length, 1)
  })
})

test('runner systemd: araya_create_worktree の git の post-checkout hook が setsid で残した process は、試行の結果が記録された時点で止まっている', { skip, timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await setupWithRepository()
  const hookPidFile = path.join(setup.fixture.root, 'hook.pid')
  const hookPath = path.join(setup.fixture.devRoot, 'repo', '.git', 'hooks', 'post-checkout')
  await fs.mkdir(path.dirname(hookPath), { recursive: true })
  await fs.writeFile(hookPath, [
    '#!/bin/sh',
    `setsid sh -c 'echo $$ >> ${hookPidFile}; exec sleep 300' >/dev/null 2>&1 </dev/null &`,
    'exit 0',
    ''
  ].join('\n'), { encoding: 'utf8', mode: 0o755 })

  await withSystemdRunner(t, setup, async () => {
    const taskId = createScriptTask(setup, 'complete', 'hook')
    assert.equal((await startRunnerUnit(setup)).code, 0)
    const shown = await waitForTaskStatus(setup, taskId, FINAL_STATUSES, 60_000)
    const taskKey = shown.attempts[0]?.taskKey ?? ''
    const hookPids = (await fs.readFile(hookPidFile, 'utf8')).split('\n').filter((line) => {
      return line !== ''
    }).map(Number)

    for (const pid of hookPids) {
      recordedPids.add(pid)
    }

    assertCompleted(shown)
    assert.ok(hookPids.length > 0, 'the post-checkout hook ran')
    assert.deepEqual(hookPids.filter(isAlive), [])
    assert.deepEqual(await listUnits(scopePattern(setup.fixture.hash, taskKey)), [])
    // 試行の git は、その試行の scope の中で動いた（runner は動き続けているので、runner の cgroup にいたら止まらない）
    assert.equal((await unitProperties(unitOf(setup))).activeState, 'active')
  })
})

test('runner systemd: test の後に araya- で始まる unit と test が作った process が残っていない', { skip }, async () => {
  const units = await listUnits('araya-*')
  const left = units.filter((unit) => {
    return usedHashes.some((hash) => unit.includes(hash))
  })

  assert.deepEqual(left, [])
  assert.deepEqual([...recordedPids].filter(isAlive), [])
})
