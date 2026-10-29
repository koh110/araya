import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { exitCodeOf, runCli, UNSUPPORTED_ENVIRONMENT_EXIT_CODE } from '../src/cli.ts'
import type { TaskCommandDependencies } from '../src/task-commands.ts'
import { openTaskLedger, type AttemptResult, type AttemptSettings, type TaskLedger } from '../src/task-ledger.ts'

const CLI_PATH = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))

type TaskEnv = { root: string; dataDir: string; env: NodeJS.ProcessEnv }

async function makeTaskEnv() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-task-cli-test-')))
  const dataDir = path.join(root, 'data')
  const taskEnv: TaskEnv = {
    root,
    dataDir,
    env: { ARAYA_DATA_DIR: dataDir, HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'pi-agent') }
  }

  return taskEnv
}

function expectedUnit(dataDirReal: string) {
  return `araya-runner-${createHash('sha256').update(dataDirReal, 'utf8').digest('hex').slice(0, 12)}.service`
}

async function startPiMustNotRun() {
  throw new Error('Pi を起動しない')
}

async function runTask(taskEnv: TaskEnv, args: string[], deps: Partial<TaskCommandDependencies> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  await runCli(['task', ...args], startPiMustNotRun, taskEnv.env, {
    platform: 'linux',
    stdin: Readable.from([]),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    ...deps
  })
  const output: unknown = JSON.parse(stdout.join('\n'))

  return { output, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

function rejectsWithCode(taskEnv: TaskEnv, args: string[], code: string, deps: Partial<TaskCommandDependencies> = {}) {
  return assert.rejects(runTask(taskEnv, args, deps), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok('code' in error)
    assert.equal(error.code, code, error.message)
    assert.ok(error.message.startsWith(`${code}: `), error.message)

    return true
  })
}

function readJsonField(value: unknown, ...keys: (string | number)[]): unknown {
  let current = value

  for (const key of keys) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }

    current = Reflect.get(current, key)
  }

  return current
}

function readArray(value: unknown, ...keys: (string | number)[]) {
  const array = readJsonField(value, ...keys)
  assert.ok(Array.isArray(array), `${keys.join('.')} must be an array`)

  return array
}

function settings() {
  const value: AttemptSettings = {
    devRoot: '/tmp/araya-dev-root',
    agentDir: '/tmp/araya-agent-dir',
    model: null,
    timeoutMs: 1_200_000,
    verificationTimeoutMs: 300_000
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
    model: null,
    evidence: { outcome: 'completed', worktrees: [] },
    ...overrides
  }

  return value
}

// 最も古い待ちの試行を取り込んで結果を記録する（runner の代わり）
function finishNext(ledger: TaskLedger, attemptResult: AttemptResult) {
  const claimed = ledger.claimNextAttempt(1, settings())
  assert.ok(claimed)
  ledger.recordResult(claimed.taskKey, attemptResult, { taskKey: claimed.taskKey, addMs: 0 })

  return claimed
}

async function writeInput(taskEnv: TaskEnv, value: unknown, name = 'task.json') {
  const filePath = path.join(taskEnv.root, name)
  await fs.writeFile(filePath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

  return filePath
}

async function spawnCli(args: string[], env: NodeJS.ProcessEnv, stdin = '') {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: 'pipe' })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
    child.stdin.end(stdin)
  })

  return { exit, stdout: stdout.join(''), stderr: stderr.join('') }
}

// systemctl・systemd-run・loginctl が呼ばれたら記録する偽物を PATH に置く
async function makeFakeSystemdPath(root: string) {
  const binDir = path.join(root, 'fake-bin')
  const marker = path.join(root, 'systemd-called.log')
  await fs.mkdir(binDir)

  for (const name of ['systemctl', 'systemd-run', 'loginctl']) {
    await fs.writeFile(path.join(binDir, name), `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`, { mode: 0o755 })
  }

  return { binDir, marker }
}

test('task create: 正しい入力で Task と queued の試行を作り、runner を起動しない', async () => {
  const taskEnv = await makeTaskEnv()
  const { binDir, marker } = await makeFakeSystemdPath(taskEnv.root)
  const env = { ...taskEnv.env, PATH: binDir }

  try {
    const inputPath = await writeInput(taskEnv, {
      title: '空の入力を拒否する',
      goal: 'araya の CLI で、空の値を受け取ったら理由を表示して終了するようにし、既存のテストに回帰ケースを追加する',
      constraints: ['依存を追加しない'],
      targets: ['araya'],
      permissions: [],
      idempotencyKey: 'example-1'
    })
    const fromFile = await spawnCli(['task', 'create', '--file', inputPath], env)

    assert.deepEqual(fromFile.exit, { code: 0, signal: null })
    const created: unknown = JSON.parse(fromFile.stdout)
    assert.equal(readJsonField(created, 'created'), true)
    assert.equal(readJsonField(created, 'task', 'id'), 1)
    assert.equal(readJsonField(created, 'task', 'status'), 'queued')
    assert.equal(readJsonField(created, 'task', 'attempt'), 1)
    assert.deepEqual(readJsonField(created, 'task', 'constraints'), ['依存を追加しない'])
    assert.deepEqual(readJsonField(created, 'queue'), { limit: 1, running: 0, queued: 1 })
    assert.equal(readJsonField(created, 'runner', 'state'), 'not_started')
    assert.equal(readJsonField(created, 'runner', 'unit'), expectedUnit(taskEnv.dataDir))
    assert.equal(
      fromFile.stderr,
      `runner が動いていません（not_started）。araya runner install で入れるか、systemctl --user start ${expectedUnit(taskEnv.dataDir)} で起動してください\n`
    )

    const fromStdin = await spawnCli(['task', 'create', '--file', '-'], env, JSON.stringify({ title: 'stdin', goal: 'stdin から読む' }))
    assert.deepEqual(fromStdin.exit, { code: 0, signal: null })
    assert.equal(readJsonField(JSON.parse(fromStdin.stdout), 'task', 'id'), 2)

    // 同じ idempotencyKey は同じ Task を返す
    const again = await spawnCli(['task', 'create', '--file', inputPath], env)
    assert.equal(readJsonField(JSON.parse(again.stdout), 'created'), false)
    assert.equal(readJsonField(JSON.parse(again.stdout), 'task', 'id'), 1)

    await assert.rejects(fs.access(marker))

    const ledger = openTaskLedger(taskEnv.dataDir)

    try {
      assert.deepEqual(ledger.listTasks({ limit: 50 }).map((task) => [task.id, task.status]), [[2, 'queued'], [1, 'queued']])
      assert.equal(ledger.listRunningAttempts().length, 0)
    } finally {
      ledger.close()
    }
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task create: 未知の key・長さと件数の超過・256 KiB 超・NUL・空白だけの値を終了 code 1 で拒否する', async () => {
  const taskEnv = await makeTaskEnv()
  const valid = { title: 't', goal: 'g' }
  const invalidInputs: [string, unknown][] = [
    ['未知の key', { ...valid, priority: 1 }],
    ['title が無い', { goal: 'g' }],
    ['goal が無い', { title: 't' }],
    ['title が 200 文字超', { ...valid, title: 'x'.repeat(201) }],
    ['title が改行を含む', { ...valid, title: 'a\nb' }],
    ['title が空白だけ', { ...valid, title: ' \t　' }],
    ['title が NUL を含む', { ...valid, title: 'a\0b' }],
    ['goal が 20,000 文字超', { ...valid, goal: 'x'.repeat(20_001) }],
    ['goal が空白だけ', { ...valid, goal: '   ' }],
    ['goal が NUL を含む', { ...valid, goal: 'a\0b' }],
    ['constraints が 32 件超', { ...valid, constraints: Array.from({ length: 33 }, () => 'c') }],
    ['constraints の合計が 10,000 文字超', { ...valid, constraints: ['x'.repeat(5000), 'y'.repeat(5001)] }],
    ['constraints の要素が空白だけ', { ...valid, constraints: ['ok', ' '] }],
    ['constraints が配列でない', { ...valid, constraints: 'c' }],
    ['targets が 16 件超', { ...valid, targets: Array.from({ length: 17 }, () => 't') }],
    ['targets の要素が 200 文字超', { ...valid, targets: ['x'.repeat(201)] }],
    ['targets の要素が文字列でない', { ...valid, targets: [1] }],
    ['permissions が 16 件超', { ...valid, permissions: Array.from({ length: 17 }, () => 'p') }],
    ['permissions の合計が 5,000 文字超', { ...valid, permissions: ['x'.repeat(2500), 'y'.repeat(2501)] }],
    ['permissions の要素が NUL を含む', { ...valid, permissions: ['a\0'] }],
    ['idempotencyKey が空', { ...valid, idempotencyKey: '' }],
    ['idempotencyKey が 200 文字超', { ...valid, idempotencyKey: 'k'.repeat(201) }],
    ['idempotencyKey が null', { ...valid, idempotencyKey: null }],
    ['object でない', [valid]],
    ['JSON でない', '{"title":'],
    ['256 KiB 超', JSON.stringify({ ...valid, goal: 'g', padding: ' '.repeat(256 * 1024) })],
    ['256 KiB 超（空白で水増し）', `${JSON.stringify(valid)}${' '.repeat(256 * 1024)}`]
  ]

  try {
    for (const [name, value] of invalidInputs) {
      const inputPath = await writeInput(taskEnv, value)
      await assert.rejects(runTask(taskEnv, ['create', '--file', inputPath]), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /^invalid_task_input: /u, name)

        return true
      }, name)
    }

    // UTF-8 でない入力
    const binaryPath = path.join(taskEnv.root, 'binary.json')
    await fs.writeFile(binaryPath, Buffer.from([0x7b, 0xff, 0x7d]))
    await rejectsWithCode(taskEnv, ['create', '--file', binaryPath], 'invalid_task_input')

    // 256 KiB ちょうどは受け付ける
    const exact = `${JSON.stringify(valid)}`
    const exactPath = await writeInput(taskEnv, exact.padEnd(256 * 1024, ' '), 'exact.json')
    assert.equal((await fs.stat(exactPath)).size, 256 * 1024)

    const ledger = openTaskLedger(taskEnv.dataDir)

    try {
      assert.equal(ledger.listTasks({ limit: 50 }).length, 0)
    } finally {
      ledger.close()
    }

    const accepted = await runTask(taskEnv, ['create', '--file', exactPath])
    assert.equal(readJsonField(accepted.output, 'created'), true)

    // process としては終了 code 1 で、stderr に理由を出し、stdout には何も出さない
    const unknownKeyPath = await writeInput(taskEnv, { ...valid, priority: 1 }, 'unknown.json')
    const spawned = await spawnCli(['task', 'create', '--file', unknownKeyPath], { ...taskEnv.env, PATH: process.env.PATH })
    assert.deepEqual(spawned.exit, { code: 1, signal: null })
    assert.equal(spawned.stdout, '')
    assert.equal(spawned.stderr, 'invalid_task_input: unknown key(s): priority\n')

    const after = openTaskLedger(taskEnv.dataDir)

    try {
      assert.equal(after.listTasks({ limit: 50 }).length, 1)
    } finally {
      after.close()
    }

    await rejectsWithCode(taskEnv, ['create'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['create', '--file', path.join(taskEnv.root, 'missing.json')], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['create', '--file', exactPath, '--unknown'], 'invalid_arguments')
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task create: 同じ idempotencyKey で値が違えば idempotency_conflict で拒否する', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const first = await writeInput(taskEnv, { title: 't', goal: 'g', idempotencyKey: 'k' }, 'first.json')
    const second = await writeInput(taskEnv, { title: 't', goal: 'g2', idempotencyKey: 'k' }, 'second.json')
    await runTask(taskEnv, ['create', '--file', first])
    await rejectsWithCode(taskEnv, ['create', '--file', second], 'idempotency_conflict')
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task: Linux 以外では unsupported_platform で何もしない', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })

    for (const args of [['create', '--file', inputPath], ['list'], ['show', '1'], ['retry', '1'], ['cancel', '1']]) {
      await rejectsWithCode(taskEnv, args, 'unsupported_platform', { platform: 'darwin' })
    }

    await assert.rejects(fs.access(taskEnv.dataDir))
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task: 設定ファイルが不正なら台帳を開かずに失敗する', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    await fs.mkdir(taskEnv.dataDir)
    await fs.writeFile(path.join(taskEnv.dataDir, 'config.json'), '{"unknown": true}', 'utf8')

    await assert.rejects(runTask(taskEnv, ['list']), /invalid Araya config file/u)
    assert.deepEqual(await fs.readdir(taskEnv.dataDir), ['config.json'])
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('CLI: この環境では使えない誤り（unsupported_platform・systemd_unavailable）は終了 code 69、ほかの誤りは終了 code 1 で終わる', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    assert.equal(UNSUPPORTED_ENVIRONMENT_EXIT_CODE, 69)
    // Linux 以外で runCli が投げる誤り
    const unsupported = await runCli(['runner', 'install'], startPiMustNotRun, taskEnv.env, { platform: 'darwin' }).then(() => null, (error: unknown) => error)
    assert.equal(exitCodeOf(unsupported), 69)
    // ほかの code の誤りと、code の無い誤りは 1（message が code の形でも、code が無ければ 1）
    assert.equal(exitCodeOf(Object.assign(new Error('unsupported_path: test'), { code: 'unsupported_path' })), 1)
    assert.equal(exitCodeOf(new Error('systemd_unavailable: test')), 1)
    assert.equal(exitCodeOf('systemd_unavailable'), 1)

    // process の終了 code。PATH に systemd-run・systemctl・bash が無ければ systemd_unavailable で 69
    const emptyDir = path.join(taskEnv.root, 'empty-bin')
    await fs.mkdir(emptyDir)
    const unavailable = await spawnCli(['runner', 'install'], { ...taskEnv.env, PATH: emptyDir })
    assert.deepEqual(unavailable.exit, { code: 69, signal: null })
    assert.equal(unavailable.stdout, '')
    assert.equal(unavailable.stderr, 'systemd_unavailable: PATH に systemd-run・systemctl・bash がありません\n')

    // 設定ファイルの誤りは 1
    await fs.mkdir(taskEnv.dataDir, { recursive: true })
    await fs.writeFile(path.join(taskEnv.dataDir, 'config.json'), '{"unknown": true}', 'utf8')
    const invalidConfig = await spawnCli(['runner', 'install'], { ...taskEnv.env, PATH: emptyDir })
    assert.deepEqual(invalidConfig.exit, { code: 1, signal: null })
    assert.match(invalidConfig.stderr, /^invalid Araya config file /u)
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task list: runner の行が無ければ not_started、stopped、60 秒より前の heartbeat は not_responding で、stderr に注意が出る', async () => {
  const taskEnv = await makeTaskEnv()
  const now = Date.parse('2026-10-24T00:10:00.000Z')
  const deps = { nowMs: () => now }

  try {
    const notStarted = await runTask(taskEnv, ['list'], deps)
    const unit = expectedUnit(taskEnv.dataDir)
    assert.deepEqual(readJsonField(notStarted.output, 'runner'), {
      unit, state: 'not_started', pid: null, startedAt: null, heartbeatAt: null, stoppedAt: null
    })
    assert.deepEqual(readJsonField(notStarted.output, 'tasks'), [])
    assert.equal(notStarted.stderr, `runner が動いていません（not_started）。araya runner install で入れるか、systemctl --user start ${unit} で起動してください`)

    let wall = now
    const ledger = openTaskLedger(taskEnv.dataDir, { now: () => new Date(wall) })

    try {
      ledger.markRunnerStarted({ unit, invocationId: 'inv-1', pid: 4321 })
      const running = await runTask(taskEnv, ['list'], deps)
      assert.equal(readJsonField(running.output, 'runner', 'state'), 'running')
      assert.equal(readJsonField(running.output, 'runner', 'pid'), 4321)
      assert.equal(running.stderr, '')

      wall = now - 60_001
      ledger.heartbeat('inv-1', [])
      const notResponding = await runTask(taskEnv, ['list'], deps)
      assert.equal(readJsonField(notResponding.output, 'runner', 'state'), 'not_responding')
      assert.match(notResponding.stderr, /^runner が動いていません（not_responding）。/u)

      wall = now
      ledger.markRunnerStopped('inv-1', [])
      const stopped = await runTask(taskEnv, ['list'], deps)
      assert.equal(readJsonField(stopped.output, 'runner', 'state'), 'stopped')
      assert.equal(readJsonField(stopped.output, 'runner', 'stoppedAt'), '2026-10-24T00:10:00.000Z')
      assert.match(stopped.stderr, /^runner が動いていません（stopped）。/u)

      // ほかの command も同じ注意を出す
      const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })
      const created = await runTask(taskEnv, ['create', '--file', inputPath], deps)
      assert.match(created.stderr, /^runner が動いていません（stopped）。/u)
      assert.match((await runTask(taskEnv, ['show', '1'], deps)).stderr, /（stopped）/u)
      assert.match((await runTask(taskEnv, ['cancel', '1'], deps)).stderr, /（stopped）/u)
      assert.match((await runTask(taskEnv, ['retry', '1'], deps)).stderr, /（stopped）/u)
    } finally {
      ledger.close()
    }
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task list: --status と --limit で絞り、Task ID の大きい順に出す', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })

    for (let index = 0; index < 4; index += 1) {
      await runTask(taskEnv, ['create', '--file', inputPath])
    }

    const ledger = openTaskLedger(taskEnv.dataDir)

    try {
      finishNext(ledger, result({ status: 'failed', failureReason: 'verification_failed' }))
    } finally {
      ledger.close()
    }

    const all = await runTask(taskEnv, ['list'])
    assert.equal(readArray(all.output, 'tasks').length, 4)
    assert.deepEqual(readJsonField(all.output, 'tasks', 0), {
      id: 4,
      title: 't',
      status: 'queued',
      attempt: 1,
      failureReason: null,
      decisionQuestion: null,
      createdAt: readJsonField(all.output, 'tasks', 0, 'createdAt'),
      updatedAt: readJsonField(all.output, 'tasks', 0, 'updatedAt')
    })
    assert.deepEqual(readJsonField(all.output, 'queue'), { limit: 1, running: 0, queued: 3 })

    const limited = await runTask(taskEnv, ['list', '--limit', '2'])
    assert.deepEqual([readJsonField(limited.output, 'tasks', 0, 'id'), readJsonField(limited.output, 'tasks', 1, 'id'), readJsonField(limited.output, 'tasks', 2)], [4, 3, undefined])

    const failed = await runTask(taskEnv, ['list', '--status', 'failed'])
    assert.equal(readJsonField(failed.output, 'tasks', 0, 'id'), 1)
    assert.equal(readJsonField(failed.output, 'tasks', 0, 'failureReason'), 'verification_failed')
    assert.equal(readJsonField(failed.output, 'tasks', 1), undefined)

    await rejectsWithCode(taskEnv, ['list', '--status', 'done'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['list', '--limit', '0'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['list', '--limit', '201'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['list', '--limit', '1.5'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['unknown'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, [], 'invalid_arguments')
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task cancel: queued はその場で failed（cancelled）、completed・failed・blocked は task_not_cancellable', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })

    for (let index = 0; index < 5; index += 1) {
      await runTask(taskEnv, ['create', '--file', inputPath])
    }

    const cancelled = await runTask(taskEnv, ['cancel', '1'])
    assert.equal(readJsonField(cancelled.output, 'cancel'), 'cancelled')
    assert.equal(readJsonField(cancelled.output, 'task', 'status'), 'failed')
    assert.equal(readJsonField(cancelled.output, 'task', 'failureReason'), 'cancelled')
    assert.deepEqual(readJsonField(cancelled.output, 'queue'), { limit: 1, running: 0, queued: 4 })

    const ledger = openTaskLedger(taskEnv.dataDir)

    try {
      // 中止した試行は取り込まれない
      assert.equal(finishNext(ledger, result()).taskId, 2)
      finishNext(ledger, result({ status: 'failed', failureReason: 'no_changes' }))
      finishNext(ledger, result({ status: 'blocked', decisionQuestion: 'どちら？' }))
      assert.equal(ledger.claimNextAttempt(1, settings())?.taskId, 5)
    } finally {
      ledger.close()
    }

    for (const taskId of ['1', '2', '3', '4']) {
      await rejectsWithCode(taskEnv, ['cancel', taskId], 'task_not_cancellable')
    }

    const requested = await runTask(taskEnv, ['cancel', '5'])
    assert.equal(readJsonField(requested.output, 'cancel'), 'requested')
    assert.equal(readJsonField(requested.output, 'task', 'status'), 'running')
    assert.equal(readJsonField(requested.output, 'task', 'cancelRequested'), true)
    assert.equal(readJsonField(await runTask(taskEnv, ['cancel', '5']).then((run) => run.output), 'cancel'), 'already_requested')

    await rejectsWithCode(taskEnv, ['cancel', '99'], 'task_not_found')
    await rejectsWithCode(taskEnv, ['cancel', '0'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['cancel', '01'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['cancel', 'x'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['cancel'], 'invalid_arguments')
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task retry: 外部変更の可能性がある試行は --confirm-side-effects が無ければ前回の worktree を出して拒否し、付けると再実行する', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })
    await runTask(taskEnv, ['create', '--file', inputPath])
    const ledger = openTaskLedger(taskEnv.dataDir)

    try {
      finishNext(ledger, result({
        status: 'failed',
        failureReason: 'agent_timeout',
        evidence: { outcome: 'failed', worktrees: [{ worktreePath: '/home/u/dev/repo/.worktree/araya-task-1-1-aaaaaa', branch: 'araya/task-1-1-aaaaaa' }] }
      }))
    } finally {
      ledger.close()
    }

    await assert.rejects(runTask(taskEnv, ['retry', '1']), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, [
        'side_effects_unconfirmed: 前回の試行では外部の branch や Draft PR が作成・更新された可能性がある、または結果を確認できません。前回の worktree と GitHub の状態を確かめてから、--confirm-side-effects を付けて再実行してください',
        '前回の worktree:',
        '  - /home/u/dev/repo/.worktree/araya-task-1-1-aaaaaa（branch araya/task-1-1-aaaaaa）'
      ].join('\n'))

      return true
    })

    const shownBefore = await runTask(taskEnv, ['show', '1'])
    assert.equal(readArray(shownBefore.output, 'attempts').length, 1)

    const retried = await runTask(taskEnv, ['retry', '1', '--confirm-side-effects', '--note', '外部の状態は確かめた'])
    assert.equal(readJsonField(retried.output, 'task', 'status'), 'queued')
    assert.equal(readJsonField(retried.output, 'task', 'attempt'), 2)

    const shown = await runTask(taskEnv, ['show', '1'])
    assert.equal(readJsonField(shown.output, 'attempts', 1, 'note'), '外部の状態は確かめた')
    assert.deepEqual(readJsonField(shown.output, 'events', 3), {
      seq: readJsonField(shown.output, 'events', 3, 'seq'),
      attempt: 2,
      at: readJsonField(shown.output, 'events', 3, 'at'),
      type: 'task.retried',
      data: { hasNote: true, confirmedSideEffects: true }
    })

    await rejectsWithCode(taskEnv, ['retry', '1'], 'task_not_retryable')
    await rejectsWithCode(taskEnv, ['retry', '99'], 'task_not_found')
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task retry: 追加の指示は --note・--note-file・stdin から読み、同時指定と 10,000 文字超と NUL を拒否する', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })
    await runTask(taskEnv, ['create', '--file', inputPath])
    const ledger = openTaskLedger(taskEnv.dataDir)

    function failLatest() {
      finishNext(ledger, result({ status: 'failed', failureReason: 'verification_failed' }))
    }

    try {
      failLatest()
      const notePath = path.join(taskEnv.root, 'note.txt')
      await fs.writeFile(notePath, '質問への答え: A にする\n', 'utf8')

      await rejectsWithCode(taskEnv, ['retry', '1', '--note', 'a', '--note-file', notePath], 'invalid_arguments')
      await rejectsWithCode(taskEnv, ['retry', '1', '--note', 'n'.repeat(10_001)], 'invalid_note')
      await rejectsWithCode(taskEnv, ['retry', '1', '--note', 'a\0b'], 'invalid_note')
      await fs.writeFile(path.join(taskEnv.root, 'long.txt'), 'あ'.repeat(10_001), 'utf8')
      await rejectsWithCode(taskEnv, ['retry', '1', '--note-file', path.join(taskEnv.root, 'long.txt')], 'invalid_note')
      await fs.writeFile(path.join(taskEnv.root, 'binary.txt'), Buffer.from([0xff]))
      await rejectsWithCode(taskEnv, ['retry', '1', '--note-file', path.join(taskEnv.root, 'binary.txt')], 'invalid_note')

      await runTask(taskEnv, ['retry', '1', '--note-file', notePath])
      failLatest()
      await runTask(taskEnv, ['retry', '1', '--note-file', '-'], { stdin: Readable.from([Buffer.from('stdin の指示')]) })
      failLatest()
      // 10,000 文字ちょうど（3 byte の文字）は受け付ける
      await fs.writeFile(path.join(taskEnv.root, 'exact.txt'), 'あ'.repeat(10_000), 'utf8')
      await runTask(taskEnv, ['retry', '1', '--note-file', path.join(taskEnv.root, 'exact.txt')])
      failLatest()
      await runTask(taskEnv, ['retry', '1'])
    } finally {
      ledger.close()
    }

    const shown = await runTask(taskEnv, ['show', '1'])
    const attempts = readJsonField(shown.output, 'attempts')
    assert.ok(Array.isArray(attempts))
    assert.deepEqual(attempts.map((attempt: unknown) => {
      const note = readJsonField(attempt, 'note')

      return typeof note === 'string' && note.length === 10_000 ? 'あ×10000' : note
    }), [null, '質問への答え: A にする\n', 'stdin の指示', 'あ×10000', null])
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})

test('task show: events は新しいものから指定の件数を seq の昇順で出し、--full は一致する evidence.json の本文を出す', async () => {
  const taskEnv = await makeTaskEnv()

  try {
    const inputPath = await writeInput(taskEnv, { title: 't', goal: 'g' })

    for (let index = 0; index < 5; index += 1) {
      await runTask(taskEnv, ['create', '--file', inputPath])
    }

    const stateRoot = path.join(taskEnv.dataDir, 'development')
    const ledger = openTaskLedger(taskEnv.dataDir)
    const bodies = { worktrees: [{ worktreePath: '/w', branch: 'b', diff: 'diff --git a/x b/x', verifications: [{ stdout: 'ok' }] }] }
    const bodiesText = JSON.stringify(bodies)
    const bodiesSha256 = createHash('sha256').update(bodiesText).digest('hex')
    const ledgerEvidence = { outcome: 'completed', worktrees: [{ worktreePath: '/w', branch: 'b' }], bodiesStored: true, bodiesSha256 }

    // 1: 一致する evidence.json、2: 書き換えた evidence.json、3: file が無い、4: 読めない、5: 本文を残していない
    try {
      for (let index = 1; index <= 5; index += 1) {
        const claimed = ledger.claimNextAttempt(1, settings())
        assert.ok(claimed)
        const stateDir = path.join(stateRoot, claimed.taskKey)
        await fs.mkdir(stateDir, { recursive: true })
        ledger.recordStateDir(claimed.taskKey, stateDir)

        if (index === 1) {
          await fs.writeFile(path.join(stateDir, 'evidence.json'), bodiesText)
        } else if (index === 2) {
          await fs.writeFile(path.join(stateDir, 'evidence.json'), bodiesText.replace('ok', 'changed'))
        } else if (index === 4) {
          await fs.mkdir(path.join(stateDir, 'evidence.json'))
        }

        ledger.recordResult(claimed.taskKey, result({
          evidence: index === 5 ? { ...ledgerEvidence, bodiesStored: false } : ledgerEvidence
        }), { taskKey: claimed.taskKey, addMs: 0 })
      }

      for (let index = 0; index < 3; index += 1) {
        ledger.appendRunResumed(ledger.showTask(1, { events: 0 }).attempts[0]?.taskKey ?? '')
      }
    } finally {
      ledger.close()
    }

    const shown = await runTask(taskEnv, ['show', '1', '--events', '2'])
    const events = readJsonField(shown.output, 'events')
    assert.ok(Array.isArray(events))
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((event: unknown) => readJsonField(event, 'type')), ['run.resumed', 'run.resumed'])
    assert.ok(Number(readJsonField(events, 0, 'seq')) < Number(readJsonField(events, 1, 'seq')))
    assert.deepEqual(readJsonField(shown.output, 'attempts', 0, 'evidence', 'worktrees'), [{ worktreePath: '/w', branch: 'b' }])
    assert.equal(readJsonField(shown.output, 'attempts', 0, 'fullEvidenceError'), undefined)
    assert.deepEqual(readJsonField(await runTask(taskEnv, ['show', '1', '--events', '0']).then((run) => run.output), 'events'), [])
    assert.equal(readArray((await runTask(taskEnv, ['show', '1'])).output, 'events').length, 6)

    const full = await runTask(taskEnv, ['show', '1', '--full'])
    assert.deepEqual(readJsonField(full.output, 'attempts', 0, 'evidence'), {
      ...ledgerEvidence,
      worktrees: bodies.worktrees,
      resumes: 0,
      activeMs: 0
    })
    assert.equal(readJsonField(full.output, 'attempts', 0, 'fullEvidenceError'), undefined)

    const expectedErrors: [string, string][] = [['2', 'digest_mismatch'], ['3', 'missing'], ['4', 'unreadable'], ['5', 'not_stored']]

    for (const [taskId, fullEvidenceError] of expectedErrors) {
      const output = (await runTask(taskEnv, ['show', taskId, '--full'])).output
      assert.equal(readJsonField(output, 'attempts', 0, 'fullEvidenceError'), fullEvidenceError, taskId)
      assert.deepEqual(readJsonField(output, 'attempts', 0, 'evidence', 'worktrees'), [{ worktreePath: '/w', branch: 'b' }])
    }

    await rejectsWithCode(taskEnv, ['show', '1', '--events', '501'], 'invalid_arguments')
    await rejectsWithCode(taskEnv, ['show', '99'], 'task_not_found')
    await rejectsWithCode(taskEnv, ['show'], 'invalid_arguments')
  } finally {
    await fs.rm(taskEnv.root, { recursive: true, force: true })
  }
})
