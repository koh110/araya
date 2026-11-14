import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DISCORD_CONFIG_KEYS,
  DISCORD_ENV_CREDENTIAL_NAME,
  OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME,
} from '../src/discord/config.ts'
import { discordBotEnvironment, readDiscordSettings } from '../bin/discord-env-runner.ts'
import { readProcessEnvironment } from './config.ts'

const BOT_TOKEN = 'discord-bot-token-value'
const APPLICATION_ID = '123456789012345678'
const GUILD_ID = '12345678901234567'
const CHANNEL_ID = '12345678901234568'
const USER_ID = '12345678901234569'
const RUNNER_PATH = fileURLToPath(new URL('../bin/discord-env-runner.ts', import.meta.url))

const SETTINGS: Record<string, string> = {
  ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
  ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
  ARAYA_DISCORD_GUILD_ID: GUILD_ID,
  ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
  ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
}

async function makeDirectory() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-env-runner-test-'))
}

async function writeCredential(directory: string, token = BOT_TOKEN) {
  const credentialPath = path.join(directory, DISCORD_ENV_CREDENTIAL_NAME)
  const content = DISCORD_CONFIG_KEYS.map((key) => {
    return `${key}=${SETTINGS[key]}`
  })
    .join('\n')
    .replace(`ARAYA_DISCORD_BOT_TOKEN=${BOT_TOKEN}`, `ARAYA_DISCORD_BOT_TOKEN=${token}`)

  await fs.writeFile(credentialPath, `${content}\n`, { mode: 0o600 })

  return credentialPath
}

function errorContaining(text: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(text), error.message)

    return true
  }
}

test('discord-env-runner: LoadCredential の平文 .env を読み込み、設定値を検証する', async () => {
  const directory = await makeDirectory()

  try {
    await writeCredential(directory)

    const settings = await readDiscordSettings(directory)

    assert.deepEqual(settings, {
      botToken: BOT_TOKEN,
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      allowedUserIds: [USER_ID],
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('discord-env-runner: .env の設定値を独自解釈せず、通常の検証だけ行う', async () => {
  const directory = await makeDirectory()

  try {
    await writeCredential(directory, 'op://vault/item/credential')
    assert.equal((await readDiscordSettings(directory)).botToken, 'op://vault/item/credential')

    const credentialPath = path.join(directory, DISCORD_ENV_CREDENTIAL_NAME)
    await fs.writeFile(credentialPath, 'ARAYA_DISCORD_BOT_TOKEN=plain-token\n', { mode: 0o600 })
    await assert.rejects(
      readDiscordSettings(directory),
      errorContaining('Discord の設定が足りません'),
    )
    await assert.rejects(readDiscordSettings(undefined), errorContaining('CREDENTIALS_DIRECTORY'))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('discord-env-runner: malformed token を含む launcher error に token 値を出さない', async () => {
  const directory = await makeDirectory()

  try {
    await writeCredential(directory, 'synthetic-discord-token\u0000')

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', RUNNER_PATH, '--data-dir', directory],
      {
        encoding: 'utf8',
        env: {
          CREDENTIALS_DIRECTORY: directory,
          HOME: directory,
          PATH: readProcessEnvironment('PATH') ?? '/usr/bin:/bin',
        },
        timeout: 5_000,
      },
    )

    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /discord-env-runner/u)
    assert.ok(!result.stderr.includes('synthetic-discord-token'))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('discord-env-runner: bot は Discord 設定と gh CLI config selector を渡し、token とほかの systemd/1Password credentials を除く', () => {
  const settings = {
    botToken: BOT_TOKEN,
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    allowedUserIds: [USER_ID],
  }
  const sourceEnv: NodeJS.ProcessEnv = {
    HOME: '/home/araya',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    INVOCATION_ID: 'service-invocation-id',
    CREDENTIALS_DIRECTORY: '/run/credentials/araya.service',
    [OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME]: 'service-account-secret',
    OP_CONNECT_HOST: 'https://connect.invalid',
    OP_CONNECT_TOKEN: 'connect-secret',
    OP_SESSION: 'session-secret',
    OP_ACCOUNT: 'private-account',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'github-secret',
    GITHUB_ENTERPRISE_TOKEN: 'github-enterprise-secret',
    GH_TOKEN: 'github-cli-token',
    GH_ENTERPRISE_TOKEN: 'github-cli-enterprise-secret',
    GH_HOST: 'github.com',
    GH_CONFIG_DIR: '/home/araya/.config/gh',
    XDG_CONFIG_HOME: '/home/araya/.config',
    ARAYA_DISCORD_BOT_TOKEN: 'inherited-token',
    ARAYA_DISCORD_APPLICATION_ID: '111111111111111111',
    OTHER_VALUE: 'preserved',
  }

  const environment = discordBotEnvironment(settings, sourceEnv)

  assert.equal(environment.HOME, '/home/araya')
  assert.equal(environment.PATH, '/usr/bin:/bin')
  assert.equal(environment.LANG, 'en_US.UTF-8')
  assert.equal(environment.LC_ALL, 'en_US.UTF-8')
  assert.equal(environment.INVOCATION_ID, 'service-invocation-id')
  assert.equal(environment.OTHER_VALUE, undefined)
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(environment.GITHUB_TOKEN, undefined)
  assert.equal(environment.GITHUB_ENTERPRISE_TOKEN, undefined)
  assert.equal(environment.GH_TOKEN, undefined)
  assert.equal(environment.GH_ENTERPRISE_TOKEN, undefined)
  assert.equal(environment.GH_HOST, 'github.com')
  assert.equal(environment.GH_CONFIG_DIR, '/home/araya/.config/gh')
  assert.equal(environment.XDG_CONFIG_HOME, '/home/araya/.config')
  assert.equal(environment.CREDENTIALS_DIRECTORY, undefined)
  assert.equal(environment[OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME], undefined)
  assert.equal(environment.OP_CONNECT_HOST, undefined)
  assert.equal(environment.OP_CONNECT_TOKEN, undefined)
  assert.equal(environment.OP_SESSION, undefined)
  assert.equal(environment.OP_ACCOUNT, undefined)
  assert.equal(environment.ARAYA_DISCORD_BOT_TOKEN, BOT_TOKEN)
  assert.equal(environment.ARAYA_DISCORD_APPLICATION_ID, APPLICATION_ID)
  assert.equal(environment.ARAYA_DISCORD_GUILD_ID, GUILD_ID)
  assert.equal(environment.ARAYA_DISCORD_CHANNEL_ID, CHANNEL_ID)
  assert.equal(environment.ARAYA_DISCORD_ALLOWED_USER_IDS, USER_ID)
  assert.equal(sourceEnv.ARAYA_DISCORD_BOT_TOKEN, 'inherited-token')
})
