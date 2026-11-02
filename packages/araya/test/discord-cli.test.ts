import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { runCli } from '../src/cli/main.ts'
import { dataDirHash, discordUnitName, type CommandResult } from '../src/infrastructure/systemd.ts'
import type { DiscordCommandDependencies } from '../src/cli/discord-commands.ts'
import { DISCORD_CONFIG_KEYS, discordEnvFilePath } from '../src/discord/config.ts'
import {
  discordStateFilePath,
  newState,
  readDiscordBotState,
  writeDiscordBotState,
} from '../src/discord/state.ts'
import { commandResult, createFakeSystemd } from './support/fake-systemd.ts'

const BOT_TOKEN = 'discord-b…alue'
const APPLICATION_ID = '123456789012345678'
const GUILD_ID = '12345678901234567'
const CHANNEL_ID = '12345678901234568'
const USER_ID = '12345678901234569'
const NODE_PATH = '/usr/bin/node'
const UID = 1000

type InstallEnv = Awaited<ReturnType<typeof makeInstallEnv>>

async function makeInstallEnv() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-cli-test-')),
  )
  const dataDir = path.join(root, 'data')
  const devRoot = path.join(root, 'dev')
  const home = path.join(root, 'home')
  const configHome = path.join(root, 'xdg')
  const piAgentDir = path.join(dataDir, 'pi')
  const entrypoint = path.join(root, 'package', 'bin', 'discord-bot.ts')
  await fs.mkdir(home)
  await fs.mkdir(dataDir, { mode: 0o700 })
  await fs.mkdir(piAgentDir)
  await fs.mkdir(path.dirname(entrypoint), { recursive: true })
  await fs.writeFile(
    path.join(piAgentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'faux',
      defaultModel: 'test-model',
    }),
    'utf8',
  )
  await fs.writeFile(entrypoint, '', 'utf8')
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    ARAYA_DATA_DIR: dataDir,
    ARAYA_DEV_ROOT: devRoot,
    ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
    ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
    ARAYA_DISCORD_GUILD_ID: GUILD_ID,
    ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
    ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
    PI_CODING_AGENT_DIR: piAgentDir,
  }

  return { root, dataDir, devRoot, home, configHome, piAgentDir, entrypoint, env }
}

function unitOf(dataDirReal: string) {
  return discordUnitName(dataDirHash(dataDirReal))
}

function unitPathOf(installEnv: InstallEnv, unit: string) {
  return path.join(installEnv.configHome, 'systemd', 'user', unit)
}

// discord.env を mode 0600 で書く（常駐 service の設定の基準）
async function writeDiscordEnv(installEnv: InstallEnv, mode = 0o600) {
  const lines = DISCORD_CONFIG_KEYS.map((key) => {
    const value =
      key === 'ARAYA_DISCORD_BOT_TOKEN'
        ? BOT_TOKEN
        : key === 'ARAYA_DISCORD_APPLICATION_ID'
          ? APPLICATION_ID
          : key === 'ARAYA_DISCORD_GUILD_ID'
            ? GUILD_ID
            : key === 'ARAYA_DISCORD_ALLOWED_USER_IDS'
              ? USER_ID
              : CHANNEL_ID

    return `${key}=${value}`
  })

  await fs.writeFile(discordEnvFilePath(installEnv.dataDir), `${lines.join('\n')}\n`, { mode })
}

function defaultSystemctl(
  installEnv: InstallEnv,
  overrides: Partial<Record<string, (args: readonly string[]) => CommandResult>> = {},
) {
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

    if (command === 'restart') {
      // restart が state.json を ready にする（unit process の ready 記録の代わり）
      writeDiscordBotState(installEnv.dataDir, {
        ...newState(unit),
        cursor: 0,
        readyId: 'ready-after-restart',
        lastReadyAt: '2026-10-31T00:00:00.000Z',
      })
    }

    return commandResult()
  }
}

async function runDiscord(
  installEnv: InstallEnv,
  args: string[],
  fake: ReturnType<typeof createFakeSystemd>,
  deps: Partial<DiscordCommandDependencies> = {},
) {
  const stdout: string[] = []
  const stderr: string[] = []
  let clock = Date.parse('2026-10-31T00:00:00.000Z')
  const sleeps: number[] = []
  await runCli(
    ['discord', ...args],
    async () => {
      throw new Error('Pi を起動しない')
    },
    installEnv.env,
    {
      platform: 'linux',
      stdin: Readable.from([]),
      stdout: (text) => {
        return stdout.push(text)
      },
      stderr: (text) => {
        return stderr.push(text)
      },
      nowMs: () => {
        return clock
      },
      createSystemdOps: async () => {
        return fake.ops
      },
      nodePath: NODE_PATH,
      resolveDiscordEntrypoint: async () => {
        return installEnv.entrypoint
      },
      homeDir: installEnv.home,
      uid: UID,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      ...deps,
    },
  )
  const output: unknown = stdout.length === 0 ? undefined : JSON.parse(stdout.join('\n'))

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

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

function systemdCalls(fake: ReturnType<typeof createFakeSystemd>) {
  return fake.records().flatMap((entry) => {
    return entry.type === 'systemctl' || entry.type === 'loginctl'
      ? [[entry.type, ...entry.args, String(entry.timeoutMs)]]
      : []
  })
}

test('discord CLI: 知らない subcommand は invalid_arguments', async () => {
  const installEnv = await makeInstallEnv()

  try {
    const fake = createFakeSystemd({})

    const argumentSets: string[][] = [['unknown'], [], ['install', 'extra']]

    for (const args of argumentSets) {
      await assert.rejects(
        runDiscord(installEnv, args, fake),
        errorWithCode('invalid_arguments'),
        JSON.stringify(args),
      )
    }
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: 設定が無ければ discord_not_configured、環境変数だけなら discord_env_file_required', async () => {
  const installEnv = await makeInstallEnv()

  try {
    const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv) })

    // 設定なし（env の Discord key を外す）
    for (const key of DISCORD_CONFIG_KEYS) {
      delete installEnv.env[key]
    }
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('discord_not_configured'),
    )
    assert.equal(await exists(unitPathOf(installEnv, unitOf(installEnv.dataDir))), false)

    // 環境変数だけ
    installEnv.env.ARAYA_DISCORD_BOT_TOKEN = BOT_TOKEN
    installEnv.env.ARAYA_DISCORD_APPLICATION_ID = APPLICATION_ID
    installEnv.env.ARAYA_DISCORD_GUILD_ID = GUILD_ID
    installEnv.env.ARAYA_DISCORD_CHANNEL_ID = CHANNEL_ID
    installEnv.env.ARAYA_DISCORD_ALLOWED_USER_IDS = USER_ID
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('discord_env_file_required'),
    )

    // discord.env の mode が緩い
    await writeDiscordEnv(installEnv, 0o640)
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('discord_env_file_permissions'),
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: unit file を書き、EnvironmentFile で discord.env を参照し、token は unit file に出さない', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnv(installEnv)
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => {
      return commandResult('yes\n')
    },
  })

  try {
    const { output, stderr, sleeps } = await runDiscord(installEnv, ['install'], fake)
    const dataDirReal = await fs.realpath(installEnv.dataDir)
    const unit = unitOf(dataDirReal)
    const unitPath = unitPathOf(installEnv, unit)

    assert.equal(readField(output, 'unit'), unit)
    assert.equal(readField(output, 'unitPath'), unitPath)
    assert.equal(readField(output, 'envFile'), discordEnvFilePath(dataDirReal))
    assert.equal(readField(output, 'ready'), true)
    assert.equal(readField(output, 'linger'), true)
    assert.equal(stderr, '')
    assert.deepEqual(sleeps, [])

    // unit file の形：token は EnvironmentFile 側。Environment= に ARAYA_DISCORD_* は現れない
    assert.equal(
      await fs.readFile(unitPath, 'utf8'),
      [
        '[Unit]',
        `Description=araya discord ${dataDirReal}`,
        'StartLimitIntervalSec=0',
        '',
        '[Service]',
        'Type=exec',
        `ExecStart=${NODE_PATH} ${installEnv.entrypoint} --data-dir ${dataDirReal}`,
        `EnvironmentFile=${discordEnvFilePath(dataDirReal)}`,
        `WorkingDirectory=${dataDirReal}`,
        `Environment=ARAYA_DATA_DIR=${dataDirReal}`,
        `Environment=ARAYA_DEV_ROOT=${installEnv.devRoot}`,
        'Environment=PATH=/usr/bin:/bin',
        `Environment=PI_CODING_AGENT_DIR=${installEnv.piAgentDir}`,
        'KillMode=control-group',
        'Restart=always',
        'RestartSec=1s',
        'RestartSteps=5',
        'RestartMaxDelaySec=1min',
        'TimeoutStopSec=30',
        'StandardInput=null',
        'StandardOutput=null',
        'StandardError=null',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    )
    assert.ok(!(await fs.readFile(unitPath, 'utf8')).includes(BOT_TOKEN))
    assert.equal((await fs.stat(unitPath)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.join(installEnv.dataDir, 'logs'))).mode & 0o777, 0o700)

    assert.deepEqual(systemdCalls(fake), [
      ['systemctl', '--user', 'is-system-running', '10000'],
      ['systemctl', '--user', 'daemon-reload', '30000'],
      ['systemctl', '--user', 'show', '--property=FragmentPath', '--value', unit, '30000'],
      ['systemctl', '--user', 'enable', unit, '30000'],
      ['systemctl', '--user', 'restart', unit, '90000'],
      ['loginctl', 'show-user', String(UID), '--property=Linger', '--value', '30000'],
    ])
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: restart 前の readyId を今回の ready として扱わない', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnv(installEnv)
  const unit = unitOf(await fs.realpath(installEnv.dataDir))
  writeDiscordBotState(installEnv.dataDir, {
    ...newState(unit),
    cursor: 0,
    readyId: 'ready-before-restart',
    lastReadyAt: '2026-10-30T23:59:59.000Z',
  })
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv, {
      restart: () => {
        return commandResult()
      },
    }),
  })

  try {
    const { output, stderr } = await runDiscord(installEnv, ['install'], fake)

    assert.equal(readField(output, 'ready'), false)
    assert.ok(stderr.includes('起動が確認できませんでした'), stderr)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: ready にならなければ warning を出して、そのときの値で終わる', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnv(installEnv)
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv, {
      restart: () => {
        return commandResult()
      },
    }),
    loginctl: async () => {
      return commandResult('no\n')
    },
  })

  try {
    const { output, stderr, sleeps } = await runDiscord(installEnv, ['install'], fake)
    const unit = unitOf(await fs.realpath(installEnv.dataDir))

    assert.equal(readField(output, 'unit'), unit)
    assert.equal(readField(output, 'ready'), false)
    assert.equal(readField(output, 'linger'), false)
    assert.ok(stderr.includes(`warning: ${unit} の起動が確認できませんでした`), stderr)
    assert.ok(stderr.includes('logout すると Discord bot が止まります'), stderr)
    assert.equal(sleeps.length, 50, '10 秒を 200ms 刻みで待つ')
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: user manager に接続できなければ systemd_unavailable で unit file を残さない', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnv(installEnv)
  const fake = createFakeSystemd({
    systemctl: async () => {
      return commandResult('offline\n')
    },
  })

  try {
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('systemd_unavailable'),
    )
    assert.equal(await exists(unitPathOf(installEnv, unitOf(installEnv.dataDir))), false)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord register: 設定（discord.env か環境変数）から slash command を guild に登録する', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({})

  try {
    let registered: Record<string, unknown> | null = null
    const { output } = await runDiscord(installEnv, ['register'], fake, {
      registerDiscordCommands: async (config) => {
        registered = { ...config }
      },
    })

    assert.equal(readField(output, 'applicationId'), APPLICATION_ID)
    assert.equal(readField(output, 'guildId'), GUILD_ID)
    assert.equal(readField(output, 'command'), 'araya')
    assert.deepEqual(readField(output, 'subcommands'), [
      'list',
      'show',
      'submit',
      'cancel',
      'retry',
    ])
    assert.deepEqual(registered, {
      botToken: BOT_TOKEN,
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      allowedUserIds: [USER_ID],
    })

    for (const key of DISCORD_CONFIG_KEYS) {
      delete installEnv.env[key]
    }
    await assert.rejects(
      runDiscord(installEnv, ['register'], fake),
      errorWithCode('discord_not_configured'),
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord run: foreground では unit 稼働を確かめずに bot を動かし、code 1 は discord_run_failed', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({})

  try {
    let captured: Record<string, unknown> | null = null
    const { output } = await runDiscord(installEnv, ['run'], fake, {
      runBot: async (deps) => {
        captured = { dataDir: deps.dataDir, verifyUnit: deps.verifyUnit }

        return 0
      },
    })

    assert.deepEqual(output, { ok: true })
    assert.deepEqual(captured, { dataDir: installEnv.dataDir, verifyUnit: false })

    await assert.rejects(
      runDiscord(installEnv, ['run'], fake, {
        runBot: async () => {
          return 1
        },
      }),
      errorWithCode('discord_run_failed'),
    )

    for (const key of DISCORD_CONFIG_KEYS) {
      delete installEnv.env[key]
    }
    await assert.rejects(
      runDiscord(installEnv, ['run'], fake, {
        runBot: async () => {
          return 0
        },
      }),
      errorWithCode('discord_not_configured'),
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord uninstall: unit file を消して daemon-reload。state.json と台帳は残す', async () => {
  const installEnv = await makeInstallEnv()
  const dataDirReal = await fs.realpath(installEnv.dataDir)
  const unit = unitOf(dataDirReal)
  const unitPath = unitPathOf(installEnv, unit)

  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 })
  await fs.writeFile(unitPath, '[Unit]\n', { mode: 0o600 })
  writeDiscordBotState(installEnv.dataDir, {
    ...newState(unit),
    cursor: 3,
    lastReadyAt: '2026-10-31T00:00:00.000Z',
  })

  const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv) })

  try {
    const { output } = await runDiscord(installEnv, ['uninstall'], fake)

    assert.equal(readField(output, 'unit'), unit)
    assert.equal(readField(output, 'removed'), true)
    assert.equal(readField(output, 'stateFile'), discordStateFilePath(installEnv.dataDir))
    assert.equal(await exists(unitPath), false)
    assert.equal(readField(readDiscordBotState(installEnv.dataDir), 'cursor'), 3)
    assert.ok(
      systemdCalls(fake).some((entry) => {
        return entry[0] === 'systemctl' && entry[1] === '--user' && entry[2] === 'disable'
      }),
    )
    assert.ok(
      systemdCalls(fake).some((entry) => {
        return entry[0] === 'systemctl' && entry.includes('daemon-reload')
      }),
    )

    // unit file が無いときも removed: false で通す
    const second = await runDiscord(installEnv, ['uninstall'], fake)

    assert.equal(readField(second.output, 'removed'), false)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord uninstall: unit が無いことの systemctl の失敗だけ無視する', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({
    systemctl: async (args) => {
      if (args[1] === 'disable') {
        return commandResult('', 5, `Failed to disable unit: Unit ${args.at(-1)} does not exist.`)
      }

      if (args[1] === 'stop') {
        return commandResult('', 5, 'Unit not loaded.')
      }

      return commandResult()
    },
  })

  try {
    const { output } = await runDiscord(installEnv, ['uninstall'], fake)

    assert.equal(readField(output, 'removed'), false)
    assert.ok(
      systemdCalls(fake).some((entry) => {
        return entry[1] === '--user' && entry[2] === 'stop'
      }),
      'disable 失敗の後 stop。not loaded は無視',
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})
