import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { createRegistry, defineExtension, Harness } from '@earendil-works/pi-durable'

import { loadConfig } from '../src/config.ts'
import { parseCliArguments } from '../src/arguments.ts'
import { runCli } from '../src/cli.ts'
import { openControlPlane } from '../src/control-plane.ts'
import { approveOpportunity, initAraya, tickAraya, statusAraya } from '../src/operations.ts'
import { readObservationSource } from '../src/observations.ts'
import { createArayaModelRuntime, MAIN_GOAL_ID } from '../src/runtime.ts'
import { createArayaTasks, TASK_NAMES } from '../src/tasks.ts'

async function makeConfig(): Promise<{ dir: string; config: ReturnType<typeof loadConfig> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-test-'))
  const config = loadConfig({
    ARAYA_DATA_DIR: dir,
    ARAYA_INTERVAL_MS: '1000',
    ARAYA_MAX_ACTIONS: '10',
    PI_CODING_AGENT_DIR: path.join(dir, 'pi-agent')
  })

  return { dir, config }
}

async function leavePendingScoutTask(config: ReturnType<typeof loadConfig>): Promise<void> {
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'external.jsonl'),
    `${JSON.stringify({ id: 'candidate:pending-status', title: '外部操作', risk: 'external', payload: {} })}\n`,
    'utf8'
  )

  const controlPlane = openControlPlane(config.controlPlanePath)

  try {
    controlPlane.ensureGoal(MAIN_GOAL_ID, 'test goal', config.intervalMs, Date.now())
    const tasks = createArayaTasks(controlPlane, config.inboxDir, MAIN_GOAL_ID, config.intervalMs)
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
    const storage = await openNodeSqliteStorage(config.piDurablePath)
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: 'araya',
        tasks: [tasks.ScoutTask, tasks.WorkTask]
      })
    )

    const harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT)

    try {
      const root = await harness.root(BACKGROUND_CONTEXT)
      await root.commit(
        (tx) => tx.createTask(
          tasks.ScoutTask,
          { tickId: 'tick:pending-status', maxActions: config.maxActions },
          { ownership: { kind: 'conversation' } }
        ),
        BACKGROUND_CONTEXT
      )
    } finally {
      await harness.close(BACKGROUND_CONTEXT)
    }
  } finally {
    controlPlane.close()
  }
}

async function runArayaCliWithoutPiBinary(args: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-no-pi-cli-test-'))
  const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: dir, PATH: dir },
    stdio: 'pipe'
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.stdin.end()
    })

    return { result, stdout: stdout.join(''), stderr: stderr.join('') }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('runtime: Pi auth.json credentials are available to durable model calls', async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-pi-auth-test-'))
  await fs.writeFile(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'test-only-not-a-real-credential' } }),
    'utf8'
  )

  try {
    const models = await createArayaModelRuntime(agentDir)
    const auth = await models.getAuth('openai')

    assert.equal(auth?.auth.apiKey, 'test-only-not-a-real-credential')
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true })
  }
})

test('config: Pi agent directory is taken from the shared environment variable', () => {
  const agentDir = path.join(os.tmpdir(), 'araya-shared-pi-agent')
  const config = loadConfig({ PI_CODING_AGENT_DIR: agentDir })

  assert.equal(config.piAgentDir, agentDir)
})

test('config: 開発 root と timeout の範囲を設定から読む', () => {
  const config = loadConfig({
    ARAYA_DATA_DIR: '/tmp/araya-config-test',
    ARAYA_DEV_ROOT: '/workspace/dev/../dev',
    ARAYA_DEVELOPMENT_TIMEOUT_MS: '7000000',
    ARAYA_VERIFICATION_TIMEOUT_MS: '500'
  })

  assert.equal(config.devRoot, '/workspace/dev')
  assert.equal('projectDir' in config, false)
  assert.equal('worktreeDir' in config, false)
  assert.equal(config.developmentTimeoutMs, 60 * 60 * 1000)
  assert.equal(config.verificationTimeoutMs, 1000)
})

test('config: 設定ファイルの path は data directory の config.json で、設定ファイルの値を受け取らなければ model を指定しない', () => {
  const config = loadConfig({ ARAYA_DATA_DIR: '/tmp/araya-config-test' })

  assert.equal(config.configPath, '/tmp/araya-config-test/config.json')
  assert.equal(config.developmentModel, null)
  assert.equal(loadConfig({}).configPath, path.join(os.homedir(), '.araya', 'config.json'))
})

test('config: 開発 root の既定は home の dev で、空文字は未指定として扱う', () => {
  assert.equal(loadConfig({}).devRoot, path.join(os.homedir(), 'dev'))
  assert.equal(loadConfig({ ARAYA_DEV_ROOT: '' }).devRoot, path.join(os.homedir(), 'dev'))
})

test('config: 子 process に引き継ぐ環境変数を copy として持つ', () => {
  const env = { ARAYA_DATA_DIR: '/tmp/araya-config-test', PATH: '/usr/bin', CUSTOM_TOKEN_NAME: 'value' }
  const config = loadConfig(env)

  assert.deepEqual(config.env, env)
  assert.notEqual(config.env, env)
})

test('config: retry制御は未実装のため maxAttempts を公開しない', () => {
  const config = loadConfig({ ARAYA_MAX_ATTEMPTS: '7' })

  assert.equal('maxAttempts' in config, false)
})

test('CLI arguments: --help は help flag として解析する', () => {
  assert.deepEqual(parseCliArguments(['--help']), { help: true, positionals: [] })
})

test('CLI arguments: -- の後ろは dash で始まる note として保持する', () => {
  assert.deepEqual(
    parseCliArguments(['approve', 'candidate:note', '--', '-keep-literal']),
    { help: false, positionals: ['approve', 'candidate:note', '-keep-literal'] }
  )
})

test('CLI: 引数なしは Pi SDK を空引数で呼び出す', async () => {
  let capturedArgs: string[] | undefined

  await runCli([], async (args) => {
    capturedArgs = args
  })

  assert.deepEqual(capturedArgs, [])
})

test('CLI: pi subcommand は Pi SDK に引数を転送する', async () => {
  let capturedArgs: string[] | undefined

  await runCli(['pi', '--model', 'codex'], async (args) => {
    capturedArgs = args
  })

  assert.deepEqual(capturedArgs, ['--model', 'codex'])
})

test('CLI: --help は Pi SDK を起動しない', async () => {
  let piStarted = false

  await runCli(['--help'], async () => {
    piStarted = true
  })

  assert.equal(piStarted, false)
})

test('CLI: help の環境変数一覧に ARAYA_DEV_ROOT がある', async () => {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '))
  }

  try {
    await runCli(['--help'], async () => {})
  } finally {
    console.log = originalLog
  }

  assert.match(lines.join('\n'), /^ {2}ARAYA_DEV_ROOT$/mu)
})

test('CLI: help に task と runner の command がある', async () => {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '))
  }

  try {
    await runCli(['--help'], async () => {})
  } finally {
    console.log = originalLog
  }

  const help = lines.join('\n')

  for (const command of [
    'araya task create --file <path|->',
    'araya task list [--status <状態>] [--limit <1〜200>]',
    'araya task show <taskId> [--events <0〜500>] [--full]',
    'araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]',
    'araya task cancel <taskId>',
    'araya runner install',
    'araya runner uninstall'
  ]) {
    assert.ok(help.includes(`\n  ${command}\n`), command)
  }

  // runner は linger を変えない。worker と、runner を実装中という説明は残さない
  assert.match(help, /linger は変えない/u)
  assert.doesNotMatch(help, /実装中|worker/u)
})

test('CLI: help の --note と SHIKI の説明、ARAYA_DATA_DIR を変えたときの runner の説明', async () => {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '))
  }

  try {
    await runCli(['--help'], async () => {})
  } finally {
    console.log = originalLog
  }

  const help = lines.join('\n')

  // --note の答えは、SHIKI が判断を求めて blocked になった Task のもの（restart_limit の blocked には質問が無い）
  assert.doesNotMatch(help, /blocked の質問への答え/u)
  assert.match(help, /--note は追加の指示。SHIKI が判断を求めて blocked になった Task では、\s*質問（decisionQuestion）への答えを書く/u)
  assert.match(help, /SHIKI（開発の agent）/u)
  assert.doesNotMatch(help, /開発 agent/u)
  // ARAYA_DATA_DIR を変えると unit の名前が変わり、前の runner が残る
  assert.match(help, /ARAYA_DATA_DIR を変えると別の runner になる/u)
})

test('CLI: Pi SDK はグローバル pi コマンドなしで使える', async () => {
  const { result, stdout, stderr } = await runArayaCliWithoutPiBinary(['pi', '--version'])

  assert.equal(result.signal, null)
  assert.equal(result.code, 0)
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/)
  assert.equal(stderr, '')
})

async function captureConsoleLog(run: () => Promise<void>) {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '))
  }

  try {
    await run()
  } finally {
    console.log = originalLog
  }

  return lines.join('\n')
}

test('CLI: 不正な設定ファイルでは subcommand を何も処理せずに失敗し、message に path が入る', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  const configPath = path.join(dataDir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openai/gpt-5.5', fallbackModels: [] } }), 'utf8')
  const env = { ARAYA_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: path.join(dataDir, 'pi-agent') }

  try {
    for (const args of [['init'], ['tick'], ['status'], ['run'], ['approve', 'candidate:x'], ['reject', 'candidate:x']]) {
      const name = args.join(' ')
      const output = await captureConsoleLog(async () => {
        await assert.rejects(runCli(args, async () => {}, env), (error: unknown) => {
          assert.ok(error instanceof Error, name)
          assert.equal(error.message.startsWith(`invalid Araya config file ${configPath}: `), true, name)
          return true
        })
      })

      assert.equal(output, '', name)
      assert.deepEqual(await fs.readdir(dataDir), ['config.json'], name)
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: 引数なし、pi subcommand、help は設定ファイルを読まない', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  await fs.writeFile(path.join(dataDir, 'config.json'), 'not json', 'utf8')
  const env = { ARAYA_DATA_DIR: dataDir }
  const started: string[][] = []

  try {
    await runCli([], async (args) => {
      started.push(args)
    }, env)
    await runCli(['pi', '--version'], async (args) => {
      started.push(args)
    }, env)
    const help = await captureConsoleLog(async () => {
      await runCli(['--help'], async () => {}, env)
      await runCli(['help'], async () => {}, env)
    })

    assert.deepEqual(started, [[], ['--version']])
    assert.match(help, /araya status/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: 不正な設定ファイルでは exit code 1 で終わり、path を含む message を出す', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  const configPath = path.join(dataDir, 'config.json')
  await fs.mkdir(configPath)
  const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))

  try {
    const child = spawn(process.execPath, [cliPath, 'status'], {
      env: { PATH: process.env.PATH, HOME: dataDir, ARAYA_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: path.join(dataDir, 'pi-agent') },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })

    assert.deepEqual(exit, { code: 1, signal: null })
    assert.equal(stdout.join(''), '')
    assert.equal(stderr.join(''), `invalid Araya config file ${configPath}: not a regular file\n`)
    assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('status: 設定ファイルの path と指定した model と thinking level を表示し、status.json に書く', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  const configPath = path.join(dataDir, 'config.json')
  const env = { ARAYA_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: path.join(dataDir, 'pi-agent') }

  try {
    await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openrouter/moonshotai/kimi-k2.6', thinkingLevel: 'high' } }), 'utf8')
    const output: unknown = JSON.parse(await captureConsoleLog(async () => {
      await runCli(['status'], async () => {}, env)
    }))
    const written: unknown = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8'))

    for (const snapshot of [output, written]) {
      assert.ok(snapshot !== null && typeof snapshot === 'object' && 'config' in snapshot)
      assert.ok(snapshot.config !== null && typeof snapshot.config === 'object')
      assert.ok('configPath' in snapshot.config && 'developmentModel' in snapshot.config)
      assert.equal(snapshot.config.configPath, configPath)
      assert.deepEqual(snapshot.config.developmentModel, { model: 'openrouter/moonshotai/kimi-k2.6', thinkingLevel: 'high' })
    }

    await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openai/gpt-5.5' } }), 'utf8')
    const withoutThinkingLevel = await captureConsoleLog(async () => {
      await runCli(['status'], async () => {}, env)
    })

    assert.match(withoutThinkingLevel, /"developmentModel": \{\n\s+"model": "openai\/gpt-5\.5",\n\s+"thinkingLevel": null\n\s+\}/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('status: 設定ファイルが無ければ developmentModel は null', async () => {
  const { dir, config } = await makeConfig()

  try {
    const snapshot = await statusAraya(config)

    assert.equal(snapshot.config.configPath, path.join(dir, 'config.json'))
    assert.equal(snapshot.config.developmentModel, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('status: pending task の実行を再開せず、制御 plane を変えない', async () => {
  const { config } = await makeConfig()
  await leavePendingScoutTask(config)

  const beforeControlPlane = openControlPlane(config.controlPlanePath)
  const before = beforeControlPlane.summarize(config.maxActions)
  beforeControlPlane.close()

  const snapshot = await statusAraya(config)
  const afterControlPlane = openControlPlane(config.controlPlanePath)
  const after = afterControlPlane.summarize(config.maxActions)
  afterControlPlane.close()

  assert.deepEqual(after.opportunityCounts, before.opportunityCounts)
  assert.deepEqual(after.pendingOutbox, before.pendingOutbox)
  assert.deepEqual(after.events, before.events)
  assert.ok(snapshot.activeTasks.some((task) => task.kind === TASK_NAMES.scout && task.status === 'pending'))
})

test('init: pending task の実行を再開しない', async () => {
  const { config } = await makeConfig()
  await leavePendingScoutTask(config)

  const beforeControlPlane = openControlPlane(config.controlPlanePath)
  const before = beforeControlPlane.summarize(config.maxActions)
  beforeControlPlane.close()

  await initAraya(config)

  const afterControlPlane = openControlPlane(config.controlPlanePath)
  const after = afterControlPlane.summarize(config.maxActions)
  afterControlPlane.close()

  assert.deepEqual(after.opportunityCounts, before.opportunityCounts)
  assert.deepEqual(after.pendingOutbox, before.pendingOutbox)
  assert.deepEqual(after.events, before.events)
})

test('observations: 有効な JSONL を読み、不正行を errors に分離する', async () => {
  const { dir } = await makeConfig()
  const inboxDir = path.join(dir, 'inbox')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(inboxDir, 'observations.jsonl'),
    [
      JSON.stringify({ id: 'candidate:a', title: 'A', risk: 'read-only' }),
      '',
      JSON.stringify({ id: 'candidate:b', title: 'B', risk: 'external' }),
      JSON.stringify({ id: 'candidate:c', title: 'C', risk: 'unknown' })
    ].join('\n'),
    'utf8'
  )

  const result = await readObservationSource(inboxDir)
  assert.equal(result.observations.length, 2)
  assert.equal(result.observations[0]?.observationId, 'candidate:a')
  assert.equal(result.observations[1]?.observationId, 'candidate:b')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0] ?? '', /risk must be read-only, workspace, or external/u)
})

test('observations: inbox の読み取りに失敗したら空入力として扱わず error を返す', async () => {
  const { dir } = await makeConfig()
  const inboxDir = path.join(dir, 'missing-inbox')

  const result = await readObservationSource(inboxDir)

  assert.deepEqual(result.observations, [])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0] ?? '', /missing-inbox/u)
  assert.match(result.errors[0] ?? '', /ENOENT|no such file/u)
})

test('observations: 個別ファイルの読み取り失敗を記録し、他ファイルの有効行を保つ', async () => {
  const { dir } = await makeConfig()
  const inboxDir = path.join(dir, 'inbox')
  const unreadablePath = path.join(inboxDir, 'z-unreadable.jsonl')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(inboxDir, 'a-valid.jsonl'),
    `${JSON.stringify({ id: 'candidate:valid', title: 'Valid', risk: 'read-only' })}\n`,
    'utf8'
  )
  await fs.writeFile(unreadablePath, `${JSON.stringify({ id: 'candidate:unreadable', title: 'Unreadable', risk: 'read-only' })}\n`, 'utf8')
  await fs.chmod(unreadablePath, 0)

  try {
    const result = await readObservationSource(inboxDir)

    assert.equal(result.observations.length, 1)
    assert.equal(result.observations[0]?.observationId, 'candidate:valid')
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0] ?? '', /z-unreadable\.jsonl/u)
    assert.match(result.errors[0] ?? '', /EACCES|permission denied/u)
  } finally {
    await fs.chmod(unreadablePath, 0o600)
  }
})

test('init: seed は汎用例のみで、個人のissue参照を含めない', async () => {
  const { config } = await makeConfig()

  await initAraya(config)

  const seed = await fs.readFile(path.join(config.inboxDir, 'seed.jsonl'), 'utf8')
  assert.equal(seed.trim().split('\n').length, 3)
  assert.doesNotMatch(seed, /memo|araya#1/u)
})

test('init: 既存の seed inbox を上書きしない', async () => {
  const { config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  const seedPath = path.join(config.inboxDir, 'seed.jsonl')
  const existing = `${JSON.stringify({ id: 'candidate:custom', title: '保持する候補', risk: 'read-only' })}\n`
  await fs.writeFile(seedPath, existing, 'utf8')

  await initAraya(config)

  assert.equal(await fs.readFile(seedPath, 'utf8'), existing)
})

test('control plane: startOpportunities は既存候補を scouting へ更新する', async () => {
  const { dir } = await makeConfig()
  const controlPlane = openControlPlane(path.join(dir, 'araya.sqlite'))
  const now = 1000

  try {
    controlPlane.ensureGoal(MAIN_GOAL_ID, 'test goal', 1000, now)
    controlPlane.recordObservationBatch(
      [{ observationId: 'candidate:start', kind: 'investigate', title: 'Start', risk: 'read-only', payload: {} }],
      MAIN_GOAL_ID,
      now
    )

    controlPlane.startOpportunities(['candidate:start'], now + 1)

    const opportunity = controlPlane.getOpportunity('candidate:start')
    assert.equal(opportunity?.status, 'scouting')
    assert.equal(opportunity?.attemptCount, 1)
    assert.equal(
      controlPlane.summarize(10).events.filter((event) => event.type === 'opportunity.scouting').length,
      1
    )
  } finally {
    controlPlane.close()
  }
})

test('control plane: startOpportunities は存在しない候補を拒否する', async () => {
  const { dir } = await makeConfig()
  const controlPlane = openControlPlane(path.join(dir, 'araya.sqlite'))

  try {
    assert.throws(
      () => controlPlane.startOpportunities(['candidate:missing'], 1000),
      /opportunity not found: candidate:missing/u
    )
    assert.equal(
      controlPlane.summarize(10).events.some((event) => event.type === 'opportunity.scouting'),
      false
    )
  } finally {
    controlPlane.close()
  }
})

test('control plane: 同一 observation の再投入で opportunity を増殖させない', async () => {
  const { dir } = await makeConfig()
  const controlPlane = openControlPlane(path.join(dir, 'araya.sqlite'))
  const now = 1000

  controlPlane.ensureGoal(MAIN_GOAL_ID, 'test goal', 1000, now)

  const first = controlPlane.recordObservationBatch(
    [{ observationId: 'candidate:once', kind: 'investigate', title: 'Once', risk: 'read-only', payload: {} }],
    MAIN_GOAL_ID,
    now
  )
  const second = controlPlane.recordObservationBatch(
    [{ observationId: 'candidate:once', kind: 'investigate', title: 'Once', risk: 'read-only', payload: {} }],
    MAIN_GOAL_ID,
    now + 1
  )

  assert.deepEqual(first, ['candidate:once'])
  assert.deepEqual(second, [])
  assert.equal(controlPlane.countOpportunities().discovered, 1)

  controlPlane.close()
})

test('tick: 個別 inbox 読取エラーを記録し、有効候補の処理を続ける', async () => {
  const { config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  const unreadablePath = path.join(config.inboxDir, 'z-unreadable.jsonl')
  await fs.writeFile(
    path.join(config.inboxDir, 'a-valid.jsonl'),
    `${JSON.stringify({ id: 'candidate:valid', title: 'Valid', risk: 'read-only', payload: {} })}\n`,
    'utf8'
  )
  await fs.writeFile(unreadablePath, `${JSON.stringify({ id: 'candidate:unreadable', title: 'Unreadable', risk: 'read-only', payload: {} })}\n`, 'utf8')
  await fs.chmod(unreadablePath, 0)

  try {
    await tickAraya(config)

    const status = await statusAraya(config)
    assert.equal(status.controlPlane.opportunityCounts.blocked, 1)
    const errorEvent = status.controlPlane.events.find((event) => event.type === 'inbox.read_errors')
    assert.ok(errorEvent)
    assert.match(JSON.stringify(errorEvent.data.errors), /z-unreadable\.jsonl/u)
  } finally {
    await fs.chmod(unreadablePath, 0o600)
  }
})

test('tick: read-only 候補は executor 不在で blocked になり、external 候補は承認待ちになる', async () => {
  const { dir, config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'observations.jsonl'),
    [
      JSON.stringify({ id: 'candidate:read-only', title: '読むだけ', risk: 'read-only', payload: { source: 'test' } }),
      JSON.stringify({ id: 'candidate:external', title: '外部実行', risk: 'external', payload: { source: 'test' } })
    ].join('\n'),
    'utf8'
  )

  const tickResult = await tickAraya(config)
  assert.equal(tickResult.status, 'due')
  assert.equal(tickResult.settled?.state.outcome.status, 'completed')

  const status = await statusAraya(config)
  assert.equal(status.controlPlane.opportunityCounts.completed, undefined)
  assert.equal(status.controlPlane.opportunityCounts.blocked, 1)
  assert.equal(status.controlPlane.opportunityCounts.approval_requested, 1)
  assert.equal(status.controlPlane.blocked[0]?.id, 'candidate:read-only')
  assert.equal(status.controlPlane.pendingApprovals[0]?.id, 'candidate:external')
  assert.equal(status.activeTasks.length, 0)
})

test('tick: inbox の development taskは worker も model も起動せずに blocked になる', async () => {
  const { config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'development.jsonl'),
    `${JSON.stringify({
      id: 'development:integration',
      kind: 'development',
      title: '実装して検証する',
      risk: 'workspace',
      payload: { task: 'fixture fileを作る' }
    })}\n`,
    'utf8'
  )

  const tickResult = await tickAraya(config)

  assert.equal(tickResult.status, 'due')
  assert.equal(tickResult.settled?.state.outcome.status, 'completed')

  const controlPlane = openControlPlane(config.controlPlanePath)

  try {
    const opportunity = controlPlane.getOpportunity('development:integration')
    assert.equal(opportunity?.kind, 'development')
    assert.equal(opportunity?.status, 'blocked')
    assert.deepEqual(opportunity?.evidence, {
      type: 'development_executor_unavailable',
      opportunityId: 'development:integration'
    })
  } finally {
    controlPlane.close()
  }

  // 状態 directory を作らない（SHIKI を動かしていない）
  await assert.rejects(fs.lstat(path.join(config.dataDir, 'development')), { code: 'ENOENT' })

  const status = await statusAraya(config)
  assert.equal(status.activeTasks.length, 0)
})

test('tick: 次回起床前なら idle とし、task を増殖させない', async () => {
  const { dir, config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'observations.jsonl'),
    JSON.stringify({ id: 'candidate:idle', title: 'Idle', risk: 'read-only', payload: {} }),
    'utf8'
  )

  const first = await tickAraya(config)
  assert.equal(first.status, 'due')

  const second = await tickAraya(config)
  assert.equal(second.status, 'idle')

  const status = await statusAraya(config)
  assert.equal(status.controlPlane.opportunityCounts.completed, undefined)
  assert.equal(status.controlPlane.opportunityCounts.blocked, 1)
  assert.equal(status.controlPlane.blocked[0]?.id, 'candidate:idle')
  assert.equal(status.activeTasks.length, 0)
})

test('approve: 承認した external 候補は次回 tick で no-executor blocked になる', async () => {
  const { dir, config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'observations.jsonl'),
    JSON.stringify({ id: 'candidate:approval', title: '承認後', risk: 'external', payload: {} }),
    'utf8'
  )

  await tickAraya(config)
  const decision = approveOpportunity(config, 'candidate:approval', 'test approval')
  assert.equal(decision.decision, 'approved')

  const controlPlane = openControlPlane(config.controlPlanePath)
  controlPlane.markGoalWake(MAIN_GOAL_ID, Date.now(), 0)
  controlPlane.close()

  const tickResult = await tickAraya(config)
  assert.equal(tickResult.status, 'due')

  const status = await statusAraya(config)
  assert.equal(status.controlPlane.opportunityCounts.blocked, 1)
  assert.equal(status.controlPlane.pendingApprovals.length, 0)
})

test('tick: approval outbox 書込失敗後の再試行で候補と通知を回復する', async () => {
  const { config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'external.jsonl'),
    `${JSON.stringify({ id: 'candidate:approval-retry', title: '承認通知', risk: 'external', payload: {} })}\n`,
    'utf8'
  )

  const failingControlPlane = openControlPlane(config.controlPlanePath)
  failingControlPlane.db.exec(`
    CREATE TRIGGER fail_outbox_insert
    BEFORE INSERT ON outbox
    BEGIN
      SELECT RAISE(ABORT, 'forced outbox insert failure');
    END;
  `)
  failingControlPlane.close()

  await tickAraya(config)

  const afterFailure = await statusAraya(config)
  assert.equal(afterFailure.controlPlane.opportunityCounts.scouting, 1)
  assert.equal(afterFailure.controlPlane.pendingOutbox.length, 0)

  const recoveryControlPlane = openControlPlane(config.controlPlanePath)
  recoveryControlPlane.db.exec('DROP TRIGGER fail_outbox_insert')
  recoveryControlPlane.markGoalWake(MAIN_GOAL_ID, Date.now(), 0)
  recoveryControlPlane.close()

  await tickAraya(config)

  const recovered = await statusAraya(config)
  assert.equal(recovered.controlPlane.opportunityCounts.approval_requested, 1)
  assert.deepEqual(
    recovered.controlPlane.pendingOutbox.map(({ id, topic, status }) => ({ id, topic, status })),
    [{ id: 'approval-request:candidate:approval-retry', topic: 'discord.approval', status: 'pending' }]
  )
})

test('tick: outbox は通知が実配信されるまで pending のまま保持する', async () => {
  const { dir, config } = await makeConfig()
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(config.inboxDir, 'observations.jsonl'),
    JSON.stringify({ id: 'candidate:outbox', title: '通知待ち', risk: 'external', payload: {} }),
    'utf8'
  )

  await tickAraya(config)

  const status = await statusAraya(config)
  assert.deepEqual(
    status.controlPlane.pendingOutbox.map(({ id, topic, status: deliveryStatus }) => ({
      id,
      topic,
      status: deliveryStatus
    })),
    [{ id: 'approval-request:candidate:outbox', topic: 'discord.approval', status: 'pending' }]
  )
})

test('run: SIGINT と SIGTERM で長い interval 待機を中断して速やかに終了する', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const { config } = await makeConfig()
    await fs.mkdir(config.inboxDir, { recursive: true })

    const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))
    const child = spawn(process.execPath, [cliPath, 'run'], {
      env: {
        ...process.env,
        ARAYA_DATA_DIR: config.dataDir,
        ARAYA_INBOX_DIR: config.inboxDir,
        ARAYA_STATUS_FILE: config.statusFile,
        ARAYA_CONTROL_PLANE_PATH: config.controlPlanePath,
        ARAYA_PI_DURABLE_PATH: config.piDurablePath,
        ARAYA_INTERVAL_MS: '60000',
        ARAYA_MAX_ACTIONS: '10',
        PI_CODING_AGENT_DIR: config.piAgentDir,
        PI_OFFLINE: '1'
      },
      stdio: 'ignore'
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

    try {
      const readyDeadline = Date.now() + 5000
      let ready = false

      while (!ready && Date.now() < readyDeadline) {
        try {
          const snapshot: unknown = JSON.parse(await fs.readFile(config.statusFile, 'utf8'))

          if (snapshot !== null && typeof snapshot === 'object' && 'tick' in snapshot) {
            const tick = snapshot.tick
            ready = tick !== null && typeof tick === 'object' && 'status' in tick && tick.status === 'due'
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            throw error
          }
        }

        if (!ready) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }

      assert.equal(ready, true, 'run が最初の tick を status file に書くこと')
      assert.equal(child.kill(signal), true, `${signal} を子プロセスへ送信すること`)

      let timeoutHandle: NodeJS.Timeout | undefined
      const timedOut = new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(undefined), 1500)
      })
      const exitResult = await Promise.race([exited, timedOut])

      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle)
      }

      assert.ok(exitResult, `${signal} 後、次回 tick interval を待たずに終了すること`)
      assert.equal(exitResult.code, 0)
      assert.equal(exitResult.signal, null)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  }
})
