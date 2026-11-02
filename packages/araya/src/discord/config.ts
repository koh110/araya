import fs from 'node:fs/promises'
import path from 'node:path'

// Discord 連携の設定。常駐 service の基準は <dataDir>/discord.env（mode 0600、グループと other に読ませない）。
// file が無いときは環境変数を見る（araya discord register など、service を入れる前の initial setup だけ）。
// どちらも無ければ Discord 連携は無効。一部だけ指定されているときは設定不備として、欠けた名前だけを列挙する（値はエラーに出さない）

const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/u
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u
const MAX_BOT_TOKEN_CHARS = 255

export const DISCORD_ENV_FILE_NAME = 'discord.env'
export const MAX_DISCORD_ENV_FILE_BYTES = 16 * 1024

export const DISCORD_CONFIG_KEYS = [
  'ARAYA_DISCORD_BOT_TOKEN',
  'ARAYA_DISCORD_APPLICATION_ID',
  'ARAYA_DISCORD_GUILD_ID',
  'ARAYA_DISCORD_CHANNEL_ID',
  'ARAYA_DISCORD_ALLOWED_USER_IDS',
] as const

export type DiscordConfig = {
  botToken: string
  applicationId: string
  guildId: string
  channelId: string
  allowedUserIds: readonly string[]
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

// discord.env の本文を読む。空行と # から始まる comment 行は無視し、それ以外の行は NAME=value の形でなければならない
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

// discord.env を読む。無ければ null。mode が group・other に読ませる form なら誤り
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

// file を先に読み、無ければ環境変数を見る。どちらも無ければ enabled: false
export async function loadDiscordConfig(
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const envFilePath = discordEnvFilePath(dataDir)
  const fileSettings = await readDiscordEnvFile(envFilePath)

  if (fileSettings !== null) {
    return {
      enabled: true,
      fromFile: true,
      envFilePath,
      config: validateDiscordSettings(fileSettings),
    } satisfies DiscordConfigSource
  }

  const present = DISCORD_CONFIG_KEYS.filter((key) => {
    return env[key] !== undefined && env[key] !== ''
  })

  if (present.length === 0) {
    return { enabled: false, reason: 'not_configured', envFilePath } satisfies DiscordConfigSource
  }

  return {
    enabled: true,
    fromFile: false,
    envFilePath,
    config: validateDiscordSettings(env),
  } satisfies DiscordConfigSource
}
