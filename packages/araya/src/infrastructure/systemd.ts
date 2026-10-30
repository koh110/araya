import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runBoundedCommand,
  runVerificationCommand,
  type BoundedCommandOptions,
  type BoundedProcessResult,
  type GitCommandRunner,
  type VerificationCommandInput,
  type VerificationCommandResult
} from './process.ts'
import { collectSecretValues, createRedactor, isSecretEnvName, type CutSide } from './redaction.ts'

// runner の unit file、試行の scope、systemd の操作（systemctl・systemd-run・loginctl の呼び出し）。test では SystemdOps を差し替える

const SCOPE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const GIT_SCOPE_ID_CHARS = 12
const CALL_ID_HASH_CHARS = 12
const SCOPE_STOP_TIMEOUT_MS = 30_000
const COMMAND_OUTPUT_BYTES = 64 * 1024
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
// unit file では % が specifier、$ が変数として展開され、空白・引用符・\ にも意味がある。; は ExecStart の区切り
const UNIT_FILE_UNSAFE_PATTERN = /[\u0000-\u001f\u007f "'\\$%;]/u
const UNIT_ENV_NAMES = ['PATH', 'LANG', 'LANGUAGE', 'TZ']
// systemctl --user stop の、unit が読み込まれていないための失敗（systemd 259 では終了 code 5、stderr は Unit <unit> not loaded.）
const UNIT_NOT_LOADED_PATTERN = /not loaded/iu

export type UnitEnvironment = (readonly [string, string])[]

export type CommandResult = {
  // 起動できなかった、終わったことを確かめられなかったときは null
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type ScopeStopResult = { ok: true } | { ok: false; error: string; remaining: string[] }

export type SystemdOps = {
  // unit file の ExecStopPost に書く systemctl の絶対 path
  readonly systemctlPath: string
  // 試行の scope の中で command を起動する。runBoundedCommand と同じ形
  launchInScope(unit: string, command: string, args: readonly string[], options: BoundedCommandOptions): Promise<BoundedProcessResult>
  // SHIKI の bash の command を、試行の scope の中で動かす command に置き換える
  bashScopeCommand(unit: string, command: string): string
  // args には --user も含める
  systemctl(args: readonly string[], timeoutMs: number): Promise<CommandResult>
  loginctl(args: readonly string[], timeoutMs: number): Promise<CommandResult>
  // pattern に当たる scope を止め、残っていないことを確かめる
  stopScopes(pattern: string): Promise<ScopeStopResult>
}

export type RunnerUnitFileInput = {
  // dataDir の実 path
  dataDir: string
  nodePath: string
  entrypoint: string
  systemctlPath: string
  environment: UnitEnvironment
}

function systemdError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

// runner の unit と試行の scope の名前に使う、dataDir の実 path の SHA-256 の16進表記の先頭12文字
export function dataDirHash(dataDirReal: string) {
  return createHash('sha256').update(dataDirReal, 'utf8').digest('hex').slice(0, 12)
}

export function runnerUnitName(hash: string) {
  return `araya-runner-${hash}.service`
}

// dataDir の試行の scope すべて（taskKey が無いとき）か、1つの試行の scope すべて
export function scopePattern(hash: string, taskKey?: string) {
  return taskKey === undefined ? `araya-${hash}-*.scope` : `araya-${hash}-${taskKey}-*.scope`
}

// SHIKI の bash の scope。<c> は tool の呼び出しの id の SHA-256 の16進表記の先頭12文字
export function bashScopeUnit(hash: string, taskKey: string, callId: string) {
  const callHash = createHash('sha256').update(callId, 'utf8').digest('hex').slice(0, CALL_ID_HASH_CHARS)

  return `araya-${hash}-${taskKey}-${callHash}.scope`
}

// git の scope。<r> は a-z2-7 の 12 文字で、暗号学的乱数で選ぶ
export function gitScopeUnit(hash: string, taskKey: string, randomBytes: (size: number) => Uint8Array = cryptoRandomBytes) {
  let id = ''

  for (const byte of randomBytes(GIT_SCOPE_ID_CHARS)) {
    // 256 は 32 で割り切れるので偏らない
    id += SCOPE_ID_ALPHABET[byte % SCOPE_ID_ALPHABET.length] ?? ''
  }

  return `araya-${hash}-${taskKey}-git-${id}.scope`
}

// commit・push・Draft PR 作成を行う scope。<r> は a-z2-7 の 12 文字の乱数
export function deliveryScopeUnit(hash: string, taskKey: string, randomBytes: (size: number) => Uint8Array = cryptoRandomBytes) {
  let id = ''

  for (const byte of randomBytes(GIT_SCOPE_ID_CHARS)) {
    id += SCOPE_ID_ALPHABET[byte % SCOPE_ID_ALPHABET.length] ?? ''
  }

  return `araya-${hash}-${taskKey}-delivery-${id}.scope`
}

// 検証のコマンドの scope。<n> は verifications.jsonl の中の登録の順番（0 から）
export function verifyScopeUnit(hash: string, taskKey: string, index: number) {
  return `araya-${hash}-${taskKey}-verify-${index}.scope`
}

// ' を '\'' にして単引用符で囲む
export function shellQuote(text: string) {
  return `'${text.replaceAll("'", "'\\''")}'`
}

// ASCII の制御文字、空白、"、'、\、$、%、; を含まない値だけを unit file に書く
export function isUnitFileValueSafe(value: string) {
  return !UNIT_FILE_UNSAFE_PATTERN.test(value)
}

// unit file の Environment= に書く変数。秘密とみなす名前と一覧に無い変数は書かない。
// ARAYA_DATA_DIR・ARAYA_DEV_ROOT・PI_CODING_AGENT_DIR は、呼び出し側が解決した絶対 path を書く
export function selectUnitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  resolved: { dataDir: string; devRoot: string; piAgentDir: string }
) {
  const selected = new Map<string, string>()

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !ENV_NAME_PATTERN.test(name) || isSecretEnvName(name)) {
      continue
    }

    if (UNIT_ENV_NAMES.includes(name) || name.startsWith('LC_') || name.startsWith('ARAYA_')) {
      selected.set(name, value)
    }
  }

  selected.set('ARAYA_DATA_DIR', resolved.dataDir)
  selected.set('ARAYA_DEV_ROOT', resolved.devRoot)

  selected.set('PI_CODING_AGENT_DIR', resolved.piAgentDir)

  const environment: UnitEnvironment = [...selected.entries()].sort(([left], [right]) => {
    return left < right ? -1 : left > right ? 1 : 0
  })

  return environment
}

function assertUnitFileValue(label: string, value: string) {
  if (!isUnitFileValueSafe(value)) {
    throw systemdError(
      'unsupported_path',
      `${label} に unit file に書けない文字（ASCII の制御文字、空白、"、'、\\、$、%、;）があります: ${JSON.stringify(value)}`
    )
  }
}

// unit file の section ごとの property。本物の systemd の test は、これを transient unit の property に使う
export function runnerUnitSections(input: RunnerUnitFileInput) {
  assertUnitFileValue('dataDir', input.dataDir)
  assertUnitFileValue('node の実行ファイル', input.nodePath)
  assertUnitFileValue('runner の entrypoint', input.entrypoint)
  assertUnitFileValue('systemctl', input.systemctlPath)

  for (const [name, value] of input.environment) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw systemdError('unsupported_path', `環境変数の名前を unit file に書けません: ${JSON.stringify(name)}`)
    }

    assertUnitFileValue(`環境変数 ${name}`, value)
  }

  const hash = dataDirHash(input.dataDir)
  const unit: (readonly [string, string])[] = [
    ['Description', `araya runner ${input.dataDir}`],
    ['StartLimitIntervalSec', '0']
  ]
  const service: (readonly [string, string])[] = [
    ['Type', 'exec'],
    ['ExecStart', `${input.nodePath} ${input.entrypoint} --data-dir ${input.dataDir}`],
    ['ExecStopPost', `-${input.systemctlPath} --user stop ${scopePattern(hash)}`],
    ['WorkingDirectory', input.dataDir],
    ...input.environment.map(([name, value]) => {
      const property: readonly [string, string] = ['Environment', `${name}=${value}`]

      return property
    }),
    ['KillMode', 'control-group'],
    ['Restart', 'always'],
    ['RestartSec', '1s'],
    ['RestartSteps', '5'],
    ['RestartMaxDelaySec', '1min'],
    ['TimeoutStopSec', '60'],
    ['StandardInput', 'null'],
    ['StandardOutput', 'null'],
    ['StandardError', 'null']
  ]
  const install: (readonly [string, string])[] = [['WantedBy', 'default.target']]

  return { unit, service, install }
}

// 書けない値があれば unsupported_path を投げる
export function buildRunnerUnitFile(input: RunnerUnitFileInput) {
  const sections = runnerUnitSections(input)
  const lines: string[] = []

  for (const [name, properties] of [['Unit', sections.unit], ['Service', sections.service], ['Install', sections.install]] as const) {
    if (lines.length > 0) {
      lines.push('')
    }

    lines.push(`[${name}]`)

    for (const [key, value] of properties) {
      lines.push(`${key}=${value}`)
    }
  }

  return `${lines.join('\n')}\n`
}

// build 前は .ts、build 後は .js の runner の entrypoint を、この module と同じ package の bin/ から探す
export async function resolveRunnerEntrypoint(moduleUrl: string = import.meta.url) {
  const modulePath = fileURLToPath(moduleUrl)
  const packageRoot = path.dirname(path.dirname(path.dirname(modulePath)))
  const entrypoint = path.join(packageRoot, 'bin', `task-runner${path.extname(modulePath)}`)
  let stat

  try {
    stat = await fs.lstat(entrypoint)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      throw systemdError('runner_entrypoint_unavailable', `runner の entrypoint がありません: ${entrypoint}`)
    }

    throw error
  }

  if (!stat.isFile()) {
    throw systemdError('runner_entrypoint_unavailable', `runner の entrypoint が通常の file ではありません: ${entrypoint}`)
  }

  return entrypoint
}

// <XDG_CONFIG_HOME>/systemd/user/<unit>。XDG_CONFIG_HOME が絶対 path でなければ <home>/.config
export function unitFilePath(env: Readonly<Record<string, string | undefined>>, homeDir: string, unit: string) {
  const configHome = env.XDG_CONFIG_HOME
  const base = configHome !== undefined && path.isAbsolute(configHome) ? configHome : path.join(homeDir, '.config')

  return path.join(base, 'systemd', 'user', unit)
}

export function commandSucceeded(result: CommandResult) {
  return result.exitCode === 0 && !result.timedOut
}

async function findExecutable(name: string, searchPath: string | undefined) {
  for (const directory of (searchPath ?? '').split(':')) {
    if (directory === '' || !path.isAbsolute(directory)) {
      continue
    }

    const candidate = path.join(directory, name)

    try {
      await fs.access(candidate, fsConstants.X_OK)

      if ((await fs.stat(candidate)).isFile()) {
        return candidate
      }
    } catch {
      continue
    }
  }

  return null
}

// systemctl などを打ち切り付きで実行する。起動できなかったときは exitCode を null にし、理由を stderr に入れる。
// 出力は末尾だけを残すので、上限を超えたときは先頭の境界に接する秘密の一部を置き換える（log と CLI の stderr に出るため）
async function runCommand(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  redactTruncated: (text: string, cut: CutSide) => string
) {
  try {
    const result = await runBoundedCommand(executable, args, {
      env,
      timeoutMs,
      stdout: { mode: 'tail', limitBytes: COMMAND_OUTPUT_BYTES },
      stderr: { mode: 'tail', limitBytes: COMMAND_OUTPUT_BYTES }
    })
    const commandResult: CommandResult = {
      exitCode: result.terminationConfirmed && result.terminationReason === undefined ? result.exitCode : null,
      stdout: result.stdoutBytes > COMMAND_OUTPUT_BYTES ? redactTruncated(result.stdout, 'start') : result.stdout,
      stderr: result.stderrBytes > COMMAND_OUTPUT_BYTES ? redactTruncated(result.stderr, 'start') : result.stderr,
      timedOut: result.terminationReason === 'timeout'
    }

    return commandResult
  } catch (error) {
    const commandResult: CommandResult = {
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false
    }

    return commandResult
  }
}

function describeCommandFailure(name: string, result: CommandResult) {
  const status = result.timedOut ? 'timed out' : `exited with ${result.exitCode ?? 'no exit code'}`
  const stderr = result.stderr.trim()

  return `${name} ${status}${stderr === '' ? '' : `: ${stderr}`}`
}

// 本物の systemd の操作。systemd-run・systemctl・bash（と loginctl）は、env の PATH から探した絶対 path を使う
export async function createSystemdOps(env: Readonly<Record<string, string | undefined>>) {
  const [systemdRun, systemctlPath, loginctlPath, bashPath] = await Promise.all([
    findExecutable('systemd-run', env.PATH),
    findExecutable('systemctl', env.PATH),
    findExecutable('loginctl', env.PATH),
    findExecutable('bash', env.PATH)
  ])

  if (systemdRun === null || systemctlPath === null || bashPath === null) {
    const missing = [
      ...(systemdRun === null ? ['systemd-run'] : []),
      ...(systemctlPath === null ? ['systemctl'] : []),
      ...(bashPath === null ? ['bash'] : [])
    ]

    throw systemdError('systemd_unavailable', `PATH に ${missing.join('・')} がありません`)
  }

  const systemctlExecutable = systemctlPath
  // 置き換えた回数は使わない
  const redactor = createRedactor(collectSecretValues(env))

  function scopeArgs(unit: string) {
    return [
      '--user', '--scope', '--quiet', '--collect', '--expand-environment=no',
      `--unit=${unit}`, '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=10s', '--'
    ]
  }

  function systemctl(args: readonly string[], timeoutMs: number) {
    return runCommand(systemctlExecutable, args, env, timeoutMs, redactor.redactTruncated)
  }

  const ops: SystemdOps = {
    systemctlPath,
    launchInScope(unit, command, args, options) {
      return runBoundedCommand(systemdRun, [...scopeArgs(unit), command, ...args], options)
    },
    bashScopeCommand(unit, command) {
      return ['exec', ...[systemdRun, ...scopeArgs(unit), bashPath, '-c', command].map(shellQuote)].join(' ')
    },
    systemctl,
    async loginctl(args, timeoutMs) {
      if (loginctlPath === null) {
        const result: CommandResult = { exitCode: null, stdout: '', stderr: 'loginctl was not found in PATH', timedOut: false }

        return result
      }

      return runCommand(loginctlPath, args, env, timeoutMs, redactor.redactTruncated)
    },
    async stopScopes(pattern) {
      const stopped = await systemctl(['--user', 'stop', pattern], SCOPE_STOP_TIMEOUT_MS)
      // glob に当たる unit が無い stop は成功するが、名前を1つだけ指定した stop（検証の scope）は、その scope が
      // もう無い（--collect で消えた）と失敗する。止めるものが無いだけなので、この失敗は無視し、残りは list-units で確かめる
      const notLoaded = !stopped.timedOut && stopped.exitCode !== null && UNIT_NOT_LOADED_PATTERN.test(stopped.stderr)

      if (!commandSucceeded(stopped) && !notLoaded) {
        const result: ScopeStopResult = { ok: false, error: describeCommandFailure('systemctl --user stop', stopped), remaining: [] }

        return result
      }

      const listed = await systemctl(['--user', 'list-units', '--all', '--plain', '--no-legend', pattern], SCOPE_STOP_TIMEOUT_MS)

      if (!commandSucceeded(listed)) {
        const result: ScopeStopResult = { ok: false, error: describeCommandFailure('systemctl --user list-units', listed), remaining: [] }

        return result
      }

      const remaining = listed.stdout.split('\n').map((line) => {
        return line.trim().split(/\s+/u)[0] ?? ''
      }).filter((unit) => {
        return unit !== ''
      })

      if (remaining.length > 0) {
        const result: ScopeStopResult = { ok: false, error: `scopes remain after stop: ${remaining.join(' ')}`, remaining }

        return result
      }

      const result: ScopeStopResult = { ok: true }

      return result
    }
  }

  return ops
}

// git を試行の scope の中で起動する関数。unitFor は起動のたびに scope の名前を返す
export function createScopedRunner(ops: Pick<SystemdOps, 'launchInScope'>, unitFor: () => string) {
  const run: GitCommandRunner = (command, args, options) => {
    return ops.launchInScope(unitFor(), command, args, options)
  }

  return run
}

// 検証のコマンドを verify-<n> の scope の中で実行し、終わったらその scope を止める。
// 止められなければ terminationConfirmed を false（reason は termination_unconfirmed）にする
export function createScopedVerificationRunner(ops: Pick<SystemdOps, 'launchInScope' | 'stopScopes'>, unitFor: (index: number) => string) {
  return async (input: VerificationCommandInput & { index: number }) => {
    const unit = unitFor(input.index)
    const result = await runVerificationCommand({ ...input, launch: createScopedRunner(ops, () => unit) })
    const stopped = await ops.stopScopes(unit)

    if (stopped.ok) {
      return result
    }

    const unconfirmed: VerificationCommandResult = { ...result, terminationConfirmed: false, reason: 'termination_unconfirmed' }

    return unconfirmed
  }
}
