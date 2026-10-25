import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DatabaseSync } from 'node:sqlite'

import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { runCli } from '../src/cli.ts'
import { SHIKI_TOOL_NAMES } from '../src/shiki.ts'
import { scopePattern } from '../src/systemd-units.ts'
import { AttemptsDoc } from '../src/task-attempt.ts'
import { answer, toolCall, worktreePathFrom } from './support/faux-shiki.ts'
import { findMarkedProcesses } from './support/fake-systemd.ts'
import { createRepository, ctx, taskInput, waitUntil, type RunnerFixture } from './support/runner-fixture.ts'
import {
  openLedger,
  parseLogLines,
  readRunnerLog,
  startRunner,
  teardownRunner,
  waitForTaskStatus,
  writeModelConfig,
  type RunnerSetup,
  type StartedRunner
} from './support/runner-loop.ts'
import {
  completingStep,
  createTasks,
  FAIL_COMMAND,
  isAlive,
  isRecord,
  PASS_COMMAND,
  readEvents,
  readPid,
  records,
  setupWithRepository
} from './support/runner-scenarios.ts'

const execFileAsync = promisify(execFile)
const CLI_PATH = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))

// 台帳のすべての table の内容を1つの文字列にする（秘密が写っていないことを確かめる）
function dumpLedger(fixture: RunnerFixture) {
  const db = new DatabaseSync(path.join(fixture.dataDir, 'tasks.sqlite'))

  try {
    return ['tasks', 'runs', 'task_events', 'runner'].map((table) => {
      return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
    }).join('\n')
  } finally {
    db.close()
  }
}

async function finish(setup: RunnerSetup, runner?: StartedRunner) {
  await teardownRunner(setup, runner)
}

test('runner: 登録された試行を次の loop で取り込み、Task が無い間は model を呼ばずに heartbeat を更新する', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const runner = startRunner(setup)
  const ledger = openLedger(setup)

  try {
    await waitUntil(() => {
      return ledger.readRunner('', Date.now()).state === 'running'
    }, 'runner row')
    const first = ledger.readRunner('', Date.now()).heartbeatAt
    // heartbeat の間隔（10 秒）を時計で進める
    setup.clock.advance(10_000)
    await waitUntil(() => {
      return ledger.readRunner('', Date.now()).heartbeatAt !== first
    }, 'heartbeat')
    const second = ledger.readRunner('', Date.now()).heartbeatAt
    setup.clock.advance(10_000)
    await waitUntil(() => {
      return ledger.readRunner('', Date.now()).heartbeatAt !== second
    }, 'second heartbeat')
    assert.equal(setup.models.faux.state.callCount, 0)
    assert.deepEqual(ledger.queueView(1), { limit: 1, running: 0, queued: 0 })

    const taskId = ledger.createTask(taskInput()).task.id
    await waitUntil(() => {
      return readEvents(setup.fixture).some((event) => {
        return event.taskId === taskId && event.type === 'run.started'
      })
    }, 'run.started')
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    assert.equal(shown.task.status, 'completed')
    assert.ok(setup.models.faux.state.callCount > 0)
  } finally {
    ledger.close()
    await finish(setup, runner)
  }
})

test('runner: completed の試行の summary・model・evidence（resumes 0, activeMs）が台帳に入り、別 process の task show で読める', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    // model を呼ぶたびに、runner が動いている時間として 250 ms 進める
    setup.clock.advance(250)

    return completingStep(view, { report: 'README に1行足し、検証を登録しました' })
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)

  try {
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    const attempt = shown.attempts[0]
    const expectedModel = { provider: setup.models.model.provider, id: setup.models.model.id, thinkingLevel: 'off', source: 'araya-config' }

    assert.equal(shown.task.status, 'completed')
    assert.equal(shown.task.summary, 'README に1行足し、検証を登録しました')
    assert.equal(attempt?.status, 'completed')
    assert.equal(attempt?.summary, 'README に1行足し、検証を登録しました')
    assert.deepEqual(attempt?.model, expectedModel)
    assert.equal(attempt?.activeMs, 1000)
    const evidence = attempt?.evidence ?? {}
    assert.equal(evidence.outcome, 'completed')
    assert.deepEqual(evidence.agent, { model: expectedModel })
    assert.equal(evidence.timeoutMs, 20 * 60 * 1000)
    assert.deepEqual(evidence.tools, [...SHIKI_TOOL_NAMES])
    assert.equal(SHIKI_TOOL_NAMES.length, 7)
    assert.equal(evidence.resumes, 0)
    assert.equal(evidence.activeMs, 1000)
    assert.equal(evidence.bodiesStored, true)
    const finished = shown.events.filter((event) => {
      return event.type === 'run.finished'
    })
    assert.deepEqual(finished.map((event) => event.data), [{ status: 'completed', failureReason: null }])
    assert.equal((await fs.stat(path.join(setup.fixture.dataDir, 'logs', 'runner.log'))).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.join(setup.fixture.dataDir, 'runner'))).mode & 0o777, 0o700)
    const log = parseLogLines(await readRunnerLog(setup.fixture))
    assert.deepEqual(log.filter((entry) => entry.taskKey === attempt?.taskKey).map((entry) => entry.type), ['attempt_claimed', 'attempt_finished'])

    // 別の process（araya task show）から同じ内容を読める
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, 'task', 'show', String(taskId), '--events', '500'], {
      env: { PATH: process.env.PATH, HOME: setup.fixture.home, ARAYA_DATA_DIR: setup.fixture.dataDir, PI_CODING_AGENT_DIR: setup.fixture.agentDir }
    })
    const output: unknown = JSON.parse(stdout)
    assert.ok(isRecord(output))
    assert.deepEqual(output.task, shown.task)
    assert.deepEqual(output.attempts, shown.attempts)
    assert.deepEqual(output.events, shown.events)
  } finally {
    await finish(setup, runner)
  }
})

test('runner: INVOCATION_ID が無いか cgroup の unit 名が違えば、台帳も storage も開かずに 1 で終わる', async () => {
  const setup = await setupWithRepository()
  let systemdCreated = 0
  let modelsCreated = 0
  const cases = [
    { label: 'INVOCATION_ID が無い', env: { ...setup.env, INVOCATION_ID: undefined }, cgroup: undefined },
    { label: 'cgroup の unit 名が違う', env: setup.env, cgroup: '0::/user.slice/user@1000.service/app.slice/araya-runner-000000000000.service\n' },
    { label: 'cgroup v2 の行が無い', env: setup.env, cgroup: '1:name=systemd:/user.slice\n' }
  ]

  try {
    for (const item of cases) {
      const runner = startRunner(setup, {
        env: item.env,
        ...(item.cgroup === undefined ? {} : { readCgroup: async () => item.cgroup }),
        createSystemdOps: async () => {
          systemdCreated += 1
          return setup.systemd.ops
        },
        createModels: async () => {
          modelsCreated += 1
          return setup.models.runtime
        }
      })

      assert.equal(await runner.done, 1, item.label)
      assert.deepEqual(runner.storageOpened, [], item.label)
    }

    // Linux 以外でも同じく何も開かない
    const other = startRunner(setup, { platform: 'darwin' })
    assert.equal(await other.done, 1)
    assert.deepEqual(other.storageOpened, [])

    assert.equal(systemdCreated, 0)
    assert.equal(modelsCreated, 0)
    await assert.rejects(fs.access(path.join(setup.fixture.dataDir, 'tasks.sqlite')))
    await assert.rejects(fs.access(path.join(setup.fixture.dataDir, 'runner', 'durable.sqlite')))
  } finally {
    await finish(setup)
  }
})

test('runner: 起動時に scope を止められなければ Harness を開かずに 1 で終わる', async () => {
  // dataDir の scope（araya-<h>-*.scope）だけを止められなくする
  const setup = await setupWithRepository({
    systemd: {
      failStop: (pattern) => {
        return /^araya-[0-9a-f]{12}-\*\.scope$/u.test(pattern)
      }
    }
  })

  try {
    const runner = startRunner(setup)

    assert.equal(await runner.done, 1)
    assert.deepEqual(runner.storageOpened, [])
    await assert.rejects(fs.access(path.join(setup.fixture.dataDir, 'runner', 'durable.sqlite')))
    assert.deepEqual(setup.systemd.records().map((record) => record.type), ['stop_failed'])
    const log = parseLogLines(await readRunnerLog(setup.fixture))
    assert.ok(log.some((entry) => entry.type === 'scope_stop_failed' && entry.pattern === scopePattern(setup.fixture.hash)))
    assert.equal(setup.models.faux.state.callCount, 0)
  } finally {
    await finish(setup)
  }
})

// 試行の取り込み（run.started）と記録（run.finished）の順に、running の試行の数を数える
function maxRunning(fixture: RunnerFixture) {
  let running = 0
  let max = 0

  for (const event of readEvents(fixture)) {
    if (event.type === 'run.started') {
      running += 1
      max = Math.max(max, running)
    } else if (event.type === 'run.finished') {
      running -= 1
    }
  }

  return max
}

function eventOrder(fixture: RunnerFixture) {
  return readEvents(fixture).flatMap((event) => {
    return event.type === 'run.started' || event.type === 'run.finished' ? [`${event.type}:${event.taskId}`] : []
  })
}

test('runner: 上限 1 では running が同時に2つにならず、2件目は1件目の記録の後に取り込む', async () => {
  const setup = await setupWithRepository()
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [first = 0, second = 0] = createTasks(setup, 2)
  const runner = startRunner(setup)

  try {
    await waitForTaskStatus(setup, second, ['completed', 'failed', 'blocked'])

    assert.equal((await waitForTaskStatus(setup, first, ['completed'])).task.status, 'completed')
    assert.equal((await waitForTaskStatus(setup, second, ['completed'])).task.status, 'completed')
    assert.deepEqual(eventOrder(setup.fixture), [
      `run.started:${first}`,
      `run.finished:${first}`,
      `run.started:${second}`,
      `run.finished:${second}`
    ])
    assert.equal(maxRunning(setup.fixture), 1)
  } finally {
    await finish(setup, runner)
  }
})

test('runner: 上限 2 では古い2件が同時に running になり、3件目はどちらかの記録の後', async () => {
  const setup = await setupWithRepository()
  // 同じ repository に同時に worktree を作ることは、上限を上げる前に確かめること（仕様の「並列数を上げるとき」）なので、Task ごとに repository を分ける
  for (const name of ['repo1', 'repo2', 'repo3']) {
    await createRepository(setup.fixture, name)
  }

  setup.models.script((view) => {
    return completingStep(view, { repository: `repo${/^task-(\d+)-/u.exec(view.taskKey)?.[1] ?? ''}` })
  })
  const [first = 0, second = 0, third = 0] = createTasks(setup, 3)
  const runner = startRunner(setup, { maxConcurrent: 2 })

  try {
    await waitForTaskStatus(setup, third, ['completed', 'failed', 'blocked'])

    for (const taskId of [first, second, third]) {
      assert.equal((await waitForTaskStatus(setup, taskId, ['completed'])).task.status, 'completed')
    }

    const order = eventOrder(setup.fixture)
    // 古い2件を続けて取り込み、どちらかを記録してから3件目を取り込む
    assert.deepEqual(order.slice(0, 2), [`run.started:${first}`, `run.started:${second}`])
    assert.match(order[2] ?? '', new RegExp(`^run\\.finished:(${first}|${second})$`, 'u'))
    assert.equal(order[3], `run.started:${third}`)
    assert.equal(maxRunning(setup.fixture), 2)
  } finally {
    await finish(setup, runner)
  }
})

test('runner: running の試行への中止は次の loop で始まり、bash が止まり、差分の収集と検証が行われない', async () => {
  const setup = await setupWithRepository()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  setup.models.script((view) => {
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
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)
  const ledger = openLedger(setup)

  try {
    const bashPid = await readPid(pidFile)
    assert.equal(isAlive(bashPid), true)
    const launchesBeforeCancel = setup.systemd.launches().length
    assert.equal(ledger.cancelTask(taskId).cancel, 'requested')
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    const attempt = shown.attempts[0]

    assert.equal(shown.task.status, 'failed')
    assert.equal(attempt?.failureReason, 'cancelled')
    assert.equal(attempt?.stopReason, 'cancelled')
    assert.equal(isAlive(bashPid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(setup.fixture.hash)), [])
    // 中止の後は、差分の収集の git も検証のコマンドも起動しない
    assert.deepEqual(setup.systemd.launches().slice(launchesBeforeCancel), [])
    assert.equal(setup.systemd.launches().some((launch) => launch.unit.includes('-verify-')), false)
    const evidence = attempt?.evidence ?? {}
    assert.equal(evidence.bodiesStored, false)
    assert.deepEqual(records(evidence.worktrees).map((worktree) => Object.keys(worktree).sort()), [['branch', 'worktreePath']])
    await assert.rejects(fs.access(path.join(attempt?.stateDir ?? '', 'evidence.json')))
    assert.deepEqual(shown.events.flatMap((event) => {
      return event.type === 'run.stopping' || event.type === 'run.finished' || event.type === 'task.cancel_requested' ? [[event.type, event.data]] : []
    }), [
      ['task.cancel_requested', { while: 'running' }],
      ['run.stopping', { reason: 'cancelled' }],
      ['run.finished', { status: 'failed', failureReason: 'cancelled' }]
    ])
    const log = parseLogLines(await readRunnerLog(setup.fixture))
    assert.ok(log.some((entry) => entry.type === 'attempt_stopping' && entry.reason === 'cancelled'))
  } finally {
    ledger.close()
    await finish(setup, runner)
  }
})

test('runner: setsid した process は evidence の phase の始めに止まり、その変更は差分に入らず、次の試行の開始時に残りは 0 件', async () => {
  const setup = await setupWithRepository()
  const setsidPidFile = path.join(setup.fixture.root, 'setsid.pid')
  const leftoversAtSecondStart: { pid: number; alive: boolean }[] = []
  let firstKey = ''
  setup.models.script((view) => {
    const results = view.toolResults

    if (firstKey === '') {
      firstKey = view.taskKey
    }

    if (view.taskKey !== firstKey) {
      if (results.length === 0) {
        // 次の試行の最初の model の呼び出しの時点で、前の試行が残した process を数える
        const pid = Number(readFileSync(setsidPidFile, 'utf8').trim())
        leftoversAtSecondStart.push({ pid, alive: isAlive(pid) })
      }

      return completingStep(view)
    }

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1: {
        const worktree = worktreePathFrom(results[0])
        // 切り離した process は、2 秒後に worktree を変える
        const detached = `setsid sh -c 'echo $$ > ${setsidPidFile}; sleep 2; echo late > ${worktree}/late.txt; sleep 30' </dev/null >/dev/null 2>&1 &`
        return toolCall('bash', { command: `printf 'changed\\n' >> ${worktree}/README.md; ${detached} while [ ! -s ${setsidPidFile} ]; do sleep 0.05; done` })
      }
      case 2:
        return toolCall('araya_register_verification', { repository: 'repo', command: [...PASS_COMMAND] })
      default:
        return answer('終わりました')
    }
  })
  const [first = 0, second = 0] = createTasks(setup, 2)
  const runner = startRunner(setup)

  try {
    const shown = await waitForTaskStatus(setup, first, ['completed', 'failed', 'blocked'])
    const attempt = shown.attempts[0]
    const setsidPid = Number((await fs.readFile(setsidPidFile, 'utf8')).trim())

    assert.equal(attempt?.status, 'completed')
    // 結果が記録された時点で、その試行の scope（偽物では印の付いた process）は残っていない
    assert.equal(isAlive(setsidPid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(setup.fixture.hash, attempt?.taskKey ?? '')), [])
    const evidenceFile: unknown = JSON.parse(await fs.readFile(path.join(attempt?.stateDir ?? '', 'evidence.json'), 'utf8'))
    assert.ok(isRecord(evidenceFile))
    const worktree = records(evidenceFile.worktrees)[0]
    assert.match(String(worktree?.diff), /README\.md/u)
    assert.doesNotMatch(String(worktree?.diff), /late\.txt/u)

    // 切り離した process が生きていれば worktree を変えていた時間を過ぎても、変更は無い
    await new Promise((resolve) => {
      setTimeout(resolve, 2500)
    })
    await assert.rejects(fs.access(path.join(String(worktree?.worktreePath), 'late.txt')))
    assert.equal((await waitForTaskStatus(setup, second, ['completed', 'failed', 'blocked'])).task.status, 'completed')
    assert.deepEqual(leftoversAtSecondStart, [{ pid: setsidPid, alive: false }])
  } finally {
    await finish(setup, runner)
  }
})

test('runner: 再実行は新しい状態 directory・会話・worktree・branch を使い、前回の worktree は残り、本文に追加の指示と前回の結果が入る', async () => {
  const setup = await setupWithRepository()
  const prompts = new Map<string, string>()
  setup.models.script((view) => {
    prompts.set(view.taskKey, view.prompt)

    // 1回目の試行は検証が失敗する
    return completingStep(view, /^task-\d+-1-/u.test(view.taskKey)
      ? { command: FAIL_COMMAND, report: '1回目の報告です' }
      : { report: '2回目の報告です' })
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)
  const ledger = openLedger(setup)

  try {
    const failed = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    assert.equal(failed.task.status, 'failed')
    assert.equal(failed.attempts[0]?.failureReason, 'verification_failed')
    ledger.retryTask(taskId, { note: '検証のコマンドを直してから進めてください', confirmSideEffects: false })
    await waitUntil(() => {
      return ledger.getTask(taskId).attempt === 2 && ledger.getTask(taskId).status === 'completed'
    }, 'retry completes')
    const shown = ledger.showTask(taskId, { events: 500 })
    const [previous, retried] = shown.attempts
    const previousWorktree = records(previous?.evidence?.worktrees)[0]
    const retriedWorktree = records(retried?.evidence?.worktrees)[0]

    assert.equal(retried?.status, 'completed')
    assert.notEqual(retried?.taskKey, previous?.taskKey)
    assert.notEqual(retried?.stateDir, previous?.stateDir)
    assert.notEqual(retriedWorktree?.worktreePath, previousWorktree?.worktreePath)
    assert.notEqual(retriedWorktree?.branch, previousWorktree?.branch)
    // 前回の worktree は残る
    await fs.access(String(previousWorktree?.worktreePath))
    assert.deepEqual(retried?.evidence?.previousAttempt, {
      attempt: 1,
      worktrees: [{ worktreePath: previousWorktree?.worktreePath, branch: previousWorktree?.branch }]
    })
    const prompt = prompts.get(retried?.taskKey ?? '') ?? ''
    assert.match(prompt, /検証のコマンドを直してから進めてください/u)
    assert.match(prompt, /前回の試行（1回目）の結果/u)
    assert.match(prompt, /verification_failed/u)
    assert.match(prompt, /1回目の報告です/u)
    assert.ok(prompt.includes(`${String(previousWorktree?.worktreePath)}（branch ${String(previousWorktree?.branch)}）`))

    // 試行ごとに別の会話を使う
    assert.equal(await runner.stop(), 0)
    const harness = await Harness.open(await openNodeSqliteStorage(path.join(setup.fixture.dataDir, 'runner', 'durable.sqlite')), {
      models: setup.models.runtime,
      registry: createRegistry()
    }, ctx)

    try {
      const attempts = await harness.snapshot(AttemptsDoc, ctx)
      const keys = Object.values(attempts?.byConversation ?? {}).map((entry) => entry.taskKey).sort()
      assert.deepEqual(keys, [previous?.taskKey, retried?.taskKey].sort())
    } finally {
      await harness.close(ctx)
    }
  } finally {
    ledger.close()
    await finish(setup, runner)
  }
})

const SECRET = 'tok-secret-value-0123456789'
const USERINFO_URL = 'https://deploy-user:hunter2pass@example.invalid/repo.git'

async function runTaskShow(setup: RunnerSetup, args: string[]) {
  const stdout: string[] = []
  await runCli(['task', 'show', ...args], async () => {
    throw new Error('Pi を起動しない')
  }, { ARAYA_DATA_DIR: setup.fixture.dataDir, HOME: setup.fixture.home, PI_CODING_AGENT_DIR: setup.fixture.agentDir, ARAYA_TEST_TOKEN: SECRET }, {
    platform: 'linux',
    stdin: Readable.from([]),
    stdout: (text) => stdout.push(text),
    stderr: () => {}
  })
  const output: unknown = JSON.parse(stdout.join('\n'))

  return output
}

function attemptEvidence(output: unknown) {
  const attempt = isRecord(output) ? records(output.attempts)[0] : undefined

  return isRecord(attempt?.evidence) ? attempt.evidence : {}
}

test('runner: bash のコマンドと tool の結果の秘密が task_events と log に出ない', async () => {
  const setup = await setupWithRepository({ env: { ARAYA_TEST_TOKEN: SECRET } })
  setup.models.script((view) => {
    const results = view.toolResults

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1:
        return toolCall('bash', { command: `echo ${SECRET} ${USERINFO_URL}; printf '%s\\n' "$ARAYA_TEST_TOKEN"` })
      case 2:
        return toolCall('write', { path: `${worktreePathFrom(results[0])}/notes.txt`, content: `${SECRET}\n` })
      case 3:
        return toolCall('read', { path: `${worktreePathFrom(results[0])}/notes.txt` })
      case 4:
        return toolCall('araya_register_verification', { repository: 'repo', command: [...PASS_COMMAND] })
      default:
        return answer('終わりました')
    }
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)

  try {
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    assert.equal(shown.task.status, 'completed')
    const toolEvents = readEvents(setup.fixture).filter((event) => event.type === 'tool.started' || event.type === 'tool.finished')
    assert.deepEqual(toolEvents.filter((event) => event.type === 'tool.started').map((event) => isRecord(event.data) ? event.data.tool : undefined), [
      'araya_create_worktree',
      'bash',
      'write',
      'read',
      'araya_register_verification'
    ])
    const allowed = new Set(['tool', 'path', 'repository', 'base', 'cwd', 'isError'])

    for (const event of toolEvents) {
      assert.ok(isRecord(event.data))
      assert.deepEqual(Object.keys(event.data).filter((key) => !allowed.has(key)), [], JSON.stringify(event))
    }

    const events = JSON.stringify(readEvents(setup.fixture))
    const log = await readRunnerLog(setup.fixture)
    assert.ok(log.length > 0)

    for (const text of [events, log]) {
      assert.equal(text.includes(SECRET), false)
      assert.equal(text.includes('hunter2pass'), false)
      assert.equal(text.includes('echo '), false)
    }
  } finally {
    await finish(setup, runner)
  }
})

test('runner: 検証の出力と報告の秘密が台帳・evidence.json・log に出ず、redactions が残り、本文は show --full のときだけ出る', async () => {
  const setup = await setupWithRepository({ env: { ARAYA_TEST_TOKEN: SECRET } })
  const leakingCommand = [process.execPath, '-e', `console.log(process.env.ARAYA_TEST_TOKEN); console.error(${JSON.stringify(USERINFO_URL)})`]
  setup.models.script((view) => {
    const results = view.toolResults

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1:
        // 差分にも秘密を入れる
        return toolCall('bash', { command: `printf '%s\\n' "$ARAYA_TEST_TOKEN" >> ${worktreePathFrom(results[0])}/README.md` })
      case 2:
        return toolCall('araya_register_verification', { repository: 'repo', command: leakingCommand })
      default:
        return answer(`報告: token は ${SECRET}、remote は ${USERINFO_URL}`)
    }
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)

  try {
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    const attempt = shown.attempts[0]
    assert.equal(attempt?.status, 'completed')
    assert.equal(attempt?.summary, '報告: token は [REDACTED]、remote は https://[REDACTED]@example.invalid/repo.git')
    const evidence = attempt?.evidence ?? {}
    assert.equal(typeof evidence.redactions, 'number')
    assert.ok(Number(evidence.redactions) >= 4, String(evidence.redactions))

    // 台帳の evidence には差分と検証の出力の本文が無い
    const worktree = records(evidence.worktrees)[0]
    assert.equal(worktree !== undefined && 'diff' in worktree, false)
    const verification = records(worktree?.verifications)[0]
    assert.equal(verification?.status, 'passed')
    assert.equal(verification !== undefined && ('stdout' in verification || 'stderr' in verification), false)

    const evidenceFile = await fs.readFile(path.join(attempt?.stateDir ?? '', 'evidence.json'), 'utf8')
    const ledgerText = dumpLedger(setup.fixture)
    const log = await readRunnerLog(setup.fixture)

    for (const text of [ledgerText, evidenceFile, log]) {
      assert.equal(text.includes(SECRET), false)
      assert.equal(text.includes('hunter2pass'), false)
      assert.equal(text.includes('deploy-user'), false)
    }

    assert.match(evidenceFile, /\[REDACTED\]/u)

    // 既定の show は台帳の evidence、--full のときだけ evidence.json の本文を出す
    const plain = attemptEvidence(await runTaskShow(setup, [String(taskId)]))
    assert.equal(JSON.stringify(plain).includes('"diff"'), false)
    const full = attemptEvidence(await runTaskShow(setup, [String(taskId), '--full']))
    const fullWorktree = records(full.worktrees)[0]
    assert.match(String(fullWorktree?.diff), /\+\[REDACTED\]/u)
    const fullVerification = records(fullWorktree?.verifications)[0]
    assert.match(String(fullVerification?.stdout), /\[REDACTED\]/u)
    assert.match(String(fullVerification?.stderr), /https:\/\/\[REDACTED\]@example\.invalid/u)
    assert.equal(full.bodiesSha256, evidence.bodiesSha256)
    assert.equal(full.redactions, evidence.redactions)
  } finally {
    await finish(setup, runner)
  }
})

test('runner: 止めるように求められると試行を中止せずに 0 で終わり、running のまま stopped になり、起動し直すと続きから進む', async () => {
  const setup = await setupWithRepository()
  const pidFile = path.join(setup.fixture.root, 'bash.pid')
  const interrupted: { isError: boolean; text: string }[] = []
  setup.models.script((view) => {
    const results = view.toolResults

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1:
        return toolCall('bash', { command: `echo $$ > ${pidFile}; sleep 30` })
      case 2:
        interrupted.push({ isError: results[1]?.isError ?? false, text: results[1]?.text ?? '' })
        return toolCall('bash', { command: `printf 'changed\\n' >> ${worktreePathFrom(results[0])}/README.md` })
      case 3:
        return toolCall('araya_register_verification', { repository: 'repo', command: [...PASS_COMMAND] })
      default:
        return answer('再開して終わりました')
    }
  })
  const [taskId = 0] = createTasks(setup, 1)
  const firstRunner = startRunner(setup)
  const ledger = openLedger(setup)
  let secondRunner: StartedRunner | undefined

  try {
    const bashPid = await readPid(pidFile)
    const callsBeforeStop = setup.models.faux.state.callCount
    assert.equal(await firstRunner.stop(), 0)

    // 試行は中止されずに running のまま、runner は stopped
    const stopped = ledger.showTask(taskId, { events: 500 })
    assert.equal(stopped.task.status, 'running')
    assert.equal(stopped.attempts[0]?.stopReason, null)
    assert.equal(ledger.readRunner('', Date.now()).state, 'stopped')
    assert.equal(isAlive(bashPid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(setup.fixture.hash)), [])
    // Harness を閉じた後に scope を止める
    const types = setup.systemd.records().map((record) => record.type)
    assert.equal(types.at(-1), 'stop')
    assert.equal(setup.models.faux.state.callCount, callsBeforeStop)

    secondRunner = startRunner(setup)
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    const attempt = shown.attempts[0]

    assert.equal(attempt?.status, 'completed')
    assert.equal(attempt?.summary, '再開して終わりました')
    assert.equal(attempt?.evidence?.resumes, 1)
    assert.equal(shown.events.filter((event) => event.type === 'run.resumed').length, 1)
    assert.equal(shown.events.filter((event) => event.type === 'run.finished').length, 1)
    // 途中だった bash は interrupted の誤りとして model に返る
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0]?.isError, true)
    assert.match(interrupted[0]?.text ?? '', /interrupted/u)
    assert.equal(ledger.readRunner('', Date.now()).state, 'running')
  } finally {
    ledger.close()
    await finish(setup, secondRunner ?? firstRunner)
  }
})

test('runner: 設定ファイルが不正な間は取り込まずに log に1回だけ書き、直すと次の loop で取り込む', async () => {
  const setup = await setupWithRepository({ env: { ARAYA_TEST_TOKEN: SECRET } })
  const configPath = path.join(setup.fixture.dataDir, 'config.json')
  // 誤りの message に秘密の値が入る（未知の key の名前）
  await fs.writeFile(configPath, JSON.stringify({ [SECRET]: true }), 'utf8')
  setup.models.script((view) => {
    return completingStep(view)
  })
  const [taskId = 0] = createTasks(setup, 1)
  const runner = startRunner(setup)
  const ledger = openLedger(setup)

  try {
    await waitUntil(async () => {
      return parseLogLines(await readRunnerLog(setup.fixture)).some((entry) => entry.type === 'config_file_invalid')
    }, 'config_file_invalid')
    // 何回 loop しても、取り込まず、同じ誤りは1回だけ書く
    setup.clock.advance(10_000)
    await waitUntil(() => {
      return ledger.readRunner('', Date.now()).heartbeatAt !== ledger.readRunner('', Date.now()).startedAt
    }, 'heartbeat while the config is invalid')
    assert.equal(ledger.getTask(taskId).status, 'queued')
    const invalid = parseLogLines(await readRunnerLog(setup.fixture)).filter((entry) => entry.type === 'config_file_invalid')
    assert.equal(invalid.length, 1)
    assert.match(String(invalid[0]?.message), /\[REDACTED\]/u)
    assert.equal((await readRunnerLog(setup.fixture)).includes(SECRET), false)

    await writeModelConfig(setup.fixture, setup.models.model)
    assert.equal((await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])).task.status, 'completed')
  } finally {
    ledger.close()
    await finish(setup, runner)
  }
})
