import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DISCORD_CONFIG_KEYS,
  MAX_DISCORD_ENV_FILE_BYTES,
  discordEnvFilePath,
  loadDiscordConfig,
  parseDiscordEnvFile,
  readDiscordEnvFile,
  validateDiscordSettings,
} from '../src/discord/config.ts'

const BOT_TOKEN = 'discord-b…alue'
const APPLICATION_ID = '123456789012345678'
const GUILD_ID = '12345678901234567'
const CHANNEL_ID = '12345678901234568'
const USER_ID_A = '12345678901234569'
const USER_ID_B = '12345678901234570'

const SETTINGS: Record<string, string> = {
  ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
  ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
  ARAYA_DISCORD_GUILD_ID: GUILD_ID,
  ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
  ARAYA_DISCORD_ALLOWED_USER_IDS: `${USER_ID_A},${USER_ID_B}`,
}

function errorWithCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok('code' in error)
    assert.equal(error.code, code, error.message)

    return true
  }
}

async function makeDataDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-config-test-')))
}

test('discord-config: discord.env の本文は comment と空行を無視して NAME=value を読む', () => {
  const settings = parseDiscordEnvFile(
    [
      '# setup',
      '',
      `ARAYA_DISCORD_BOT_TOKEN =  ${BOT_TOKEN} `,
      'ARAYA_DISCORD_ALLOWED_USER_IDS=12345678901234569, 12345678901234570',
      '   # 末尾の comment',
      '',
    ].join('\n'),
  )

  assert.deepEqual(settings, {
    ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
    ARAYA_DISCORD_ALLOWED_USER_IDS: '12345678901234569, 12345678901234570',
  })

  assert.throws(() => {
    return parseDiscordEnvFile('not a setting line')
  }, errorWithCode('discord_env_file_invalid'))
  assert.throws(() => {
    return parseDiscordEnvFile('lower_name=value')
  }, errorWithCode('discord_env_file_invalid'))
  assert.throws(() => {
    return parseDiscordEnvFile('A=1\nA=2')
  }, errorWithCode('discord_env_file_invalid'))
})

test('discord-config: 設定の検証。値はエラー消息に出さず、欠けた名前だけを列挙する', () => {
  const config = validateDiscordSettings(SETTINGS)

  assert.deepEqual(config, {
    botToken: BOT_TOKEN,
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    allowedUserIds: [USER_ID_A, USER_ID_B],
  })

  const missing = { ...SETTINGS }

  delete missing.ARAYA_DISCORD_GUILD_ID

  try {
    validateDiscordSettings(missing)
    assert.fail('到達しない')
  } catch (error: unknown) {
    assert.ok(error instanceof Error)
    assert.ok(errorWithCode('discord_config_incomplete')(error))
    assert.ok(error.message.includes('ARAYA_DISCORD_GUILD_ID'))
    assert.ok(!error.message.includes(BOT_TOKEN), '値を消息に出さない')
  }

  assert.throws(() => {
    return validateDiscordSettings({ ...SETTINGS, ARAYA_DISCORD_ALLOWED_USER_IDS: '' })
  }, errorWithCode('discord_config_incomplete'))

  const invalidOverrides: Record<string, string>[] = [
    { ARAYA_DISCORD_GUILD_ID: '12345' },
    { ARAYA_DISCORD_APPLICATION_ID: 'abc' },
    { ARAYA_DISCORD_ALLOWED_USER_IDS: `${USER_ID_A}, ${USER_ID_A}` },
    { ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID_A + 'abc' },
    { ARAYA_DISCORD_BOT_TOKEN: 'x'.repeat(MAX_DISCORD_ENV_FILE_BYTES * 2) },
  ]

  for (const override of invalidOverrides) {
    assert.throws(
      () => {
        return validateDiscordSettings({ ...SETTINGS, ...override })
      },
      errorWithCode('discord_config_invalid'),
      JSON.stringify(override),
    )
  }
})

test('discord-config: discord.env は mode 0600 の通常の file だけ読む', async () => {
  const dataDir = await makeDataDir()

  try {
    const filePath = discordEnvFilePath(dataDir)

    assert.equal(await readDiscordEnvFile(filePath), null)

    await fs.writeFile(
      filePath,
      DISCORD_CONFIG_KEYS.map((key) => {
        return `${key}=${SETTINGS[key]}`
      }).join('\n') + '\n',
      { mode: 0o600 },
    )
    assert.deepEqual(await readDiscordEnvFile(filePath), SETTINGS)

    await fs.chmod(filePath, 0o640)
    await assert.rejects(
      readDiscordEnvFile(filePath),
      errorWithCode('discord_env_file_permissions'),
    )

    await fs.chmod(filePath, 0o600)
    await fs.rm(filePath)
    await fs.mkdir(filePath)
    await assert.rejects(readDiscordEnvFile(filePath), errorWithCode('discord_env_file_invalid'))
    await fs.rmdir(filePath)

    await fs.writeFile(filePath, 'x'.repeat(MAX_DISCORD_ENV_FILE_BYTES + 1), { mode: 0o600 })
    await assert.rejects(readDiscordEnvFile(filePath), errorWithCode('discord_env_file_invalid'))

    await fs.writeFile(filePath, Buffer.from([0xff, 0xfe, 0x00, 0x41]), { mode: 0o600 })
    await assert.rejects(readDiscordEnvFile(filePath), errorWithCode('discord_env_file_invalid'))
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord-config: 1Password が解決した環境変数は discord.env の参照より優先する', async () => {
  const dataDir = await makeDataDir()
  const reference = 'op://vault/item/bot-token'
  const fileSettings: Record<string, string> = { ...SETTINGS, ARAYA_DISCORD_BOT_TOKEN: reference }

  try {
    await fs.writeFile(
      discordEnvFilePath(dataDir),
      DISCORD_CONFIG_KEYS.map((key) => {
        return `${key}=${fileSettings[key]}`
      }).join('\n'),
      { mode: 0o600 },
    )

    const source = await loadDiscordConfig(dataDir, { ...SETTINGS })

    assert.equal(source.enabled, true)
    assert.equal(source.fromFile, true)
    if (!source.enabled) {
      assert.fail('到達しない')
    }
    assert.deepEqual(source.config, validateDiscordSettings(SETTINGS))
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord-config: 未解決の1Password参照は値を出さずに拒否する', async () => {
  const dataDir = await makeDataDir()
  const reference = 'op://vault/item/bot-token'
  const fileSettings: Record<string, string> = { ...SETTINGS, ARAYA_DISCORD_BOT_TOKEN: reference }

  try {
    await fs.writeFile(
      discordEnvFilePath(dataDir),
      DISCORD_CONFIG_KEYS.map((key) => {
        return `${key}=${fileSettings[key]}`
      }).join('\n'),
      { mode: 0o600 },
    )

    await assert.rejects(
      loadDiscordConfig(dataDir, {}),
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error)) {
          return false
        }

        assert.equal(error.code, 'discord_secret_reference_unresolved')
        assert.ok(!error.message.includes(reference))

        return true
      },
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord-config: discord.env に Bot token の平文を保存しない', async () => {
  const dataDir = await makeDataDir()

  try {
    await fs.writeFile(
      discordEnvFilePath(dataDir),
      DISCORD_CONFIG_KEYS.map((key) => {
        return `${key}=${SETTINGS[key]}`
      }).join('\n'),
      { mode: 0o600 },
    )

    await assert.rejects(
      loadDiscordConfig(dataDir, {}),
      errorWithCode('discord_bot_token_must_use_1password'),
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord-config: file がある場合は解決済み環境変数を優先する。無ければ環境変数だけを見る', async () => {
  const dataDir = await makeDataDir()

  try {
    const off = await loadDiscordConfig(dataDir, { ARAYA_DATA_DIR: dataDir })

    assert.deepEqual(off, {
      enabled: false,
      reason: 'not_configured',
      envFilePath: discordEnvFilePath(dataDir),
    })

    // 環境変数だけ（service を入れる前の initial setup）
    const fromEnv = await loadDiscordConfig(dataDir, { ...SETTINGS })

    assert.equal(fromEnv.enabled, true)
    assert.equal(fromEnv.fromFile, false)
    if (!fromEnv.enabled) {
      assert.fail('到達しない')
    }
    assert.deepEqual(fromEnv.config, validateDiscordSettings(SETTINGS))

    // 一部だけの環境変数は設定不備
    await assert.rejects(
      loadDiscordConfig(dataDir, { ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN }),
      errorWithCode('discord_config_incomplete'),
    )

    // resolved 1Password environment values override file references and literals
    const fileSettings: Record<string, string> = {
      ...SETTINGS,
      ARAYA_DISCORD_BOT_TOKEN: 'op://vault/item/bot-token',
    }
    const partialEnv: Record<string, string> = {
      ...SETTINGS,
      ARAYA_DISCORD_CHANNEL_ID: '99999999999999999',
    }

    await fs.writeFile(
      discordEnvFilePath(dataDir),
      DISCORD_CONFIG_KEYS.map((key) => {
        return `${key}=${fileSettings[key]}`
      }).join('\n'),
      { mode: 0o600 },
    )
    const fromFile = await loadDiscordConfig(dataDir, partialEnv)

    assert.equal(fromFile.enabled, true)
    assert.equal(fromFile.fromFile, true)
    if (fromFile.enabled !== true) {
      assert.fail('到達しない')
    }
    assert.equal(fromFile.config.channelId, partialEnv.ARAYA_DISCORD_CHANNEL_ID)
    assert.equal(fromFile.config.botToken, partialEnv.ARAYA_DISCORD_BOT_TOKEN)

    // mode が緩い file は startup を fail させる
    await fs.chmod(discordEnvFilePath(dataDir), 0o604)
    await assert.rejects(
      loadDiscordConfig(dataDir, { ...SETTINGS }),
      errorWithCode('discord_env_file_permissions'),
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
