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

import {
  launcherStopWaitMs,
  launchChildAndWait,
  redactSecretValues,
} from '../src/infrastructure/child-launcher.ts'
const MAX_SERVICE_ACCOUNT_TOKEN_BYTES = 16 * 1024
const OP_AUTH_ENVIRONMENT_NAMES = [
  'CREDENTIALS_DIRECTORY',
  'OP_CONNECT_HOST',
  'OP_CONNECT_TOKEN',
  'OP_SESSION',
  'OP_ACCOUNT',
] as const
const SYSTEM_ENV_EXECUTABLE = '/usr/bin/env'
const RESOLVER_MARKER = 'ARAYA_RESOLVED_ENV='
const OP_RESOLVE_TIMEOUT_MS = 30_000
const MAX_RESOLVER_STDOUT_BYTES = 1024 * 1024
const MAX_OP_STDERR_CHARS = 2_000

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

  // op:// 参照だった key だけ crash trace から redact する（PATH などの通常値は見せて診断に使う）
  const secretKeys = Object.entries(settings)
    .filter(([, value]) => {
      return typeof value === 'string' && value.startsWith('op://')
    })
    .map(([key]) => {
      return key
    })

  return { envFilePath, secretKeys }
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

function strippedEnvironmentNames() {
  return [...OP_AUTH_ENVIRONMENT_NAMES, OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME]
}

function envResolverScript(stripped: readonly string[]) {
  return [
    'const strip = new Set((process.argv[1] ?? "").split(",").filter(Boolean));',
    'const snapshot = {};',
    'for (const [name, value] of Object.entries(process.env)) {',
    '  if (!strip.has(name) && typeof value === "string") { snapshot[name] = value }',
    '}',
    `process.stdout.write(${JSON.stringify(RESOLVER_MARKER)} + JSON.stringify(snapshot) + "\\n");`,
  ].join(' ')
}

function opBaseEnvironment(token: string) {
  const env = discordRuntimeEnvironment(process.env)

  for (const name of OP_AUTH_ENVIRONMENT_NAMES) {
    delete env[name]
  }

  env[OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME] = token

  return env
}

// op run は「bot を起動する process」ではなく「.env を 1 回解決して env を見せる process」として使う。
// 解決値を runner の memory に取り込めば、bot は runner の直接 child になる。
// それが #36 の truncated drain に対する修正: KillMode=control-group では main process（runner）が
// 先に死んだ時点で残った bot が SIGKILL され、drain が途中で潰れる。
async function resolveEnvironment(opPath: string, envFilePath: string, token: string) {
  const stripped = strippedEnvironmentNames()
  const args = ['run', '--env-file', envFilePath, '--', SYSTEM_ENV_EXECUTABLE]

  for (const name of stripped) {
    args.push('-u', name)
  }

  args.push(process.execPath, '-e', envResolverScript(stripped), stripped.join(','))

  const outcome = await new Promise<{
    code: number | null
    signal: string | null
    stdout: string
    stderr: string
  }>((resolve) => {
    let child

    try {
      child = spawn(opPath, args, {
        env: opBaseEnvironment(token),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ code: 127, signal: null, stdout: '', stderr: '' })

      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      child.kill('SIGKILL')
      resolve({ code: null, signal: 'timeout', stdout, stderr })
    }, OP_RESOLVE_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_RESOLVER_STDOUT_BYTES) {
        stdout += chunk
      }
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OP_STDERR_CHARS) {
        stderr += chunk
      }
    })
    child.once('error', () => {
      clearTimeout(timer)

      if (!settled) {
        settled = true
        resolve({ code: 127, signal: null, stdout, stderr })
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)

      if (!settled) {
        settled = true
        resolve({ code, signal, stdout, stderr })
      }
    })
  })

  if (outcome.signal === 'timeout') {
    throw runnerError(`1Password CLI が ${OP_RESOLVE_TIMEOUT_MS}ms 内に .env を解決できませんでした`)
  }

  if (outcome.code !== 0) {
    throw runnerError(
      `1Password CLI で .env を解決できませんでした（status=${outcome.code ?? 'signal'}・${redactSecretValues(outcome.stderr, [token]).slice(0, MAX_OP_STDERR_CHARS)}）`,
    )
  }

  const markerLine = outcome.stdout.split('\n').find((line) => {
    return line.startsWith(RESOLVER_MARKER)
  })

  if (markerLine === undefined) {
    throw runnerError('1Password CLI の env 解決結果を取得できません')
  }

  let parsed

  try {
    parsed = JSON.parse(markerLine.slice(RESOLVER_MARKER.length))
  } catch {
    throw runnerError('1Password CLI の env 解決結果の形式が不正です')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw runnerError('1Password CLI の env 解決結果の形式が不正です')
  }

  const snapshot: Record<string, string> = {}

  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && !stripped.includes(name)) {
      snapshot[name] = value
    }
  }

  return snapshot
}

function botEnvironmentFromSnapshot(snapshot: Record<string, string>) {
  const env = discordRuntimeEnvironment(process.env)

  for (const [name, value] of Object.entries(snapshot)) {
    env[name] = value
  }

  return env
}

async function runBot(dataDir: string, env: NodeJS.ProcessEnv, secretValues: readonly string[]) {
  const botEntrypoint = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `discord-bot${path.extname(fileURLToPath(import.meta.url))}`,
  )

  return await launchChildAndWait({
    command: process.execPath,
    args: [botEntrypoint, '--data-dir', dataDir],
    env,
    stopWaitMs: launcherStopWaitMs(process.env),
    secretValues,
    label: 'discord-op-runner',
    writeError: (line) => {
      process.stderr.write(`${line}\n`)
    },
  })
}

async function main() {
  try {
    const { dataDir, opPath } = parseRunnerArguments(process.argv.slice(2))
    const { envFilePath, secretKeys } = await validateDataDir(dataDir)
    const token = await readServiceAccountToken(process.env.CREDENTIALS_DIRECTORY)
    const snapshot = await resolveEnvironment(opPath, envFilePath, token)
    const secretValues = secretKeys
      .map((key) => {
        return snapshot[key]
      })
      .filter((value): value is string => {
        return typeof value === 'string' && value !== ''
      })
    const outcome = await runBot(dataDir, botEnvironmentFromSnapshot(snapshot), secretValues)
    process.exitCode = outcome.exitCode
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
