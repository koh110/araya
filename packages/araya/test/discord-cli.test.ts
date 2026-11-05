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
const UID = process.getuid?.() ?? 1000

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
  const envRunnerEntrypoint = path.join(root, 'package', 'bin', 'discord-env-runner.ts')
  const opRunnerEntrypoint = path.join(root, 'package', 'bin', 'discord-op-runner.ts')
  const opPath = path.join(root, 'bin', 'op')
  const opTokenFile = path.join(configHome, 'araya', 'op-service-account-token')
  await fs.mkdir(home)
  await fs.mkdir(dataDir, { mode: 0o700 })
  await fs.mkdir(piAgentDir)
  await fs.mkdir(path.dirname(entrypoint), { recursive: true })
  await fs.mkdir(path.dirname(opPath), { recursive: true })
  await fs.mkdir(path.dirname(opTokenFile), { recursive: true, mode: 0o700 })
  await fs.writeFile(
    path.join(piAgentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'faux',
      defaultModel: 'test-model',
    }),
    'utf8',
  )
  await fs.writeFile(entrypoint, '', 'utf8')
  await fs.writeFile(envRunnerEntrypoint, '', 'utf8')
  await fs.writeFile(opRunnerEntrypoint, '', 'utf8')
  await fs.writeFile(opPath, '', { mode: 0o700 })
  await fs.writeFile(opTokenFile, 'synthetic-service-account-token\n', { mode: 0o600 })
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

  return {
    root,
    dataDir,
    devRoot,
    home,
    configHome,
    piAgentDir,
    entrypoint,
    envRunnerEntrypoint,
    opRunnerEntrypoint,
    opPath,
    opTokenFile,
    env,
  }
}

function unitOf(dataDirReal: string) {
  return discordUnitName(dataDirHash(dataDirReal))
}

function unitPathOf(installEnv: InstallEnv, unit: string) {
  return path.join(installEnv.configHome, 'systemd', 'user', unit)
}

// .env を mode 0600 で書く（通常の設定形式）
async function writePlainDiscordEnv(installEnv: InstallEnv, mode = 0o600) {
  const settings: Record<string, string> = {
    ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
    ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
    ARAYA_DISCORD_GUILD_ID: GUILD_ID,
    ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
    ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
  }
  await fs.writeFile(
    discordEnvFilePath(installEnv.dataDir),
    `${DISCORD_CONFIG_KEYS.map((key) => {
      return `${key}=${settings[key]}`
    }).join('\n')}\n`,
    { mode },
  )
}

// .env を mode 0600 で書く（1Password mode の設定）
async function writeDiscordEnv(installEnv: InstallEnv, mode = 0o600) {
  const lines = DISCORD_CONFIG_KEYS.map((key) => {
    const value =
      key === 'ARAYA_DISCORD_BOT_TOKEN'
        ? 'op://vault/item/bot-token'
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

async function writeDiscordEnvReferences(installEnv: InstallEnv) {
  await fs.writeFile(
    discordEnvFilePath(installEnv.dataDir),
    `${DISCORD_CONFIG_KEYS.map((key) => {
      return `${key}=op://vault/item/${key.toLowerCase()}`
    }).join('\n')}\n`,
    { mode: 0o600 },
  )
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
      resolveDiscordEnvRunnerEntrypoint: async () => {
        return installEnv.envRunnerEntrypoint
      },
      resolveDiscordOpRunnerEntrypoint: async () => {
        return installEnv.opRunnerEntrypoint
      },
      resolveOpCliPath: async () => {
        return installEnv.opPath
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

    const argumentSets: string[][] = [
      ['unknown'],
      [],
      ['install', 'extra'],
      ['install', '--auth-mode', 'unsupported'],
      ['run', '--auth-mode', '1password'],
    ]

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

test('discord install: .env が無ければ env file required。環境変数だけでは systemd 設定に使わない', async () => {
  const installEnv = await makeInstallEnv()

  try {
    const fake = createFakeSystemd({ systemctl: defaultSystemctl(installEnv) })

    // 設定なし（env の Discord key を外す）
    for (const key of DISCORD_CONFIG_KEYS) {
      delete installEnv.env[key]
    }
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('discord_env_file_required'),
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

    // .env の mode が緩い
    await writeDiscordEnv(installEnv, 0o640)
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('discord_env_file_permissions'),
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: LoadCredential 元ファイルが無い・権限過大なら unit を変更しない', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnv(installEnv)
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
  })

  try {
    await fs.rm(installEnv.opTokenFile)
    await assert.rejects(
      runDiscord(installEnv, ['install', '--auth-mode', '1password'], fake),
      errorWithCode('op_service_account_credential_missing'),
    )

    await fs.writeFile(installEnv.opTokenFile, 'synthetic-service-account-token\n', {
      mode: 0o640,
    })
    await assert.rejects(
      runDiscord(installEnv, ['install', '--auth-mode', '1password'], fake),
      errorWithCode('op_service_account_credential_permissions'),
    )

    const unitPath = unitPathOf(installEnv, unitOf(await fs.realpath(installEnv.dataDir)))
    await assert.rejects(fs.access(unitPath))
    assert.deepEqual(
      systemdCalls(fake).filter((call) => {
        return ['daemon-reload', 'enable', 'restart'].includes(call[2] ?? '')
      }),
      [],
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: op run と LoadCredential を使い、resolved token は unit file に出さない', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnv(installEnv)
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
    loginctl: async () => {
      return commandResult('yes\n')
    },
  })

  try {
    const { output, stderr, sleeps } = await runDiscord(
      installEnv,
      ['install', '--auth-mode', '1password'],
      fake,
    )
    const dataDirReal = await fs.realpath(installEnv.dataDir)
    const unit = unitOf(dataDirReal)
    const unitPath = unitPathOf(installEnv, unit)

    assert.equal(readField(output, 'unit'), unit)
    assert.equal(readField(output, 'unitPath'), unitPath)
    assert.equal(readField(output, 'envFile'), discordEnvFilePath(dataDirReal))
    assert.equal(readField(output, 'authMode'), '1password')
    assert.equal(readField(output, 'opCredentialFile'), installEnv.opTokenFile)
    assert.equal(readField(output, 'ready'), true)
    assert.equal(readField(output, 'linger'), true)
    assert.equal(stderr, '')
    assert.deepEqual(sleeps, [])

    // unit file は LoadCredential で認証し、.env は op run のみが読む。Environment= に Discord 設定を出さない
    assert.equal(
      await fs.readFile(unitPath, 'utf8'),
      [
        '[Unit]',
        `Description=araya discord ${dataDirReal}`,
        'StartLimitIntervalSec=0',
        '',
        '[Service]',
        'Type=exec',
        `ExecStart=${NODE_PATH} ${installEnv.opRunnerEntrypoint} --data-dir ${dataDirReal} --op-path ${installEnv.opPath}`,
        `LoadCredential=op-service-account-token:${installEnv.opTokenFile}`,
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
        `StandardError=append:${path.join(dataDirReal, 'logs', 'discord-launcher.log')}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    )
    const unitText = await fs.readFile(unitPath, 'utf8')
    assert.ok(!unitText.includes('EnvironmentFile='))
    assert.ok(!unitText.includes('OP_SERVICE_ACCOUNT_TOKEN'))
    assert.ok(!unitText.includes(BOT_TOKEN))
    assert.ok(!unitText.includes('synthetic-service-account-token'))
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

test('discord install: --auth-mode 1password で op run の解決値を使い launcher を選ぶ', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnvReferences(installEnv)

  try {
    const { output, stderr } = await runDiscord(
      installEnv,
      ['install', '--auth-mode', '1password'],
      createFakeSystemd({
        systemctl: defaultSystemctl(installEnv),
      }),
    )
    const unitText = await fs.readFile(
      unitPathOf(installEnv, unitOf(await fs.realpath(installEnv.dataDir))),
      'utf8',
    )

    assert.equal(readField(output, 'authMode'), '1password')
    assert.equal(readField(output, 'ready'), true)
    assert.equal(stderr, '')
    assert.ok(unitText.includes(installEnv.opRunnerEntrypoint), unitText)
    assert.ok(!unitText.includes('Environment=ARAYA_DISCORD_'), unitText)
    assert.ok(!unitText.includes(BOT_TOKEN), unitText)
    assert.ok(!unitText.includes(APPLICATION_ID), unitText)
    assert.ok(!unitText.includes(GUILD_ID), unitText)
    assert.ok(!unitText.includes(CHANNEL_ID), unitText)
    assert.ok(!unitText.includes(USER_ID), unitText)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: --auth-mode 1password は平文 .env でも指定できる', async () => {
  const installEnv = await makeInstallEnv()

  await writePlainDiscordEnv(installEnv)

  try {
    const { output } = await runDiscord(
      installEnv,
      ['install', '--auth-mode', '1password'],
      createFakeSystemd({
        systemctl: defaultSystemctl(installEnv),
      }),
    )
    const unitText = await fs.readFile(
      unitPathOf(installEnv, unitOf(await fs.realpath(installEnv.dataDir))),
      'utf8',
    )

    assert.equal(readField(output, 'authMode'), '1password')
    assert.ok(unitText.includes(installEnv.opRunnerEntrypoint), unitText)
    assert.ok(!unitText.includes(BOT_TOKEN), unitText)
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: 1password mode は option で選び、.env の値から推測しない', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnvReferences(installEnv)
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
  })

  try {
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake, {
        resolveOpCliPath: async () => {
          throw new Error('既定 mode では op CLI を探さない')
        },
        resolveDiscordOpRunnerEntrypoint: async () => {
          throw new Error('既定 mode では1Password launcherを探さない')
        },
      }),
      errorWithCode('discord_env_file_conflict'),
    )
    assert.equal(await exists(unitPathOf(installEnv, unitOf(installEnv.dataDir))), false)
    assert.deepEqual(
      systemdCalls(fake).filter((call) => {
        return ['daemon-reload', 'enable', 'restart'].includes(call[2] ?? '')
      }),
      [],
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: .env を1password modeで使う場合も op run の解決値が必要', async () => {
  const installEnv = await makeInstallEnv()

  await writeDiscordEnvReferences(installEnv)
  for (const key of DISCORD_CONFIG_KEYS) {
    delete installEnv.env[key]
  }
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
  })

  try {
    await assert.rejects(
      runDiscord(installEnv, ['install', '--auth-mode', '1password'], fake),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false
        }

        assert.ok(errorWithCode('discord_config_invalid')(error))
        assert.ok(!error.message.includes('op://'))
        return true
      },
    )
    assert.equal(await exists(unitPathOf(installEnv, unitOf(installEnv.dataDir))), false)
    assert.deepEqual(
      systemdCalls(fake).filter((call) => {
        return ['daemon-reload', 'enable', 'restart'].includes(call[2] ?? '')
      }),
      [],
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: resolved environment cannot fill a missing saved setting', async () => {
  const installEnv = await makeInstallEnv()

  await writePlainDiscordEnv(installEnv)
  const envFilePath = discordEnvFilePath(installEnv.dataDir)
  await fs.writeFile(
    envFilePath,
    (await fs.readFile(envFilePath, 'utf8')).replace(
      /^ARAYA_DISCORD_ALLOWED_USER_IDS=.*(?:\r?\n|$)/mu,
      '',
    ),
    { mode: 0o600 },
  )

  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
  })

  try {
    await assert.rejects(
      runDiscord(installEnv, ['install'], fake),
      errorWithCode('discord_env_file_incomplete'),
    )
    assert.equal(await exists(unitPathOf(installEnv, unitOf(installEnv.dataDir))), false)
    assert.deepEqual(
      systemdCalls(fake).filter((call) => {
        return ['daemon-reload', 'enable', 'restart'].includes(call[2] ?? '')
      }),
      [],
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: environment override cannot mask an invalid saved setting', async () => {
  const installEnv = await makeInstallEnv()

  await writePlainDiscordEnv(installEnv)
  const envFilePath = discordEnvFilePath(installEnv.dataDir)
  await fs.writeFile(
    envFilePath,
    (await fs.readFile(envFilePath, 'utf8')).replace(
      `ARAYA_DISCORD_APPLICATION_ID=${APPLICATION_ID}`,
      'ARAYA_DISCORD_APPLICATION_ID=synthetic-invalid-id',
    ),
    { mode: 0o600 },
  )

  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
  })

  try {
    await assert.rejects(runDiscord(installEnv, ['install'], fake), (error: unknown) => {
      if (!(error instanceof Error)) {
        return false
      }

      assert.ok(errorWithCode('discord_env_file_conflict')(error))
      assert.ok(!error.message.includes('synthetic-invalid-id'))
      return true
    })
    assert.equal(await exists(unitPathOf(installEnv, unitOf(installEnv.dataDir))), false)
    assert.deepEqual(
      systemdCalls(fake).filter((call) => {
        return ['daemon-reload', 'enable', 'restart'].includes(call[2] ?? '')
      }),
      [],
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: 平文 .env は1Passwordなしで systemd LoadCredential から起動する', async () => {
  const installEnv = await makeInstallEnv()

  for (const key of DISCORD_CONFIG_KEYS) {
    delete installEnv.env[key]
  }
  await writePlainDiscordEnv(installEnv)
  await fs.rm(installEnv.opTokenFile, { force: true })
  const fake = createFakeSystemd({
    systemctl: defaultSystemctl(installEnv),
  })

  try {
    const { output, stderr } = await runDiscord(installEnv, ['install'], fake, {
      resolveOpCliPath: async () => {
        throw new Error('plain .env mode は op CLI を探さない')
      },
      resolveDiscordOpRunnerEntrypoint: async () => {
        throw new Error('plain .env mode は1Password launcherを探さない')
      },
    })
    const dataDirReal = await fs.realpath(installEnv.dataDir)
    const unitPath = unitPathOf(installEnv, unitOf(dataDirReal))
    const unitText = await fs.readFile(unitPath, 'utf8')

    assert.equal(readField(output, 'authMode'), 'env-file')
    assert.equal(readField(output, 'envFile'), discordEnvFilePath(dataDirReal))
    assert.equal(readField(output, 'opCredentialFile'), undefined)
    assert.equal(readField(output, 'ready'), true)
    assert.equal(stderr, '')
    assert.ok(
      unitText.includes(
        `ExecStart=${NODE_PATH} ${installEnv.envRunnerEntrypoint} --data-dir ${dataDirReal}`,
      ),
      unitText,
    )
    assert.ok(
      unitText.includes(`LoadCredential=discord-env:${discordEnvFilePath(dataDirReal)}`),
      unitText,
    )
    assert.ok(!unitText.includes('op-service-account-token'), unitText)
    assert.ok(!unitText.includes('OP_SERVICE_ACCOUNT_TOKEN'), unitText)
    assert.ok(!unitText.includes(BOT_TOKEN), unitText)
    assert.ok(!unitText.includes('Environment=ARAYA_DISCORD_'), unitText)
    assert.ok(!stderr.includes(BOT_TOKEN), stderr)
    assert.deepEqual(
      systemdCalls(fake)
        .filter((call) => {
          return ['daemon-reload', 'enable', 'restart'].includes(call[2] ?? '')
        })
        .map((call) => {
          return call[2]
        }),
      ['daemon-reload', 'enable', 'restart'],
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord install: restart 前の readyId を今回の ready として扱わない', async () => {
  const installEnv = await makeInstallEnv()

  await writePlainDiscordEnv(installEnv)
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

  await writePlainDiscordEnv(installEnv)
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

  await writePlainDiscordEnv(installEnv)
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

test('discord init: .env を mode 0600 で作り、内容を表示せず path を返す', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({})

  try {
    const { output } = await runDiscord(installEnv, ['init'], fake)
    const envFile = discordEnvFilePath(installEnv.dataDir)
    const content = await fs.readFile(envFile, 'utf8')

    assert.deepEqual(output, { created: true, envFilePath: envFile, mode: '0600' })
    assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600)
    assert.ok(content.includes('ARAYA_DISCORD_BOT_TOKEN='))
    assert.ok(!content.includes('op://'))
    assert.deepEqual(systemdCalls(fake), [])
    await assert.rejects(
      runDiscord(installEnv, ['init'], fake),
      errorWithCode('discord_env_file_exists'),
    )
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord register: .env の平文 token から slash command を登録する', async () => {
  const installEnv = await makeInstallEnv()
  const fake = createFakeSystemd({})
  const envFile = discordEnvFilePath(installEnv.dataDir)

  try {
    await fs.writeFile(
      envFile,
      DISCORD_CONFIG_KEYS.map((key) => {
        return `${key}=${
          key === 'ARAYA_DISCORD_BOT_TOKEN'
            ? BOT_TOKEN
            : key === 'ARAYA_DISCORD_APPLICATION_ID'
              ? APPLICATION_ID
              : key === 'ARAYA_DISCORD_GUILD_ID'
                ? GUILD_ID
                : key === 'ARAYA_DISCORD_CHANNEL_ID'
                  ? CHANNEL_ID
                  : USER_ID
        }`
      }).join('\n'),
      { mode: 0o600 },
    )
    for (const key of DISCORD_CONFIG_KEYS) {
      delete installEnv.env[key]
    }
    let registered: Record<string, unknown> | null = null
    await runDiscord(installEnv, ['register'], fake, {
      registerDiscordCommands: async (config) => {
        registered = { ...config }
      },
    })
    assert.deepEqual(registered, {
      botToken: BOT_TOKEN,
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      allowedUserIds: [USER_ID],
    })
  } finally {
    await fs.rm(installEnv.root, { recursive: true, force: true })
  }
})

test('discord register: 設定（.env か環境変数）から slash command を guild に登録する', async () => {
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
