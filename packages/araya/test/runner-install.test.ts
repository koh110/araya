import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { runCli } from '../src/cli/main.ts'
import { buildRunnerUnitFile, dataDirHash, runnerUnitName, type CommandResult } from '../src/infrastructure/systemd.ts'
import type { RunnerCommandDependencies } from '../src/cli/task-commands.ts'
import { openTaskLedger } from '../src/runner/ledger.ts'
import { commandResult, createFakeSystemd } from './support/fake-systemd.ts'

const NODE_PATH = '/usr/bin/node'
const NEW_INVOCATION = 'invocation-new'
const RUNNER_PID = 4242
const UID = 1000

type InstallEnv = Awaited<ReturnType<typeof makeInstallEnv>>

async function makeInstallEnv() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-runner-install-test-')))
  const dataDir = path.join(root, 'data')
  const devRoot = path.join(root, 'dev')
  const home = path.join(root, 'home')
  const configHome = path.join(root, 'xdg')
  const piAgentDir = path.join(dataDir, 'pi')
  const entrypoint = path.join(root, 'package', 'bin', 'task-runner.ts')
  await fs.mkdir(home)
  await fs.mkdir(dataDir, { mode: 0o700 })
  await fs.mkdir(piAgentDir)
  await fs.mkdir(path.dirname(entrypoint), { recursive: true })
  await fs.writeFile(path.join(piAgentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: 'test-model'
  }), 'utf8')
  await fs.writeFile(entrypoint, '', 'utf8')
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    ARAYA_DATA_DIR: dataDir,
    ARAYA_DEV_ROOT: devRoot,
    PI_CODING_AGENT_DIR: piAgentDir
  }

  return { root, dataDir, devRoot, home, configHome, entrypoint, env }
}

function unitOf(dataDirReal: string) {
  return runnerUnitName(dataDirHash(dataDirReal))
}

function unitPathOf(installEnv: InstallEnv, unit: string) {
  return path.join(installEnv.configHome, 'systemd', 'user', unit)
}

async function startPiMustNotRun() {
  throw new Error('Pi を起動しない')
}

// 偽物の systemd の既定の応答。restart で runner が起動したことを、台帳の runner の行を書いて再現する
function defaultSystemctl(installEnv: InstallEnv, overrides: Partial<Record<string, (args: readonly string[]) => CommandResult>> = {}) {
  return async (args: readonly string[]) => {
    const command = args[1] ?? ''
    const override = overrides[command]

    if (override !== undefined) {
      return override(args)
    }

    const unit = args.at(-1) ?? ''

    if (command === 'is-system-running') {
      return commandResult('running\n')
    }

    if (command === 'show' && args.includes('--property=FragmentPath')) {
      return commandResult(`${unitPathOf(installEnv, unit)}\n`)
    }

    if (command === 'show' && args.includes('--property=InvocationID')) {
      return commandResult(`${NEW_INVOCATION}\n`)
    }

    if (command === 'restart') {
      const ledger = openTaskLedger(installEnv.dataDir)
      ledger.markRunnerStarted({ unit, invocationId: NEW_INVOCATION, pid: RUNNER_PID })
      ledger.close()
    }

    return commandResult()
  }
}

async function runRunner(
  installEnv: InstallEnv,
  args: string[],
  fake: ReturnType<typeof createFakeSystemd>,
  deps: Partial<RunnerCommandDependencies> = {}
) {
  const stdout: string[] = []
  const stderr: string[] = []
  let clock = Date.parse('2026-10-24T00:00:00.000Z')
  const sleeps: number[] = []
  await runCli(['runner', ...args], startPiMustNotRun, installEnv.env, {
    platform: 'linux',
    stdin: Readable.from([]),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    nowMs: () => clock,
    createSystemdOps: async () => fake.ops,
    nodePath: NODE_PATH,
    resolveRunnerEntrypoint: async () => installEnv.entrypoint,
    homeDir: installEnv.home,
    uid: UID,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    ...deps
  })
  const output: unknown = JSON.parse(stdout.join('\n'))

  return { output, stderr: stderr.join('\n'), sleeps }
}

function readField(value: unknown, ...keys: string[]) {
  let current = value

  for (const key of keys) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }

    current = Reflect.get(current, key)
  }

  return current
}

function errorWithCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok('code' in error)
    assert.equal(error.code, code, error.message)
    assert.ok(error.message.startsWith(`${code}: `), error.message)

    return true
  }
}

function environmentLines(unitFile: string) {
  return unitFile.split('\n').filter((line) => {
    return line.startsWith('Environment=')
  })
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

test('runner install: unit file を mode 0600 で書き、daemon-reload・enable・restart を実行して、新しい invocation の runner を出す', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => commandResult('yes\n')
  })

  try {
    const { output, stderr, sleeps } = await runRunner(installEnv, ['install'], fake)
    const dataDirReal = await fs.realpath(installEnv.dataDir)
    const unit = unitOf(dataDirReal)
    const unitPath = unitPathOf(installEnv, unit)

    assert.deepEqual(readField(output, 'unit'), unit)
    assert.deepEqual(readField(output, 'unitPath'), unitPath)
    assert.equal(readField(output, 'linger'), true)
    assert.equal(readField(output, 'runner', 'state'), 'running')
    assert.equal(readField(output, 'runner', 'pid'), RUNNER_PID)
    assert.equal(readField(output, 'runner', 'unit'), unit)
    assert.equal(stderr, '')
    assert.deepEqual(sleeps, [])

    assert.equal(await fs.readFile(unitPath, 'utf8'), buildRunnerUnitFile({
      dataDir: dataDirReal,
      nodePath: NODE_PATH,
      entrypoint: installEnv.entrypoint,
      systemctlPath: fake.ops.systemctlPath,
      environment: [
        ['ARAYA_DATA_DIR', installEnv.dataDir],
        ['ARAYA_DEV_ROOT', installEnv.devRoot],
        ['PATH', '/usr/bin:/bin'],
        ['PI_CODING_AGENT_DIR', path.join(installEnv.dataDir, 'pi')]
      ]
    }))
    assert.equal((await fs.stat(unitPath)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.dirname(unitPath))).mode & 0o777, 0o700)
    assert.equal((await fs.stat(installEnv.dataDir)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(path.join(installEnv.dataDir, 'logs'))).mode & 0o777, 0o700)
    // 一時 file は残らない
    assert.deepEqual(await fs.readdir(path.dirname(unitPath)), [unit])

    assert.deepEqual(fake.records().flatMap((entry) => {
      return entry.type === 'systemctl' || entry.type === 'loginctl' ? [[entry.type, ...entry.args, String(entry.timeoutMs)]] : []
    }), [
      ['systemctl', '--user', 'is-system-running', '10000'],
      ['systemctl', '--user', 'daemon-reload', '30000'],
      ['systemctl', '--user', 'show', '--property=FragmentPath', '--value', unit, '30000'],
      ['systemctl', '--user', 'enable', unit, '30000'],
      ['systemctl', '--user', 'restart', unit, '90000'],
      ['systemctl', '--user', 'show', '--property=InvocationID', '--value', unit, '30000'],
      ['loginctl', 'show-user', String(UID), '--property=Linger', '--value', '30000']
    ])
    // scope は作らない
    assert.deepEqual(fake.launches(), [])
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: Pi の明示的な default model があれば config.json を初回だけ作る', async () => {
  const installEnv = await makeInstallEnv()
  const settingsPath = path.join(installEnv.dataDir, 'pi', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify({
    defaultProvider: 'faux',
    defaultModel: 'test-model',
    defaultThinkingLevel: 'high'
  }), 'utf8')
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => commandResult('yes\n')
  })

  try {
    const { output, stderr } = await runRunner(installEnv, ['install'], fake)
    const configPath = path.join(installEnv.dataDir, 'config.json')
    const configText = await fs.readFile(configPath, 'utf8')

    assert.deepEqual(JSON.parse(configText), { development: { model: 'faux/test-model' } })
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600)
    assert.deepEqual(readField(output, 'config'), {
      status: 'created',
      configPath,
      model: 'faux/test-model'
    })
    assert.equal(stderr, '')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: PI_CODING_AGENT_DIR 未指定時も Araya 専用 settings.json を使う', async () => {
  const installEnv = await makeInstallEnv()
  const env = { ...installEnv.env }
  delete env.PI_CODING_AGENT_DIR
  const settingsPath = path.join(installEnv.home, '.pi', 'agent', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: 'faux', defaultModel: 'home-model' }), 'utf8')
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => commandResult('yes\n')
  })

  try {
    const { output, stderr } = await runRunner({ ...installEnv, env }, ['install'], fake)
    const configPath = path.join(installEnv.dataDir, 'config.json')

    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), {
      development: { model: 'faux/test-model' }
    })
    assert.deepEqual(readField(output, 'config'), {
      status: 'created',
      configPath,
      model: 'faux/test-model'
    })
    assert.equal(stderr, '')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: 既存 config.json を変更せずそのまま使う', async () => {
  const installEnv = await makeInstallEnv()
  const configPath = path.join(installEnv.dataDir, 'config.json')
  const original = '{"development":{"model":"faux/custom","thinkingLevel":"low"}}\n'
  await fs.mkdir(installEnv.dataDir, { recursive: true })
  await fs.writeFile(configPath, original, 'utf8')
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => commandResult('yes\n')
  })

  try {
    const { output, stderr } = await runRunner(installEnv, ['install'], fake)

    assert.equal(await fs.readFile(configPath, 'utf8'), original)
    assert.deepEqual(readField(output, 'config'), { status: 'existing', configPath })
    assert.equal(stderr, '')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: host の指定を無視して専用 settings から初期化し、host file は変えない', async () => {
  const installEnv = await makeInstallEnv()
  const hostPi = path.join(installEnv.root, 'standalone-pi')
  await fs.mkdir(hostPi)
  const hostSettings = Buffer.from('{"defaultProvider":"host-only","defaultModel":"host-only"}\n')
  await fs.writeFile(path.join(hostPi, 'settings.json'), hostSettings)
  const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv), loginctl: async () => commandResult('yes\n') })
  try {
    await runRunner({ ...installEnv, env: { ...installEnv.env, PI_CODING_AGENT_DIR: hostPi, PI_CODING_AGENT_SESSION_DIR: path.join(hostPi, 'sessions') } }, ['install'], fake)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(installEnv.dataDir, 'config.json'), 'utf8')), { development: { model: 'faux/test-model' } })
    const unit = await fs.readFile(unitPathOf(installEnv, unitOf(await fs.realpath(installEnv.dataDir))), 'utf8')
    assert.ok(unit.includes(`Environment=PI_CODING_AGENT_DIR=${path.join(installEnv.dataDir, 'pi')}`))
    assert.equal(unit.includes(hostPi), false)
    assert.equal(unit.includes('PI_CODING_AGENT_SESSION_DIR'), false)
    assert.deepEqual(await fs.readFile(path.join(hostPi, 'settings.json')), hostSettings)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: Pi に明示的な default model がなければ config.json を作らず警告する', async () => {
  const installEnv = await makeInstallEnv()
  const settingsPath = path.join(installEnv.dataDir, 'pi', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: 'faux' }), 'utf8')
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => commandResult('yes\n')
  })

  try {
    const { output, stderr } = await runRunner(installEnv, ['install'], fake)
    const configPath = path.join(installEnv.dataDir, 'config.json')

    await assert.rejects(fs.access(configPath), { code: 'ENOENT' })
    assert.deepEqual(readField(output, 'config'), {
      status: 'skipped',
      configPath,
      reason: 'pi_default_missing'
    })
    assert.match(stderr, /defaultProvider\/defaultModel が両方設定されていないため/u)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: 相対 path の ARAYA_DATA_DIR・ARAYA_DEV_ROOT・PI_CODING_AGENT_DIR は、dataDir と違う cwd から実行しても絶対 path で書く', async () => {
  const installEnv = await makeInstallEnv()
  const work = path.join(installEnv.root, 'work')
  await fs.mkdir(work)
  const previousCwd = process.cwd()
  const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv), loginctl: async () => commandResult('yes\n') })

  try {
    process.chdir(work)
    await runRunner({
      ...installEnv,
      env: { ...installEnv.env, ARAYA_DATA_DIR: '../data', ARAYA_DEV_ROOT: '../dev', PI_CODING_AGENT_DIR: '../pi-agent' }
    }, ['install'], fake)
    process.chdir(previousCwd)
    const dataDirReal = await fs.realpath(installEnv.dataDir)
    const unitFile = await fs.readFile(unitPathOf(installEnv, unitOf(dataDirReal)), 'utf8')

    assert.ok(unitFile.includes(`\nExecStart=${NODE_PATH} ${installEnv.entrypoint} --data-dir ${dataDirReal}\n`), unitFile)
    assert.ok(unitFile.includes(`\nWorkingDirectory=${dataDirReal}\n`), unitFile)
    assert.deepEqual(environmentLines(unitFile), [
      `Environment=ARAYA_DATA_DIR=${installEnv.dataDir}`,
      `Environment=ARAYA_DEV_ROOT=${installEnv.devRoot}`,
      'Environment=PATH=/usr/bin:/bin',
      `Environment=PI_CODING_AGENT_DIR=${path.join(installEnv.dataDir, 'pi')}`
    ])
  } finally {
    process.chdir(previousCwd)
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: 秘密とみなす名前の変数と一覧に無い変数は unit file に書かない', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv), loginctl: async () => commandResult('yes\n') })
  const secrets = { OPENAI_API_KEY: 'sk-openai-secret-value', ARAYA_TEST_TOKEN: 'araya-test-token-value', ARAYA_DB_PASSWORD: 'araya-db-password' }

  try {
    await runRunner({
      ...installEnv,
      env: {
        ...installEnv.env,
        ...secrets,
        LANG: 'ja_JP.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'Asia/Tokyo',
        ARAYA_INTERVAL_MS: '60000',
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        GITHUB_SECRET_PATH: '/not/written'
      }
    }, ['install'], fake)
    const unitFile = await fs.readFile(unitPathOf(installEnv, unitOf(await fs.realpath(installEnv.dataDir))), 'utf8')

    assert.deepEqual(environmentLines(unitFile), [
      `Environment=ARAYA_DATA_DIR=${installEnv.dataDir}`,
      `Environment=ARAYA_DEV_ROOT=${installEnv.devRoot}`,
      'Environment=ARAYA_INTERVAL_MS=60000',
      'Environment=LANG=ja_JP.UTF-8',
      'Environment=LC_ALL=C.UTF-8',
      'Environment=PATH=/usr/bin:/bin',
      `Environment=PI_CODING_AGENT_DIR=${path.join(installEnv.dataDir, 'pi')}`,
      'Environment=TZ=Asia/Tokyo'
    ])

    for (const value of Object.values(secrets)) {
      assert.equal(unitFile.includes(value), false, value)
    }

    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'GITHUB_SECRET_PATH', ...Object.keys(secrets)]) {
      assert.equal(unitFile.includes(`Environment=${name}=`), false, name)
    }
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: dataDir などに空白・$・% があれば unit file を書かずに unsupported_path', async () => {
  for (const name of ['my data', 'data$1', 'data%h', "data'q", 'data;x']) {
    const installEnv = await makeInstallEnv()
    const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv) })

    try {
      await assert.rejects(runRunner({
        ...installEnv,
        env: { ...installEnv.env, ARAYA_DATA_DIR: path.join(installEnv.root, name) }
      }, ['install'], fake), errorWithCode('unsupported_path'), name)
      assert.equal(await exists(path.join(installEnv.configHome, 'systemd')), false, name)
      assert.deepEqual(fake.systemctlCalls(), [['--user', 'is-system-running']], name)
    } finally {
      await fs.rm(installEnv.root, { recursive: true, force: true })
    }
  }

  // Environment= に書く値も同じ
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv) })

  try {
    await assert.rejects(runRunner({ ...installEnv, env: { ...installEnv.env, PATH: '/opt/my tools/bin:/usr/bin' } }, ['install'], fake), (error: unknown) => {
      assert.ok(errorWithCode('unsupported_path')(error))
      assert.ok(error instanceof Error && error.message.includes('PATH'), String(error))

      return true
    })
    assert.equal(await exists(path.join(installEnv.configHome, 'systemd')), false)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: FragmentPath が書いた file と違えば unit_not_loaded で、enable と restart をしない', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv, {
      show: () => commandResult(`${path.join(installEnv.home, '.config', 'systemd', 'user', 'other.service')}\n`)
    })
  })

  try {
    await assert.rejects(runRunner(installEnv, ['install'], fake), errorWithCode('unit_not_loaded'))
    assert.deepEqual(fake.systemctlCalls().map((args) => args[1]), ['is-system-running', 'daemon-reload', 'show'])
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: user manager に接続できなければ systemd_unavailable で、何も書かない', async () => {
  for (const response of [commandResult('offline\n', 1), commandResult('', 1, 'Failed to connect to bus: No medium found'), commandResult('', null)]) {
    const installEnv = await makeInstallEnv()
    const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv, { 'is-system-running': () => response }) })

    try {
      await assert.rejects(runRunner(installEnv, ['install'], fake), errorWithCode('systemd_unavailable'))
      assert.deepEqual(await fs.readdir(installEnv.dataDir), ['pi'])
      assert.equal(await exists(path.join(installEnv.configHome, 'systemd')), false)
    } finally {
      await fs.rm(installEnv.root, { recursive: true, force: true })
    }
  }

  // degraded などは接続できたとみなす（終了 code は見ない）
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv, { 'is-system-running': () => commandResult('degraded\n', 1) }),
    loginctl: async () => commandResult('yes\n')
  })

  try {
    const { output } = await runRunner(installEnv, ['install'], fake)
    assert.equal(readField(output, 'runner', 'state'), 'running')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: systemctl が失敗すると、秘密を置き換えた stderr の先頭 500 文字を出して失敗する', async () => {
  const installEnv = await makeInstallEnv()
  const secret = 'restart-secret-token-value'
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv, {
      restart: () => commandResult('', 1, `Job failed: token ${secret} via https://user:pass@example.invalid/ ${'x'.repeat(1000)}`)
    })
  })

  try {
    await assert.rejects(runRunner({ ...installEnv, env: { ...installEnv.env, ARAYA_RESTART_TOKEN: secret } }, ['install'], fake), (error: unknown) => {
      assert.ok(errorWithCode('systemctl_failed')(error))
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(secret), false)
      assert.equal(error.message.includes('user:pass'), false)
      assert.ok(error.message.includes('[REDACTED]'))
      const stderrPart = error.message.slice(error.message.indexOf('Job failed'))
      assert.equal(stderrPart.length, 500)

      return true
    })
    // 失敗の後は runner を待たない
    assert.deepEqual(fake.systemctlCalls().at(-1)?.[1], 'restart')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner install: 新しい invocation の running を 10 秒まで待ち、待てなければそのときの値を出す。linger が無効なら注意を出す', async () => {
  const installEnv = await makeInstallEnv()
  let sleepCount = 0
  const fake = createFakeSystemd({
    // restart では行を書かず、待ちの3回目に runner が起動したことにする
    systemctl: defaultSystemctl(installEnv, { restart: () => commandResult() }),
    loginctl: async () => commandResult('no\n')
  })

  try {
    const started = await runRunner(installEnv, ['install'], fake, {
      sleep: async () => {
        sleepCount += 1

        if (sleepCount === 3) {
          const ledger = openTaskLedger(installEnv.dataDir)
          ledger.markRunnerStarted({ unit: unitOf(await fs.realpath(installEnv.dataDir)), invocationId: NEW_INVOCATION, pid: RUNNER_PID })
          ledger.close()
        }
      }
    })
    assert.equal(sleepCount, 3)
    assert.equal(readField(started.output, 'runner', 'state'), 'running')
    assert.equal(readField(started.output, 'linger'), false)
    assert.equal(started.stderr, 'logout すると runner が止まります。logout の後も動かすには、loginctl enable-linger で linger を有効にしてください')

    // 前の invocation の行のままなら、10 秒待ってそのときの値を出す
    const ledger = openTaskLedger(installEnv.dataDir)
    ledger.markRunnerStarted({ unit: unitOf(await fs.realpath(installEnv.dataDir)), invocationId: 'invocation-old', pid: 1 })
    ledger.close()
    const timedOut = await runRunner(installEnv, ['install'], createFakeSystemd({
      systemctl: defaultSystemctl(installEnv, { restart: () => commandResult() }),
      loginctl: async () => commandResult('', 1, 'Failed to get user')
    }))
    assert.equal(timedOut.sleeps.reduce((total, ms) => total + ms, 0) >= 10_000, true)
    assert.equal(timedOut.sleeps.reduce((total, ms) => total + ms, 0) < 10_400, true)
    assert.equal(readField(timedOut.output, 'runner', 'pid'), 1)
    // linger を取れなければ null で、注意は出さない
    assert.equal(readField(timedOut.output, 'linger'), null)
    assert.equal(timedOut.stderr, '')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

function dumpLedger(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'tasks.sqlite'), { readOnly: true })

  try {
    return ['tasks', 'runs', 'task_events', 'runner'].map((table) => {
      return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    })
  } finally {
    db.close()
  }
}

test('runner uninstall: unit を止めて無効にし、unit file を消し、台帳の試行は変えない', async () => {
  const installEnv = await makeInstallEnv()
  const installFake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv), loginctl: async () => commandResult('yes\n') })

  try {
    await runRunner(installEnv, ['install'], installFake)
    const unit = unitOf(await fs.realpath(installEnv.dataDir))
    const unitPath = unitPathOf(installEnv, unit)
    const ledger = openTaskLedger(installEnv.dataDir)
    ledger.createTask({ title: '動いている試行', goal: 'goal', constraints: [], targets: [], permissions: [], idempotencyKey: null })
    ledger.createTask({ title: '待ちの試行', goal: 'goal', constraints: [], targets: [], permissions: [], idempotencyKey: null })
    assert.ok(ledger.claimNextAttempt(1, { devRoot: installEnv.devRoot, agentDir: installEnv.home, model: null, timeoutMs: 60_000, verificationTimeoutMs: 60_000 }))
    ledger.close()
    const before = dumpLedger(installEnv.dataDir)

    const fake = createFakeSystemd()
    const { output } = await runRunner(installEnv, ['uninstall'], fake)

    assert.deepEqual(output, { unit, removed: true })
    assert.equal(await exists(unitPath), false)
    assert.deepEqual(fake.systemctlCalls(), [
      ['--user', 'disable', '--now', unit],
      ['--user', 'daemon-reload']
    ])
    const disableRecord = fake.records()[0]
    assert.equal(disableRecord?.type === 'systemctl' ? disableRecord.timeoutMs : undefined, 90_000)
    assert.deepEqual(dumpLedger(installEnv.dataDir), before)

    // unit が無いための失敗は無視する
    const missing = createFakeSystemd({
      systemctl: async (args) => {
        return args[1] === 'disable'
          ? commandResult('', 1, `Failed to disable unit: Unit file ${unit} does not exist.`)
          : commandResult()
      }
    })
    const again = await runRunner(installEnv, ['uninstall'], missing)
    assert.deepEqual(again.output, { unit, removed: false })
    assert.deepEqual(dumpLedger(installEnv.dataDir), before)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner uninstall: unit file があるのに無効にできなければ、unit file を残して失敗する', async () => {
  const installEnv = await makeInstallEnv()
  const installFake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv), loginctl: async () => commandResult('yes\n') })

  try {
    await runRunner(installEnv, ['install'], installFake)
    const unitPath = unitPathOf(installEnv, unitOf(await fs.realpath(installEnv.dataDir)))
    const fake = createFakeSystemd({
      systemctl: async (args) => {
        return args[1] === 'disable' ? commandResult('', 1, 'Access denied') : commandResult()
      }
    })

    await assert.rejects(runRunner(installEnv, ['uninstall'], fake), errorWithCode('systemctl_failed'))
    assert.equal(await exists(unitPath), true)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

// unit file が無い状態の uninstall。disable と stop の応答を差し替える
async function uninstallWithoutUnitFile(responses: { disable: CommandResult; stop?: CommandResult }) {
  const installEnv = await makeInstallEnv()
  await fs.mkdir(installEnv.dataDir, { recursive: true })
  const unit = unitOf(await fs.realpath(installEnv.dataDir))
  const fake = createFakeSystemd({
    systemctl: async (args) => {
      if (args[1] === 'disable') {
        return responses.disable
      }

      if (args[1] === 'stop') {
        return responses.stop ?? commandResult()
      }

      return commandResult()
    }
  })

  return { installEnv, unit, fake }
}

const UNIT_MISSING_STDERR = 'Failed to disable unit: Unit araya-runner-000000000000.service does not exist'
const UNIT_NOT_LOADED_STDERR = 'Failed to stop araya-runner-000000000000.service: Unit araya-runner-000000000000.service not loaded.'

test('runner uninstall: unit file が無くても、disable --now が unit が無いため以外で失敗すれば systemctl_failed', async () => {
  for (const disable of [commandResult('', 1, 'Access denied'), { exitCode: null, stdout: '', stderr: UNIT_MISSING_STDERR, timedOut: true }]) {
    const { installEnv, unit, fake } = await uninstallWithoutUnitFile({ disable })

    try {
      await assert.rejects(runRunner(installEnv, ['uninstall'], fake), errorWithCode('systemctl_failed'))
      assert.deepEqual(fake.systemctlCalls(), [['--user', 'disable', '--now', unit]])
    } finally {
      await fs.rm(installEnv.root, { recursive: true, force: true })
    }
  }
})

test('runner uninstall: disable --now が unit が無いために失敗すると stop を実行し、成功か読み込まれていないための失敗なら 0 で終わる', async () => {
  for (const stop of [commandResult(), commandResult('', 5, UNIT_NOT_LOADED_STDERR)]) {
    const { installEnv, unit, fake } = await uninstallWithoutUnitFile({ disable: commandResult('', 1, UNIT_MISSING_STDERR), stop })

    try {
      const { output } = await runRunner(installEnv, ['uninstall'], fake)

      assert.deepEqual(output, { unit, removed: false })
      assert.deepEqual(fake.systemctlCalls(), [
        ['--user', 'disable', '--now', unit],
        ['--user', 'stop', unit],
        ['--user', 'daemon-reload']
      ])
      const stopRecord = fake.records()[1]
      assert.equal(stopRecord?.type === 'systemctl' ? stopRecord.timeoutMs : undefined, 90_000)
    } finally {
      await fs.rm(installEnv.root, { recursive: true, force: true })
    }
  }
})

test('runner uninstall: disable --now の後の stop が読み込まれていないため以外で失敗すれば systemctl_failed', async () => {
  for (const stop of [commandResult('', 1, 'Access denied'), { exitCode: null, stdout: '', stderr: UNIT_NOT_LOADED_STDERR, timedOut: true }]) {
    const { installEnv, unit, fake } = await uninstallWithoutUnitFile({ disable: commandResult('', 1, UNIT_MISSING_STDERR), stop })

    try {
      await assert.rejects(runRunner(installEnv, ['uninstall'], fake), errorWithCode('systemctl_failed'))
      assert.deepEqual(fake.systemctlCalls(), [
        ['--user', 'disable', '--now', unit],
        ['--user', 'stop', unit]
      ])
    } finally {
      await fs.rm(installEnv.root, { recursive: true, force: true })
    }
  }
})

test('runner: Linux 以外では unsupported_platform で何もしない', async () => {
  const installEnv = await makeInstallEnv()
  let opened = 0
  const fake = createFakeSystemd()

  try {
    for (const subcommand of ['install', 'uninstall']) {
      await assert.rejects(runRunner(installEnv, [subcommand], fake, {
        platform: 'darwin',
        createSystemdOps: async () => {
          opened += 1
          return fake.ops
        }
      }), errorWithCode('unsupported_platform'))
    }

    assert.equal(opened, 0)
    assert.deepEqual(fake.records(), [])
    assert.deepEqual(await fs.readdir(installEnv.dataDir), ['pi'])
    assert.equal(await exists(installEnv.configHome), false)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('runner: 不明な command と余分な引数は invalid_arguments', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd()

  try {
    for (const args of [[], ['start'], ['install', 'extra'], ['install', '--force']]) {
      await assert.rejects(runRunner(installEnv, args, fake), errorWithCode('invalid_arguments'), args.join(' '))
    }

    assert.deepEqual(fake.records(), [])
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})
