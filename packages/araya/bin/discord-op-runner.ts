#!/usr/bin/env node
// systemd LoadCredential から1Passwordを認証し、Discord botへ解決済み環境変数だけを渡す。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
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
  stderrLineWriter,
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
const OP_RESOLVE_TIMEOUT_MS = 30_000
const MAX_RESOLVER_SOCKET_BYTES = 1024 * 1024
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

// op run は stdout/stderr に出た参照値を redact するため、解決済み値は private socket で返す。
function envResolverScript() {
  return [
    `const keys = ${JSON.stringify(DISCORD_CONFIG_KEYS)};`,
    'const snapshot = {};',
    'for (const name of keys) {',
    '  const value = process.env[name];',
    '  if (typeof value === "string") { snapshot[name] = value }',
    '}',
    'import("node:net").then(({ createConnection }) => {',
    '  const socket = createConnection(process.argv[1] ?? "");',
    '  socket.once("connect", () => socket.end(JSON.stringify(snapshot)));',
    '  socket.once("error", () => { process.exitCode = 1 });',
    '}).catch(() => { process.exitCode = 1 });',
  ].join(' ')
}

type ResolverRelayResult = { payload: string } | { error: string }

async function createResolverRelay() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-op-env-'))
  const socketPath = path.join(directory, 's')
  const sockets = new Set<net.Socket>()
  let acceptedConnection = false
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let resolveResult!: (result: ResolverRelayResult) => void
  const result = new Promise<ResolverRelayResult>((resolve) => {
    resolveResult = resolve
  })

  function settle(value: ResolverRelayResult) {
    if (settled) {
      return
    }

    settled = true

    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    resolveResult(value)
  }

  const server = net.createServer((socket) => {
    if (acceptedConnection || settled) {
      socket.destroy()

      return
    }

    acceptedConnection = true
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
    })

    const chunks: Buffer[] = []
    let totalBytes = 0

    socket.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength

      if (totalBytes > MAX_RESOLVER_SOCKET_BYTES) {
        settle({ error: 'payload_too_large' })
        socket.destroy()

        return
      }

      chunks.push(chunk)
    })
    socket.once('end', () => {
      try {
        settle({
          payload: new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks, totalBytes),
          ),
        })
        socket.end()
      } catch {
        settle({ error: 'invalid_utf8' })
        socket.destroy()
      }
    })
    socket.once('error', () => {
      settle({ error: 'socket_error' })
    })
  })

  async function close() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }

    settle({ error: 'closed' })

    for (const socket of sockets) {
      socket.destroy()
    }

    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }

    await fs.rm(directory, { recursive: true, force: true })
  }

  try {
    await fs.chmod(directory, 0o700)
    const directoryStat = await fs.lstat(directory)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null

    if (
      !directoryStat.isDirectory() ||
      uid === null ||
      directoryStat.uid !== uid ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw runnerError('1Password env relay directory の形式または権限が不正です')
    }

    await new Promise<void>((resolve, reject) => {
      function onListening() {
        server.off('error', onListenError)
        resolve()
      }

      function onListenError(error: Error) {
        server.off('listening', onListening)
        reject(error)
      }

      server.once('listening', onListening)
      server.once('error', onListenError)
      server.listen(socketPath)
    })

    server.on('error', () => {
      settle({ error: 'server_error' })
    })

    if (!(await fs.lstat(socketPath)).isSocket()) {
      throw runnerError('1Password env relay socket の形式が不正です')
    }

    await fs.chmod(socketPath, 0o600)
    timer = setTimeout(() => {
      settle({ error: 'timeout' })
    }, OP_RESOLVE_TIMEOUT_MS)
  } catch {
    await close()
    throw runnerError('1Password env 解決用の private socket を作成できません')
  }

  return {
    socketPath,
    result,
    close,
    cancel() {
      settle({ error: 'interrupted' })
    },
  }
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
  let relay: Awaited<ReturnType<typeof createResolverRelay>> | undefined
  let activeChild: ChildProcess | undefined
  let interruptedSignal: 'SIGINT' | 'SIGTERM' | null = null
  let signalKillTimer: NodeJS.Timeout | undefined
  let resolvedSnapshot: Record<string, string> | undefined

  function clearSignalKillTimer() {
    if (signalKillTimer !== undefined) {
      clearTimeout(signalKillTimer)
      signalKillTimer = undefined
    }
  }

  function handleSignal(signal: 'SIGINT' | 'SIGTERM') {
    if (interruptedSignal !== null) {
      return
    }

    interruptedSignal = signal
    relay?.cancel()

    if (activeChild !== undefined) {
      activeChild.kill(signal)
      signalKillTimer = setTimeout(() => {
        activeChild?.kill('SIGKILL')
      }, 1_000)
      signalKillTimer.unref?.()
    }
  }

  function onSigterm() {
    handleSignal('SIGTERM')
  }

  function onSigint() {
    handleSignal('SIGINT')
  }

  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  try {
    relay = await createResolverRelay()
    const resolverRelay = relay

    if (interruptedSignal !== null) {
      throw runnerError(`1Password CLI の env 解決は ${interruptedSignal} で中断されました`)
    }

    const stripped = strippedEnvironmentNames()
    const args = ['run', '--env-file', envFilePath, '--', SYSTEM_ENV_EXECUTABLE]

    for (const name of stripped) {
      args.push('-u', name)
    }

    args.push(process.execPath, '-e', envResolverScript(), resolverRelay.socketPath)

    const outcome = await new Promise<{
      code: number | null
      signal: string | null
      stderr: string
    }>((resolve) => {
      let child: ChildProcess

      try {
        child = spawn(opPath, args, {
          env: opBaseEnvironment(token),
          shell: false,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch {
        resolve({ code: 127, signal: null, stderr: '' })

        return
      }

      activeChild = child

      if (interruptedSignal !== null) {
        child.kill(interruptedSignal)
      }

      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) {
          return
        }

        settled = true
        child.kill('SIGKILL')
        resolve({ code: null, signal: 'timeout', stderr })
      }, OP_RESOLVE_TIMEOUT_MS)

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < MAX_OP_STDERR_CHARS) {
          stderr += chunk
        }
      })
      child.once('error', () => {
        clearTimeout(timer)
        clearSignalKillTimer()

        if (activeChild === child) {
          activeChild = undefined
        }

        if (!settled) {
          settled = true
          resolve({ code: 127, signal: null, stderr })
        }
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        clearSignalKillTimer()

        if (activeChild === child) {
          activeChild = undefined
        }

        if (!settled) {
          settled = true
          resolve({ code, signal, stderr })
        }
      })
    })

    if (interruptedSignal !== null) {
      throw runnerError(`1Password CLI の env 解決は ${interruptedSignal} で中断されました`)
    }

    if (outcome.signal === 'timeout') {
      throw runnerError(
        `1Password CLI が ${OP_RESOLVE_TIMEOUT_MS}ms 内に .env を解決できませんでした`,
      )
    }

    if (outcome.code !== 0) {
      throw runnerError(
        `1Password CLI で .env を解決できませんでした（status=${outcome.code ?? 'signal'}・${redactSecretValues(outcome.stderr, [token]).slice(0, MAX_OP_STDERR_CHARS)}）`,
      )
    }

    const relayOutcome = await resolverRelay.result

    if (interruptedSignal !== null) {
      throw runnerError(`1Password CLI の env 解決は ${interruptedSignal} で中断されました`)
    }

    if ('error' in relayOutcome) {
      throw runnerError('1Password CLI の env 解決結果を private socket から取得できません')
    }

    let parsed

    try {
      parsed = JSON.parse(relayOutcome.payload)
    } catch {
      throw runnerError('1Password CLI の env 解決結果の形式が不正です')
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw runnerError('1Password CLI の env 解決結果の形式が不正です')
    }

    const snapshot: Record<string, string> = {}
    const resolvedValues: Record<string, unknown> = parsed

    for (const name of DISCORD_CONFIG_KEYS) {
      const value = resolvedValues[name]

      if (typeof value !== 'string' || value === '') {
        throw runnerError(`1Password CLI の env 解決結果に ${name} がありません`)
      }

      snapshot[name] = value
    }

    if (interruptedSignal !== null) {
      throw runnerError(`1Password CLI の env 解決は ${interruptedSignal} で中断されました`)
    }

    resolvedSnapshot = snapshot
  } finally {
    try {
      if (relay !== undefined) {
        await relay.close()
      }
    } finally {
      clearSignalKillTimer()
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
    }
  }

  if (interruptedSignal !== null) {
    throw runnerError(`1Password CLI の env 解決は ${interruptedSignal} で中断されました`)
  }

  if (resolvedSnapshot === undefined) {
    throw runnerError('1Password CLI の env 解決結果がありません')
  }

  return resolvedSnapshot
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
    writeError: stderrLineWriter(),
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
