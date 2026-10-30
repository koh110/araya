import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { loadConfig, withPiEnvironment } from '../src/config/environment.ts'
import { runCli } from '../src/cli/main.ts'
import { createArayaModelRuntime } from '../src/control-plane/runtime.ts'
import { createRunnerModelRuntime } from '../src/runner/runner.ts'
import { AttemptsDoc, buildAttemptInput, createShikiExtension } from '../src/runner/attempt.ts'
import { answer } from './support/faux-shiki.ts'
import { ctx, taskInput, defaultSettings, waitUntil } from './support/runner-fixture.ts'
import { createRunnerSetup, openLedger, startRunner, teardownRunner, waitForTaskStatus } from './support/runner-loop.ts'

const execFileAsync = promisify(execFile)

function readSettings(dataDir: string, taskId: number) {
  const db = new DatabaseSync(path.join(dataDir, 'tasks.sqlite'))
  try {
    const row = db.prepare('SELECT settings_json FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1').get(taskId)
    assert.equal(typeof row?.settings_json, 'string')
    if (typeof row?.settings_json !== 'string') {
      throw new Error('settings missing')
    }
    const value: unknown = JSON.parse(row.settings_json)
    assert.ok(typeof value === 'object' && value !== null && 'agentDir' in value)
    return value
  } finally {
    db.close()
  }
}

test('Pi isolation: SDK main environment uses dedicated directory and restores unset, empty and set values after success and failure', async () => {
  const originalAgent = process.env.PI_CODING_AGENT_DIR
  const originalSession = process.env.PI_CODING_AGENT_SESSION_DIR
  try {
    for (const previous of [undefined, '', '/tmp/standalone-pi']) {
      if (previous === undefined) {
        delete process.env.PI_CODING_AGENT_DIR
        delete process.env.PI_CODING_AGENT_SESSION_DIR
      } else {
        process.env.PI_CODING_AGENT_DIR = previous
        process.env.PI_CODING_AGENT_SESSION_DIR = previous
      }
      for (const fail of [false, true]) {
        const call = withPiEnvironment('/tmp/araya-data/pi', async () => {
          assert.equal(getAgentDir(), '/tmp/araya-data/pi')
          assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, undefined)
          await assert.rejects(withPiEnvironment('/tmp/other/pi', async () => {}), /already active/u)
          assert.equal(getAgentDir(), '/tmp/araya-data/pi')
          if (fail) {
            throw new Error('faux SDK failure')
          }
        })
        if (fail) {
          await assert.rejects(call, /faux SDK failure/u)
        } else {
          await call
        }
        assert.equal(process.env.PI_CODING_AGENT_DIR, previous)
        assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, previous)
      }
    }
  } finally {
    for (const [name, value] of Object.entries({ PI_CODING_AGENT_DIR: originalAgent, PI_CODING_AGENT_SESSION_DIR: originalSession })) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
})

test('Pi isolation: default, empty, relative and custom dataDir ignore host PI_*', () => {
  for (const dataDir of [undefined, '', 'relative-data', '/tmp/araya-custom']) {
    for (const hostDir of [undefined, '', '/tmp/standalone-pi']) {
      const config = loadConfig({ HOME: '/tmp/araya-faux-home', ARAYA_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: hostDir, PI_CODING_AGENT_SESSION_DIR: '/tmp/host-sessions' })
      const expected = path.resolve(dataDir || '/tmp/araya-faux-home/.araya')
      assert.equal(config.dataDir, expected)
      assert.equal(config.piAgentDir, path.join(expected, 'pi'))
      assert.equal(config.env.PI_CODING_AGENT_DIR, config.piAgentDir)
      assert.equal(config.env.PI_CODING_AGENT_SESSION_DIR, undefined)
      assert.equal(config.configPath, path.join(expected, 'config.json'))
    }
  }
})

test('Pi isolation: injected TUI receives directory without changing process environment, including concurrent calls', async () => {
  const before = [process.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_SESSION_DIR]
  await Promise.all(['/tmp/araya-a', '/tmp/araya-b'].map(async (dataDir) => {
    for (const args of [[], ['pi', '--session-dir', '/tmp/explicit-session']]) {
      await runCli(args, async (...received: unknown[]) => {
        await Promise.resolve()
        assert.deepEqual(received, [args.length === 0 ? [] : args.slice(1), path.join(dataDir, 'pi')])
        assert.deepEqual([process.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_SESSION_DIR], before)
      }, { ARAYA_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: '/tmp/host-pi' })
    }
  }))
  await assert.rejects(runCli(['pi'], async () => {
    throw new Error('faux TUI failure')
  }, { ARAYA_DATA_DIR: '/tmp/araya-failure' }), /faux TUI failure/u)
  assert.deepEqual([process.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_SESSION_DIR], before)
})

test('Pi isolation: control-plane uses explicit auth, models and cache with network disabled', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-pi-isolation-'))
  const hostPi = path.join(root, 'host-pi')
  const arayaPi = path.join(root, 'data', 'pi')
  const snapshots = new Map<string, Buffer>()
  for (const { dir, sentinel } of [{ dir: hostPi, sentinel: 'host-only' }, { dir: arayaPi, sentinel: 'araya-only' }]) {
    await fs.mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries({
      'auth.json': JSON.stringify({ openai: { type: 'api_key', key: sentinel } }),
      'settings.json': JSON.stringify({ defaultProvider: 'faux', defaultModel: sentinel }),
      'models.json': '{}',
      'models-store.json': '{}',
      'sessions/marker': sentinel
    })) {
      const file = path.join(dir, name)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content)
      if (dir === hostPi) {
        snapshots.set(file, await fs.readFile(file))
      }
    }
  }
  const create = ModelRuntime.create.bind(ModelRuntime)
  const calls: Parameters<typeof ModelRuntime.create> = []
  t.mock.method(ModelRuntime, 'create', async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    calls.push(options)
    return create(options)
  })
  try {
    const config = loadConfig({ ARAYA_DATA_DIR: path.dirname(arayaPi), PI_CODING_AGENT_DIR: hostPi })
    const runtime = await createArayaModelRuntime(config.piAgentDir)
    assert.equal((await runtime.getAuth('openai'))?.auth.apiKey, 'araya-only')
    assert.deepEqual(calls, [{ authPath: path.join(arayaPi, 'auth.json'), modelsPath: path.join(arayaPi, 'models.json'), modelsStorePath: path.join(arayaPi, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false }])
    const runner = await createRunnerModelRuntime({ agentDir: config.piAgentDir, dataDir: config.dataDir })
    assert.equal((await runner.getAuth('openai'))?.auth.apiKey, 'araya-only')
    assert.deepEqual(calls[1], { authPath: path.join(arayaPi, 'auth.json'), modelsPath: path.join(arayaPi, 'models.json'), modelsStorePath: path.join(config.dataDir, 'runner', 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false })
    for (const [file, bytes] of snapshots) {
      assert.deepEqual(await fs.readFile(file), bytes)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const module of ['../src/cli/main.ts', '../dist/src/cli/main.js']) {
  test(`Pi isolation: source/built CLI injection ${module}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-isolation-'))
    try {
      const script = `
        const { runCli } = await import(${JSON.stringify(fileURLToPath(new URL(module, import.meta.url)))})
        await runCli(['pi', '--version'], async (args, agentDir) => {
          process.stdout.write(JSON.stringify({ args, agentDir }))
        })
      `
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: root, ARAYA_DATA_DIR: 'relative-data', PI_CODING_AGENT_DIR: path.join(root, 'host'), PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions') }, cwd: root, timeout: 20_000 })
      assert.deepEqual(JSON.parse(stdout), { args: ['--version'], agentDir: path.join(root, 'relative-data', 'pi') })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

for (const module of ['../src/cli/main.ts', '../dist/src/cli/main.js']) {
  test(`Pi isolation: source/built CLI scopes SDK import before its tools directory is captured ${module}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-sdk-import-isolation-'))
    const hostAgentDir = path.join(root, 'standalone-pi')
    const arayaAgentDir = path.join(root, 'relative-data', 'pi')
    try {
      for (const agentDir of [hostAgentDir, arayaAgentDir]) {
        await fs.mkdir(path.join(agentDir, 'bin'), { recursive: true })
        await fs.writeFile(path.join(agentDir, 'bin', 'rg'), 'test marker')
      }
      const mainPath = fileURLToPath(new URL(module, import.meta.url))
      const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent')
      const script = `
        const { runCli } = await import(${JSON.stringify(mainPath)})
        await runCli(['pi', 'auth', '--help'], undefined, process.env)
        const { getToolPath } = await import(new URL('./utils/tools-manager.js', ${JSON.stringify(sdkEntry)}))
        process.stdout.write(JSON.stringify({
          toolPath: getToolPath('rg'),
          restoredAgentDir: process.env.PI_CODING_AGENT_DIR,
          restoredSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR
        }))
      `
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          ARAYA_DATA_DIR: 'relative-data',
          PI_CODING_AGENT_DIR: hostAgentDir,
          PI_CODING_AGENT_SESSION_DIR: path.join(hostAgentDir, 'sessions'),
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1'
        },
        cwd: root,
        timeout: 20_000
      })
      const output = stdout.trim().split('\n').at(-1)
      assert.equal(output, JSON.stringify({
        toolPath: path.join(arayaAgentDir, 'bin', 'rg'),
        restoredAgentDir: hostAgentDir,
        restoredSessionDir: path.join(hostAgentDir, 'sessions')
      }))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

test('Pi isolation: runner records dedicated agentDir and normalizes child environment', async () => {
  const setup = await createRunnerSetup()
  const hostDir = path.join(setup.fixture.root, 'host-pi')
  setup.env.PI_CODING_AGENT_DIR = hostDir
  setup.env.PI_CODING_AGENT_SESSION_DIR = path.join(hostDir, 'sessions')
  const ledger = openLedger(setup)
  const taskId = ledger.createTask(taskInput()).task.id
  const settingsDirs: string[] = []
  let childAgentDir: string | undefined
  let childSessionDir: string | undefined = 'not-checked'
  let runtimeAgentDir: string | undefined
  const runner = startRunner(setup, { createSystemdOps: async (env) => {
    childAgentDir = env.PI_CODING_AGENT_DIR
    childSessionDir = env.PI_CODING_AGENT_SESSION_DIR
    return setup.systemd.ops
  }, createModels: async ({ agentDir }) => {
    runtimeAgentDir = agentDir
    return setup.models.runtime
  }, createPiSettings: (_stateDir, agentDir) => {
    settingsDirs.push(agentDir)
    return {
      getDefaultProvider: () => { return undefined },
      getDefaultModel: () => { return undefined },
      getDefaultThinkingLevel: () => { return undefined },
      getModelThinkingLevel: () => { return undefined }
    }
  } })
  try {
    const shown = await waitForTaskStatus(setup, taskId, ['failed'])
    assert.equal(readSettings(setup.fixture.dataDir, taskId)?.agentDir, path.join(setup.fixture.dataDir, 'pi'))
    assert.deepEqual(settingsDirs, [path.join(setup.fixture.dataDir, 'pi')])
    assert.equal(childAgentDir, path.join(setup.fixture.dataDir, 'pi'))
    assert.equal(childSessionDir, undefined)
    assert.equal(runtimeAgentDir, path.join(setup.fixture.dataDir, 'pi'))
    assert.equal(setup.models.faux.state.callCount, 0)
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

for (const kind of ['control-plane', 'runner'] as const) {
  const modulePaths = kind === 'control-plane'
    ? ['../src/control-plane/runtime.ts', '../dist/src/control-plane/runtime.js']
    : ['../src/runner/runner.ts', '../dist/src/runner/runner.js']

  for (const module of modulePaths) {
    test(`Pi isolation: ${kind} SDK first import uses Araya bin despite inherited host paths (${module})`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-sdk-entry-isolation-'))
      const hostAgentDir = path.join(root, 'host-pi')
      const dataDir = path.join(root, 'data')
      const arayaAgentDir = path.join(dataDir, 'pi')
      const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent')

      try {
        for (const [agentDir, marker] of [[hostAgentDir, 'host'], [arayaAgentDir, 'araya']] as const) {
          await fs.mkdir(path.join(agentDir, 'bin'), { recursive: true })
          await fs.writeFile(path.join(agentDir, 'bin', 'rg'), marker)
          for (const name of ['auth.json', 'models.json', 'models-store.json']) {
            await fs.writeFile(path.join(agentDir, name), '{}\n')
          }
        }
        await fs.mkdir(path.join(dataDir, 'runner'), { recursive: true })

        const modulePath = fileURLToPath(new URL(module, import.meta.url))
        const script = `
          const app = await import(${JSON.stringify(modulePath)})
          const agentDir = ${JSON.stringify(arayaAgentDir)}
          const dataDir = ${JSON.stringify(dataDir)}
          if (${JSON.stringify(kind)} === 'control-plane') {
            await app.createArayaModelRuntime(agentDir)
          } else {
            await app.createRunnerModelRuntime({ agentDir, dataDir })
          }
          const { getToolPath } = await import(new URL('./utils/tools-manager.js', ${JSON.stringify(sdkEntry)}))
          process.stdout.write(JSON.stringify({
            toolPath: getToolPath('rg'),
            agentDir: process.env.PI_CODING_AGENT_DIR,
            sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR
          }))
        `
        const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            ARAYA_DATA_DIR: dataDir,
            PI_CODING_AGENT_DIR: hostAgentDir,
            PI_CODING_AGENT_SESSION_DIR: path.join(hostAgentDir, 'sessions'),
            PI_OFFLINE: '1',
            PI_SKIP_VERSION_CHECK: '1'
          },
          cwd: root,
          timeout: 20_000
        })

        const output = stdout.trim().split('\n').at(-1)
        assert.equal(output, JSON.stringify({
          toolPath: path.join(arayaAgentDir, 'bin', 'rg'),
          agentDir: hostAgentDir,
          sessionDir: path.join(hostAgentDir, 'sessions')
        }))
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }
}

test('Pi isolation: SHIKI native SettingsManager selects Araya settings and leaves host files unchanged', async () => {
  const setup = await createRunnerSetup()
  const hostPi = path.join(setup.fixture.home, '.pi', 'agent')
  await fs.mkdir(hostPi, { recursive: true })
  const hostSettings = Buffer.from('{"defaultProvider":"host-only","defaultModel":"host-only"}\n')
  const hostAuth = Buffer.from('{}\n')
  await fs.writeFile(path.join(hostPi, 'settings.json'), hostSettings)
  await fs.writeFile(path.join(hostPi, 'auth.json'), hostAuth)
  await fs.writeFile(path.join(setup.fixture.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: setup.models.model.provider, defaultModel: setup.models.model.id }))
  setup.env.PI_CODING_AGENT_DIR = hostPi
  setup.models.script(() => {
    return answer('faux completion without changes')
  })
  const ledger = openLedger(setup)
  const taskId = ledger.createTask(taskInput()).task.id
  const runner = startRunner(setup)
  try {
    const shown = await waitForTaskStatus(setup, taskId, ['completed', 'failed', 'blocked'])
    assert.ok(setup.models.faux.state.callCount > 0)
    assert.equal(shown.attempts[0]?.model?.provider, setup.models.model.provider)
    assert.equal(shown.attempts[0]?.model?.id, setup.models.model.id)
    assert.deepEqual(await fs.readFile(path.join(hostPi, 'settings.json')), hostSettings)
    assert.deepEqual(await fs.readFile(path.join(hostPi, 'auth.json')), hostAuth)
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})

for (const persistedTask of [false, true]) {
  test(`Pi isolation: legacy attempt fails without host settings or input rewrite (durable task: ${persistedTask})`, async () => {
    const setup = await createRunnerSetup()
    const ledger = openLedger(setup)
    const taskId = ledger.createTask(taskInput()).task.id
    const settings = { ...defaultSettings(setup.fixture, null), agentDir: path.join(setup.fixture.root, 'legacy-host-pi') }
    const claimed = ledger.claimNextAttempt(1, settings)
    assert.ok(claimed)
    if (persistedTask) {
      const { extension, attemptTask } = createShikiExtension({ dataDir: setup.fixture.dataDir, hash: setup.fixture.hash, ledger, systemd: setup.systemd.ops, models: setup.models.runtime, env: setup.env, secretValues: [], log: () => {}, draftPrDelivery: false })
      const registry = createRegistry()
      registry.install(extension)
      const storageDir = path.join(setup.fixture.dataDir, 'runner')
      await fs.mkdir(storageDir, { recursive: true })
      const harness = await Harness.open(await openNodeSqliteStorage(path.join(storageDir, 'durable.sqlite')), { models: setup.models.runtime, registry }, ctx)
      try {
        const root = await harness.root(ctx)
        await root.commit(async (tx) => {
          const id = await tx.createTask(attemptTask, buildAttemptInput(claimed), { ownership: { kind: 'conversation' }, background: true })
          const attempts = await tx.doc(AttemptsDoc)
          attempts.byTaskKey[claimed.taskKey] = { taskId: id }
        }, ctx)
      } finally {
        await harness.close(ctx)
      }
    }
    let settingsRead = false
    const runner = startRunner(setup, { createPiSettings: () => {
      settingsRead = true
      throw new Error('host settings must not be read')
    } })
    try {
      const shown = await waitForTaskStatus(setup, taskId, ['failed'])
      assert.equal(settingsRead, false)
      assert.equal(setup.models.faux.state.callCount, 0)
      assert.equal(shown.attempts[0]?.failureReason, 'attempt_error')
      assert.match(JSON.stringify(shown), /\/login.*retry/u)
      assert.deepEqual(readSettings(setup.fixture.dataDir, taskId), settings)
    } finally {
      ledger.close()
      await teardownRunner(setup, runner)
    }
  })
}

test('Pi isolation: legacy attempt is not resumed after a transient durable-task creation failure', async () => {
  const setup = await createRunnerSetup()
  const ledger = openLedger(setup)
  const taskId = ledger.createTask(taskInput()).task.id
  const settings = { ...defaultSettings(setup.fixture, null), agentDir: path.join(setup.fixture.root, 'legacy-host-pi') }
  const claimed = ledger.claimNextAttempt(1, settings)
  assert.ok(claimed)
  let createFailures = 1
  let settingsRead = false
  let runner = startRunner(setup, {
    faults: {
      beforeAttemptTaskCreate: () => {
        if (createFailures > 0) {
          createFailures -= 1
          throw new Error('transient durable-task creation failure')
        }
      }
    },
    createPiSettings: () => {
      settingsRead = true
      throw new Error('legacy Pi settings must not be read')
    }
  })
  let firstRunnerSettled = false
  let firstRunnerCode: number | undefined
  void runner.done.then((code) => {
    firstRunnerSettled = true
    firstRunnerCode = code
  })
  try {
    await waitUntil(() => firstRunnerSettled || settingsRead, 'legacy attempt reconciliation is isolated', 5_000)
    assert.equal(settingsRead, false)
    assert.equal(firstRunnerSettled, true)
    assert.equal(createFailures, 0)
    assert.equal(firstRunnerCode, 0)
    assert.equal(ledger.readStop(claimed.taskKey).stopReason, 'attempt_error')
    assert.deepEqual(readSettings(setup.fixture.dataDir, taskId), settings)
    assert.equal(setup.models.faux.state.callCount, 0)

    runner = startRunner(setup, {
      createPiSettings: () => {
        settingsRead = true
        throw new Error('legacy Pi settings must not be read')
      }
    })
    const shown = await waitForTaskStatus(setup, taskId, ['failed'])
    assert.equal(settingsRead, false)
    assert.equal(setup.models.faux.state.callCount, 0)
    assert.equal(shown.attempts[0]?.failureReason, 'attempt_error')
    assert.deepEqual(readSettings(setup.fixture.dataDir, taskId), settings)
  } finally {
    ledger.close()
    await teardownRunner(setup, runner)
  }
})
