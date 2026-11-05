#!/usr/bin/env node
// systemd LoadCredential から1Passwordを認証し、Discord botへ解決済み環境変数だけを渡す。

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  DISCORD_CONFIG_KEYS,
  OP_SERVICE_ACCOUNT_CREDENTIAL_NAME,
  OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME,
  discordEnvFilePath,
  discordRuntimeEnvironment,
  readDiscordEnvFile,
} from '../src/discord/config.ts'

const MAX_SERVICE_ACCOUNT_TOKEN_BYTES = 16 * 1024
const OP_AUTH_ENVIRONMENT_NAMES = [
  'CREDENTIALS_DIRECTORY',
  'OP_CONNECT_HOST',
  'OP_CONNECT_TOKEN',
  'OP_SESSION',
  'OP_ACCOUNT',
] as const
const SYSTEM_ENV_EXECUTABLE = '/usr/bin/env'

function runnerError(message: string) {
  return new Error(message)
}

async function readServiceAccountToken(credentialsDirectory: string | undefined) {
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

  if (fsConstants.O_NOFOLLOW === undefined) {
    throw runnerError('この環境では安全な credential file open を利用できません')
  }

  const credentialPath = path.join(credentialsDirectory, OP_SERVICE_ACCOUNT_CREDENTIAL_NAME)
  let handle

  try {
    handle = await fs.open(credentialPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw runnerError('1Password Service Account credential を開けません')
  }

  try {
    const stat = await handle.stat()
    const uid = typeof process.getuid === 'function' ? process.getuid() : null

    const mode = stat.mode & 0o777

    if (
      !stat.isFile() ||
      uid === null ||
      stat.uid !== uid ||
      (mode !== 0o400 && mode !== 0o600) ||
      stat.size === 0 ||
      stat.size > MAX_SERVICE_ACCOUNT_TOKEN_BYTES
    ) {
      throw runnerError('1Password Service Account credential の形式または権限が不正です')
    }

    let text

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile())
    } catch {
      throw runnerError('1Password Service Account credential は有効なUTF-8ではありません')
    }

    const token = text.endsWith('\r\n')
      ? text.slice(0, -2)
      : text.endsWith('\n')
        ? text.slice(0, -1)
        : text

    if (token === '' || /[\u0000-\u001f\u007f]/u.test(token)) {
      throw runnerError('1Password Service Account credential の内容が不正です')
    }

    return token
  } finally {
    await handle.close()
  }
}

async function validateDataDir(dataDir: string) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) {
    throw runnerError('dataDir はcanonicalな絶対pathで指定してください')
  }

  let stat
  let resolvedPath

  try {
    stat = await fs.lstat(dataDir)
    resolvedPath = await fs.realpath(dataDir)
  } catch {
    throw runnerError('dataDir を利用できません')
  }

  if (!stat.isDirectory() || resolvedPath !== dataDir) {
    throw runnerError('dataDir はsymlinkではない通常のdirectoryにしてください')
  }

  const envFilePath = discordEnvFilePath(dataDir)
  const settings = await readDiscordEnvFile(envFilePath)

  if (settings === null) {
    throw runnerError('.env がありません')
  }

  const missing = DISCORD_CONFIG_KEYS.filter((key) => {
    return settings[key] === undefined || settings[key] === ''
  })

  if (missing.length > 0) {
    throw runnerError(`.env に設定がありません: ${missing.join('・')}`)
  }

  return envFilePath
}

function parseRunnerArguments(args: string[]) {
  let parsed

  try {
    parsed = parseArgs({
      args,
      options: {
        'data-dir': { type: 'string' },
        'op-path': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch {
    throw runnerError('起動引数が不正です')
  }

  const dataDir = parsed.values['data-dir']
  const opPath = parsed.values['op-path']

  if (
    typeof dataDir !== 'string' ||
    dataDir === '' ||
    typeof opPath !== 'string' ||
    !path.isAbsolute(opPath)
  ) {
    throw runnerError('起動引数にdata-dirまたはop-pathがありません')
  }

  return { dataDir, opPath }
}

async function runOp(opPath: string, envFilePath: string, dataDir: string, token: string) {
  const opEnvironment = discordRuntimeEnvironment(process.env)

  for (const name of OP_AUTH_ENVIRONMENT_NAMES) {
    delete opEnvironment[name]
  }

  opEnvironment[OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME] = token

  const botEntrypoint = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `discord-bot${path.extname(fileURLToPath(import.meta.url))}`,
  )
  const args = ['run', '--env-file', envFilePath, '--', SYSTEM_ENV_EXECUTABLE]

  for (const name of OP_AUTH_ENVIRONMENT_NAMES) {
    args.push('-u', name)
  }

  args.push(
    '-u',
    OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME,
    process.execPath,
    botEntrypoint,
    '--data-dir',
    dataDir,
  )

  return await new Promise<number>((resolve) => {
    const child = spawn(opPath, args, {
      env: opEnvironment,
      shell: false,
      stdio: 'ignore',
    })
    let settled = false

    function finish(code: number, message?: string) {
      if (settled) {
        return
      }

      settled = true
      process.off('SIGTERM', forwardSigterm)
      process.off('SIGINT', forwardSigint)

      if (message !== undefined) {
        process.stderr.write(`discord-op-runner: ${message}\n`)
      }

      resolve(code)
    }
    function forwardSigterm() {
      child.kill('SIGTERM')
    }
    function forwardSigint() {
      child.kill('SIGINT')
    }

    process.once('SIGTERM', forwardSigterm)
    process.once('SIGINT', forwardSigint)
    child.once('error', () => {
      finish(127, '1Password CLIを起動できません')
    })
    child.once('exit', (code) => {
      if (code === 0) {
        finish(0)
        return
      }

      finish(code ?? 1, `op run が終了しました（status=${code ?? 'signal'}）`)
    })
  })
}

async function main() {
  try {
    const { dataDir, opPath } = parseRunnerArguments(process.argv.slice(2))
    const envFilePath = await validateDataDir(dataDir)
    const token = await readServiceAccountToken(process.env.CREDENTIALS_DIRECTORY)
    process.exitCode = await runOp(opPath, envFilePath, dataDir, token)
  } catch (error) {
    const message = error instanceof Error ? error.message : '初期化に失敗しました'
    process.stderr.write(`discord-op-runner: ${message}\n`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1])

if (invokedPath === fileURLToPath(import.meta.url)) {
  await main()
}
