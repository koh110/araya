#!/usr/bin/env node
// systemd LoadCredential から .env を読み、検証済み Discord 設定と allowlist 済み runtime environment だけを bot に渡す。

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
import {
  launcherStopWaitMs,
  launchChildAndWait,
  stderrLineWriter,
} from '../src/infrastructure/child-launcher.ts'


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

async function runDiscordBotProcess(
  dataDir: string,
  settings: ReturnType<typeof validateDiscordSettings>,
) {
  const modulePath = fileURLToPath(import.meta.url)
  const botEntrypoint = path.join(
    path.dirname(modulePath),
    `discord-bot${path.extname(modulePath)}`,
  )
  const outcome = await launchChildAndWait({
    command: process.execPath,
    args: [botEntrypoint, '--data-dir', dataDir],
    env: discordBotEnvironment(settings),
    stopWaitMs: launcherStopWaitMs(process.env),
    secretValues: [settings.botToken],
    label: 'discord-env-runner',
    writeError: stderrLineWriter(),
  })

  return outcome.exitCode
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
