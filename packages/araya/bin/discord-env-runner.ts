#!/usr/bin/env node
// systemd LoadCredential から .env を読み、Discord bot には設定値だけを渡す。

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  DISCORD_ENV_CREDENTIAL_NAME,
  discordBotEnvironment as createDiscordBotEnvironment,
  readDiscordEnvFile,
  validateDiscordSettings,
} from '../src/discord/config.ts'

function runnerError(message: string) {
  return new Error(message)
}

async function validateDataDir(dataDir: string) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) {
    throw runnerError('dataDir はcanonicalな絶対pathで指定してください')
  }

  let stat
  let realPath

  try {
    stat = await fs.lstat(dataDir)
    realPath = await fs.realpath(dataDir)
  } catch {
    throw runnerError('dataDir を利用できません')
  }

  if (!stat.isDirectory() || realPath !== dataDir) {
    throw runnerError('dataDir はsymlinkではない通常のdirectoryにしてください')
  }
}

export async function readDiscordSettings(credentialsDirectory: string | undefined) {
  if (credentialsDirectory === undefined || credentialsDirectory === '') {
    throw runnerError('systemd の CREDENTIALS_DIRECTORY がありません')
  }

  if (
    !path.isAbsolute(credentialsDirectory) ||
    path.resolve(credentialsDirectory) !== credentialsDirectory
  ) {
    throw runnerError('systemd の CREDENTIALS_DIRECTORY が不正です')
  }

  let directoryStat
  let resolvedDirectory

  try {
    directoryStat = await fs.lstat(credentialsDirectory)
    resolvedDirectory = await fs.realpath(credentialsDirectory)
  } catch {
    throw runnerError('systemd の credential directory を利用できません')
  }

  if (!directoryStat.isDirectory() || resolvedDirectory !== credentialsDirectory) {
    throw runnerError('systemd の credential directory が不正です')
  }

  const credentialFilePath = path.join(credentialsDirectory, DISCORD_ENV_CREDENTIAL_NAME)
  const settings = await readDiscordEnvFile(credentialFilePath)

  if (settings === null) {
    throw runnerError('Discord 設定の credential がありません')
  }

  if (settings.ARAYA_DISCORD_BOT_TOKEN?.startsWith('op://')) {
    throw runnerError('op:// 参照には1Password用の launcher を使ってください')
  }

  try {
    return validateDiscordSettings(settings)
  } catch (error) {
    throw runnerError(error instanceof Error ? error.message : 'Discord 設定が不正です')
  }
}

function parseRunnerArguments(args: string[]) {
  let parsed

  try {
    parsed = parseArgs({
      args,
      options: { 'data-dir': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    })
  } catch {
    throw runnerError('起動引数が不正です')
  }

  const dataDir = parsed.values['data-dir']

  if (typeof dataDir !== 'string' || dataDir === '') {
    throw runnerError('起動引数にdata-dirがありません')
  }

  return dataDir
}

export function discordBotEnvironment(
  settings: ReturnType<typeof validateDiscordSettings>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
) {
  return createDiscordBotEnvironment(settings, sourceEnv)
}

async function runDiscordBotProcess(dataDir: string, settings: ReturnType<typeof validateDiscordSettings>) {
  const modulePath = fileURLToPath(import.meta.url)
  const botEntrypoint = path.join(
    path.dirname(modulePath),
    `discord-bot${path.extname(modulePath)}`,
  )
  let child

  try {
    child = spawn(process.execPath, [botEntrypoint, '--data-dir', dataDir], {
      env: discordBotEnvironment(settings),
      shell: false,
      stdio: 'ignore',
    })
  } catch {
    throw runnerError('Discord bot を起動できません')
  }

  return await new Promise<number>((resolve) => {
    let settled = false

    const finish = (code: number, message?: string) => {
      if (settled) {
        return
      }

      settled = true
      process.off('SIGTERM', forwardSigterm)
      process.off('SIGINT', forwardSigint)

      if (message !== undefined) {
        process.stderr.write(`discord-env-runner: ${message}\n`)
      }

      resolve(code)
    }
    const forwardSigterm = () => {
      child.kill('SIGTERM')
    }
    const forwardSigint = () => {
      child.kill('SIGINT')
    }

    process.once('SIGTERM', forwardSigterm)
    process.once('SIGINT', forwardSigint)
    child.once('error', () => {
      finish(127, 'Discord bot を起動できません')
    })
    child.once('exit', (code) => {
      finish(code ?? 1, code === 0 ? undefined : `Discord bot が終了しました（status=${code ?? 'signal'}）`)
    })
  })
}

async function main() {
  try {
    const dataDir = parseRunnerArguments(process.argv.slice(2))
    await validateDataDir(dataDir)
    const settings = await readDiscordSettings(process.env.CREDENTIALS_DIRECTORY)
    process.exitCode = await runDiscordBotProcess(dataDir, settings)
  } catch (error) {
    const message = error instanceof Error ? error.message : '初期化に失敗しました'
    process.stderr.write(`discord-env-runner: ${message}\n`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1])

if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
