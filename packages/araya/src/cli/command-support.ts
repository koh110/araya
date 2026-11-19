import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { type Redactor } from '../infrastructure/redaction.ts'
import { commandSucceeded, type CommandResult, type SystemdOps } from '../infrastructure/systemd.ts'

// araya discord command 共通の helper と依存型

export const SYSTEMCTL_TIMEOUT_MS = 30_000
const MAX_COMMAND_STDERR_CHARS = 500

export type CliCommandDependencies = {
  platform: NodeJS.Platform
  // 秘密とみなす値を集める環境変数
  env: Readonly<Record<string, string | undefined>>
  stdout(text: string): void
  stderr(text: string): void
  nowMs(): number
  createSystemdOps(env: Readonly<Record<string, string | undefined>>): Promise<SystemdOps>
  // unit file の ExecStart に書く node の実行ファイル
  nodePath: string
  // XDG_CONFIG_HOME が絶対 path でないときの ~/.config の ~
  homeDir: string
  uid: number
  sleep(ms: number): Promise<void>
}

export type CliCommandConfig = {
  dataDir: string
  devRoot: string
  piAgentDir: string
}

// CLI command 共通の誤り（code を付けて throw する）
export function commandError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

export function assertSupportedPlatform(platform: NodeJS.Platform) {
  if (platform !== 'linux') {
    throw commandError(
      'unsupported_platform',
      `araya discord は Linux でだけ使えます（${platform}）`,
    )
  }
}

export function parseCommandArgs<T>(parse: () => T) {
  try {
    return parse()
  } catch (error) {
    throw commandError('invalid_arguments', error instanceof Error ? error.message : String(error))
  }
}

// systemctl などの失敗。stderr は秘密を置き換えた先頭 500 文字
export function systemdCommandError(
  name: string,
  args: readonly string[],
  result: CommandResult,
  redactor: Redactor,
) {
  const status = result.timedOut ? '時間切れで打ち切り' : `終了 code ${result.exitCode ?? 'なし'}`
  const stderr = redactor.redact(result.stderr.trim()).slice(0, MAX_COMMAND_STDERR_CHARS)

  return commandError(
    `${name}_failed`,
    `${name} ${args.join(' ')} が失敗しました（${status}）${stderr === '' ? '' : `: ${stderr}`}`,
  )
}

export async function runSystemctl(
  ops: SystemdOps,
  args: readonly string[],
  timeoutMs: number,
  redactor: Redactor,
) {
  const result = await ops.systemctl(args, timeoutMs)

  if (!commandSucceeded(result)) {
    throw systemdCommandError('systemctl', args, result, redactor)
  }

  return result
}

export async function realpathOrResolved(target: string) {
  try {
    return await fs.realpath(target)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return path.resolve(target)
    }

    throw error
  }
}

// 同じ directory の一時 file（mode 0600）に書いてから rename する。directory が無ければ mode 0700 で作る
export async function writeUnitFile(unitPath: string, content: string) {
  const directory = path.dirname(unitPath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(
    directory,
    `.${path.basename(unitPath)}.${randomBytes(6).toString('hex')}.tmp`,
  )

  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporaryPath, unitPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

export async function readLinger(ops: SystemdOps, uid: number) {
  const result = await ops.loginctl(
    ['show-user', String(uid), '--property=Linger', '--value'],
    SYSTEMCTL_TIMEOUT_MS,
  )
  const value = commandSucceeded(result) ? result.stdout.trim() : ''

  return value === 'yes' ? true : value === 'no' ? false : null
}
