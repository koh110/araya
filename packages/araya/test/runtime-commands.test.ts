import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runRuntimeCommand } from '../src/cli/runtime-commands.ts'
import {
  buildDiscordUnitFile,
  buildRunnerUnitFile,
  buildRuntimeTargetUnitFile,
  dataDirHash,
  discordUnitName,
  runnerUnitName,
  runtimeTargetUnitName,
  unitFilePath,
  type CommandResult,
  type SystemdOps,
} from '../src/infrastructure/systemd.ts'
import { commandResult, createFakeSystemd } from './support/fake-systemd.ts'

async function makeFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-runtime-command-test-')))
  const dataDir = path.join(root, 'data')
  const homeDir = path.join(root, 'home')
  const env = { HOME: homeDir, XDG_CONFIG_HOME: path.join(root, 'config'), PATH: '/usr/bin:/bin' }
  const config = { dataDir, devRoot: path.join(root, 'dev'), piAgentDir: path.join(dataDir, 'pi') }
  const hash = dataDirHash(dataDir)
  const runner = runnerUnitName(hash)
  const discord = discordUnitName(hash)
  const target = runtimeTargetUnitName(hash)
  const paths = new Map<string, string>([runner, discord, target].map((unit) => {
    return [unit, unitFilePath(env, homeDir, unit)]
  }))

  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(homeDir, { recursive: true })
  await fs.mkdir(path.dirname(paths.get(runner)!), { recursive: true, mode: 0o700 })

  const runnerContent = buildRunnerUnitFile({
    dataDir,
    nodePath: '/usr/bin/node',
    entrypoint: '/opt/araya/bin/task-runner.js',
    systemctlPath: '/usr/bin/systemctl',
    environment: [['PATH', '/usr/bin:/bin']],
  })
  const discordContent = buildDiscordUnitFile({
    authMode: 'env-file',
    dataDir,
    nodePath: '/usr/bin/node',
    runnerEntrypoint: '/opt/araya/bin/discord-env-runner.js',
    envFilePath: path.join(dataDir, '.env'),
    environment: [['PATH', '/usr/bin:/bin']],
  })

  await fs.writeFile(paths.get(runner)!, runnerContent, { mode: 0o600 })
  await fs.writeFile(paths.get(discord)!, discordContent, { mode: 0o600 })

  return { root, dataDir, homeDir, env, config, hash, runner, discord, target, paths, runnerContent, discordContent }
}

function createRuntimeSystemd(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  options: { missingUnit?: string; withoutPartOf?: string } = {},
) {
  const fake = createFakeSystemd({
    systemctl: async (args): Promise<CommandResult> => {
      if (args[1] === 'is-system-running') {
        return commandResult('running\n')
      }

      if (args[1] === 'show') {
        const property = args[2]
        const unit = args.at(-1) ?? ''

        if (unit === options.missingUnit) {
          return commandResult('', 1, `Unit ${unit} not loaded.`)
        }

        if (property === '--property=FragmentPath') {
          return commandResult(`${fixture.paths.get(unit) ?? ''}\n`)
        }

        if (property === '--property=PartOf') {
          return commandResult(unit === options.withoutPartOf ? '\n' : `${fixture.target}\n`)
        }
      }

      return commandResult()
    },
  })

  return fake
}

test('runtime install: 両 component unit の loaded PartOf 契約を確認して target だけを有効化し、start する', async () => {
  const fixture = await makeFixture()
  const fake = createRuntimeSystemd(fixture)
  const stdout: string[] = []
  const stderr: string[] = []
  const targetPath = fixture.paths.get(fixture.target)!
  const deps = {
    platform: 'linux' as const,
    env: fixture.env,
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    nowMs: () => Date.now(),
    createSystemdOps: async (_env: Readonly<Record<string, string | undefined>>): Promise<SystemdOps> => fake.ops,
    homeDir: fixture.homeDir,
    uid: process.getuid?.() ?? -1,
  }

  try {
    const beforeRunner = await fs.readFile(fixture.paths.get(fixture.runner)!)
    const beforeDiscord = await fs.readFile(fixture.paths.get(fixture.discord)!)
    await runRuntimeCommand(['install'], fixture.config, deps)

    assert.equal(await fs.readFile(targetPath, 'utf8'), buildRuntimeTargetUnitFile({ dataDir: fixture.dataDir }))
    assert.equal((await fs.stat(targetPath)).mode & 0o777, 0o600)
    assert.deepEqual(await fs.readFile(fixture.paths.get(fixture.runner)!), beforeRunner)
    assert.deepEqual(await fs.readFile(fixture.paths.get(fixture.discord)!), beforeDiscord)
    assert.equal(stdout.length, 1)
    assert.equal(stderr.length, 0)
    assert.deepEqual(fake.systemctlCalls(), [
      ['--user', 'is-system-running'],
      ['--user', 'show', '--property=FragmentPath', '--value', fixture.runner],
      ['--user', 'show', '--property=PartOf', '--value', fixture.runner],
      ['--user', 'show', '--property=FragmentPath', '--value', fixture.discord],
      ['--user', 'show', '--property=PartOf', '--value', fixture.discord],
      ['--user', 'daemon-reload'],
      ['--user', 'show', '--property=FragmentPath', '--value', fixture.target],
      ['--user', 'enable', fixture.target],
      ['--user', 'start', fixture.target],
    ])
    assert.equal(fake.systemctlCalls().some((args) => args[1] === 'restart'), false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('runtime install: component unit が欠けているか runtime target と未連動なら target file を作らない', async (t) => {
  for (const options of [
    { removeUnit: true, expectedCode: 'runtime_component_missing' },
    { missingUnit: 'discord', expectedCode: 'runtime_component_not_loaded' },
    { withoutPartOf: 'discord', expectedCode: 'runtime_component_not_linked' },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const fixture = await makeFixture()
      const componentPath = fixture.paths.get(fixture.discord)!

      if (options.removeUnit === true) {
        await fs.unlink(componentPath)
      }

      const fake = createRuntimeSystemd(fixture, {
        ...(options.missingUnit === undefined ? {} : { missingUnit: fixture.discord }),
        ...(options.withoutPartOf === undefined ? {} : { withoutPartOf: fixture.discord }),
      })
      const deps = {
        platform: 'linux' as const,
        env: fixture.env,
        stdout: () => {},
        stderr: () => {},
        nowMs: () => Date.now(),
        createSystemdOps: async (_env: Readonly<Record<string, string | undefined>>): Promise<SystemdOps> => fake.ops,
        homeDir: fixture.homeDir,
        uid: process.getuid?.() ?? -1,
      }

      try {
        await assert.rejects(runRuntimeCommand(['install'], fixture.config, deps), (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok('code' in error)
          assert.equal(error.code, options.expectedCode)
          return true
        })
        await assert.rejects(fs.access(fixture.paths.get(fixture.target)!), { code: 'ENOENT' })

        if (options.removeUnit === true) {
          await assert.rejects(fs.access(componentPath), { code: 'ENOENT' })
        } else {
          assert.equal(await fs.readFile(componentPath, 'utf8'), fixture.discordContent)
        }
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true })
      }
    })
  }
})

test('runtime uninstall: target だけを stop・disable・削除し component service と台帳設定を残す', async () => {
  const fixture = await makeFixture()
  const fake = createRuntimeSystemd(fixture)
  const stdout: string[] = []
  const deps = {
    platform: 'linux' as const,
    env: fixture.env,
    stdout: (text: string) => stdout.push(text),
    stderr: () => {},
    nowMs: () => Date.now(),
    createSystemdOps: async (_env: Readonly<Record<string, string | undefined>>): Promise<SystemdOps> => fake.ops,
    homeDir: fixture.homeDir,
    uid: process.getuid?.() ?? -1,
  }
  const targetPath = fixture.paths.get(fixture.target)!

  try {
    await fs.writeFile(targetPath, buildRuntimeTargetUnitFile({ dataDir: fixture.dataDir }), { mode: 0o600 })
    await runRuntimeCommand(['uninstall'], fixture.config, deps)

    await assert.rejects(fs.access(targetPath), { code: 'ENOENT' })
    assert.equal((await fs.readFile(fixture.paths.get(fixture.runner)!, 'utf8')), fixture.runnerContent)
    assert.equal((await fs.readFile(fixture.paths.get(fixture.discord)!, 'utf8')), fixture.discordContent)
    assert.deepEqual(fake.systemctlCalls(), [
      ['--user', 'disable', '--now', fixture.target],
      ['--user', 'daemon-reload'],
    ])
    assert.equal(stdout.length, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
