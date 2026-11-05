import fs from 'node:fs/promises'
import path from 'node:path'

// Discord 連携の設定は <dataDir>/.env（mode 0600）または環境変数から読む。
// 1Password の op:// 参照は任意で、op run が解決した環境変数を file より優先する。
// file が無いときだけ環境変数を使い、両方なければ無効。一部だけ指定されている場合は欠けた名前だけを列挙する。

const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/u
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u
const MAX_BOT_TOKEN_CHARS = 255

export const DISCORD_ENV_FILE_NAME = '.env'
export const DISCORD_ENV_CREDENTIAL_NAME = 'discord-env'
export const OP_SERVICE_ACCOUNT_CREDENTIAL_NAME = 'op-service-account-token'
export const OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME = 'OP_SERVICE_ACCOUNT_TOKEN'
export const MAX_DISCORD_ENV_FILE_BYTES = 16 * 1024

const DISCORD_ENV_TEMPLATE = [
  '# Araya Discord settings. Keep this file private (mode 0600).',
  '# The default location is <ARAYA_DATA_DIR>/.env, not the repository root.',
  'ARAYA_DISCORD_BOT_TOKEN=',
  'ARAYA_DISCORD_APPLICATION_ID=',
  'ARAYA_DISCORD_GUILD_ID=',
  'ARAYA_DISCORD_CHANNEL_ID=',
  'ARAYA_DISCORD_ALLOWED_USER_IDS=',
  '',
].join('\n')

export const DISCORD_CONFIG_KEYS = [
  'ARAYA_DISCORD_BOT_TOKEN',
  'ARAYA_DISCORD_APPLICATION_ID',
  'ARAYA_DISCORD_GUILD_ID',
  'ARAYA_DISCORD_CHANNEL_ID',
  'ARAYA_DISCORD_ALLOWED_USER_IDS',
] as const

const DISCORD_CONFIG_KEY_SET = new Set<string>(DISCORD_CONFIG_KEYS)

export type DiscordConfig = {
  botToken: string
  applicationId: string
  guildId: string
  channelId: string
  allowedUserIds: readonly string[]
}

// Discord bot に継承する systemd/runtime 環境の allowlist。Discord 設定は検証後に別途追加する。
export const DISCORD_BOT_RUNTIME_ENVIRONMENT_NAMES = [
  'HOME',
  'PATH',
  'LANG',
  'LANGUAGE',
  'TZ',
  'INVOCATION_ID',
  'LC_ALL',
  'LC_ADDRESS',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
] as const

export function discordRuntimeEnvironment(
  sourceEnv: Readonly<Record<string, string | undefined>>,
) {
  const env: NodeJS.ProcessEnv = {}

  for (const name of DISCORD_BOT_RUNTIME_ENVIRONMENT_NAMES) {
    const value = sourceEnv[name]

    if (value !== undefined) {
      env[name] = value
    }
  }

  return env
}

export function discordBotEnvironment(
  settings: DiscordConfig,
  sourceEnv: Readonly<Record<string, string | undefined>>,
) {
  const env = discordRuntimeEnvironment(sourceEnv)
  env.ARAYA_DISCORD_BOT_TOKEN = settings.botToken
  env.ARAYA_DISCORD_APPLICATION_ID = settings.applicationId
  env.ARAYA_DISCORD_GUILD_ID = settings.guildId
  env.ARAYA_DISCORD_CHANNEL_ID = settings.channelId
  env.ARAYA_DISCORD_ALLOWED_USER_IDS = settings.allowedUserIds.join(',')

  return env
}

export type DiscordConfigSource =
  | { enabled: false; reason: 'not_configured'; envFilePath: string }
  | { enabled: true; fromFile: boolean; envFilePath: string; config: DiscordConfig }

export function discordConfigError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

export function discordEnvFilePath(dataDir: string) {
  return path.join(dataDir, DISCORD_ENV_FILE_NAME)
}

export async function createDiscordEnvFile(dataDir: string) {
  const envFilePath = discordEnvFilePath(dataDir)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })

  let handle

  try {
    handle = await fs.open(envFilePath, 'wx', 0o600)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw discordConfigError(
        'discord_env_file_exists',
        `${envFilePath} は既にあります。既存 file は変更しません`,
      )
    }

    throw error
  }

  try {
    await handle.chmod(0o600)
    await handle.writeFile(DISCORD_ENV_TEMPLATE, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  return { created: true, envFilePath, mode: '0600' } as const
}

// .env の本文を読む。空行と # から始まる comment 行は無視し、それ以外の行は NAME=value の形でなければならない
export function parseDiscordEnvFile(text: string) {
  const settings: Record<string, string> = {}
  const lines = text.split(/\r?\n/u)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')
    const name = separator === -1 ? '' : trimmed.slice(0, separator).trim()

    if (!ENV_NAME_PATTERN.test(name)) {
      throw discordConfigError(
        'discord_env_file_invalid',
        `${DISCORD_ENV_FILE_NAME} の ${index + 1} 行目は NAME=value の形ではありません`,
      )
    }

    if (!DISCORD_CONFIG_KEY_SET.has(name)) {
      throw discordConfigError(
        'discord_env_file_invalid',
        `${DISCORD_ENV_FILE_NAME} の ${index + 1} 行目に未対応の設定名 ${name} があります`,
      )
    }

    if (settings[name] !== undefined) {
      throw discordConfigError(
        'discord_env_file_invalid',
        `${DISCORD_ENV_FILE_NAME} に ${name} が複数行書かれています`,
      )
    }

    settings[name] = trimmed.slice(separator + 1).trim()
  }

  return settings
}

// .env を読む。無ければ null。mode が group・other に読ませる値なら誤り
export async function readDiscordEnvFile(filePath: string) {
  let stat

  try {
    stat = await fs.lstat(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }

  if (!stat.isFile()) {
    throw discordConfigError(
      'discord_env_file_invalid',
      `${DISCORD_ENV_FILE_NAME} は通常の file ではありません`,
    )
  }

  if ((stat.mode & 0o077) !== 0) {
    throw discordConfigError(
      'discord_env_file_permissions',
      `${DISCORD_ENV_FILE_NAME} は group と other に読ませないでください（chmod 600）`,
    )
  }

  const content = await fs.readFile(filePath)

  if (content.byteLength > MAX_DISCORD_ENV_FILE_BYTES) {
    throw discordConfigError(
      'discord_env_file_invalid',
      `${DISCORD_ENV_FILE_NAME} は ${MAX_DISCORD_ENV_FILE_BYTES} byte を越えています`,
    )
  }

  let text: string

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw discordConfigError(
      'discord_env_file_invalid',
      `${DISCORD_ENV_FILE_NAME} は有効な UTF-8 ではありません`,
    )
  }

  return parseDiscordEnvFile(text)
}

// 値の検証。欠けている名前だけを列挙し、値はエラー消息に書かない
export function validateDiscordSettings(settings: Record<string, string | undefined>) {
  const missing = DISCORD_CONFIG_KEYS.filter((key) => {
    return settings[key] === undefined || settings[key] === ''
  })

  if (missing.length > 0) {
    throw discordConfigError(
      'discord_config_incomplete',
      `Discord の設定が足りません: ${missing.join('・')}`,
    )
  }

  const botToken = settings.ARAYA_DISCORD_BOT_TOKEN ?? ''
  const applicationId = settings.ARAYA_DISCORD_APPLICATION_ID ?? ''
  const guildId = settings.ARAYA_DISCORD_GUILD_ID ?? ''
  const channelId = settings.ARAYA_DISCORD_CHANNEL_ID ?? ''
  const allowedUserIdsValue = settings.ARAYA_DISCORD_ALLOWED_USER_IDS ?? ''

  if (botToken.includes('\u0000')) {
    throw discordConfigError(
      'discord_config_invalid',
      'ARAYA_DISCORD_BOT_TOKEN に NUL byte は使用できません',
    )
  }

  if (botToken.length > MAX_BOT_TOKEN_CHARS) {
    throw discordConfigError('discord_config_invalid', 'ARAYA_DISCORD_BOT_TOKEN が長すぎます')
  }

  for (const [name, value] of [
    ['ARAYA_DISCORD_APPLICATION_ID', applicationId],
    ['ARAYA_DISCORD_GUILD_ID', guildId],
    ['ARAYA_DISCORD_CHANNEL_ID', channelId],
  ] as const) {
    if (!SNOWFLAKE_PATTERN.test(value)) {
      throw discordConfigError(
        'discord_config_invalid',
        `${name} は 17〜20 桁の数値の Discord ID で指定してください`,
      )
    }
  }

  const allowedUserIds = allowedUserIdsValue.split(',').map((value) => {
    return value.trim()
  })

  if (
    allowedUserIds.length === 0 ||
    allowedUserIds.some((value) => {
      return !SNOWFLAKE_PATTERN.test(value)
    })
  ) {
    throw discordConfigError(
      'discord_config_invalid',
      'ARAYA_DISCORD_ALLOWED_USER_IDS は 17〜20 桁の数値の Discord ID をカンマ区切りで指定してください',
    )
  }

  if (new Set(allowedUserIds).size !== allowedUserIds.length) {
    throw discordConfigError(
      'discord_config_invalid',
      'ARAYA_DISCORD_ALLOWED_USER_IDS に重複した ID があります',
    )
  }

  return {
    botToken,
    applicationId,
    guildId,
    channelId,
    allowedUserIds,
  }
}

function assertResolvedDiscordSettings(settings: Readonly<Record<string, string | undefined>>) {
  const unresolved = DISCORD_CONFIG_KEYS.filter((key) => {
    return settings[key]?.includes('op://') === true
  })

  if (unresolved.length > 0) {
    throw discordConfigError(
      'discord_secret_reference_unresolved',
      `1Password の参照が解決されていません: ${unresolved.join('・')}。op run --env-file から起動してください`,
    )
  }
}

// file を読み、解決済み環境変数があれば優先する。未解決の op:// 参照は拒否する
export async function loadDiscordConfig(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const envFilePath = discordEnvFilePath(dataDir)
  const fileSettings = await readDiscordEnvFile(envFilePath)

  if (fileSettings !== null) {
    const settings: Record<string, string | undefined> = { ...fileSettings }

    for (const key of DISCORD_CONFIG_KEYS) {
      if (env[key] !== undefined) {
        settings[key] = env[key]
      }
    }

    assertResolvedDiscordSettings(settings)

    return {
      enabled: true,
      fromFile: true,
      envFilePath,
      config: validateDiscordSettings(settings),
    } satisfies DiscordConfigSource
  }

  const present = DISCORD_CONFIG_KEYS.filter((key) => {
    return env[key] !== undefined && env[key] !== ''
  })

  if (present.length === 0) {
    return { enabled: false, reason: 'not_configured', envFilePath } satisfies DiscordConfigSource
  }

  assertResolvedDiscordSettings(env)

  return {
    enabled: true,
    fromFile: false,
    envFilePath,
    config: validateDiscordSettings(env),
  } satisfies DiscordConfigSource
}
