import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { TextDecoder } from 'node:util'

const MAX_STDOUT_BYTES = 128 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_TERMINATION_GRACE_MS = 60 * 1000
const DEFAULT_TERMINATION_GRACE_MS = 250
const ABANDONMENT_AFTER_KILL_MS = 3000
export const VERIFICATION_OUTPUT_BYTES = 8 * 1024
const VERIFICATION_TERMINATION_GRACE_MS = 2000

export type OutputOptions = {
  // strict: 上限超過または不正な UTF-8 で process を止める。tail: 止めずに末尾だけ残す
  mode: 'strict' | 'tail'
  limitBytes: number
}

export type BoundedProcessResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  // aborted: signal の中止で止めた
  terminationReason: 'timeout' | 'output_overflow' | 'invalid_utf8' | 'aborted' | undefined
  terminationConfirmed: boolean
}

export type BoundedCommandOptions = {
  cwd?: string
  env?: Readonly<Record<string, string | undefined>>
  input?: string
  timeoutMs: number
  terminationGraceMs?: number
  stdout?: OutputOptions
  stderr?: OutputOptions
  // 中止されたら timeout と同じ手順（SIGTERM → 猶予 → SIGKILL）で止める。起動前に中止されていれば起動しない
  signal?: AbortSignal
}

// command を起動する関数。runBoundedCommand と同じ形。runner は試行の scope の中で起動する関数を渡す
export type GitCommandRunner = (
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions
) => Promise<BoundedProcessResult>

export type VerificationCommandInput = {
  command: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  timeoutMs: number
  signal?: AbortSignal
  // 検証のコマンドを起動する関数。省略時は runBoundedCommand
  launch?: GitCommandRunner
}

export type VerificationCommandResult = {
  status: 'passed' | 'failed' | 'timeout'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  terminationConfirmed: boolean
  reason?: string
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function makeStrictCapture(limit: number, onFailure: (reason: 'output_overflow' | 'invalid_utf8') => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  let failed = false

  function consume(chunk: Buffer) {
    const remaining = Math.max(0, limit - bytes)
    const accepted = chunk.subarray(0, remaining)
    bytes += accepted.byteLength

    if (accepted.byteLength > 0 && !failed) {
      try {
        text += decoder.decode(accepted, { stream: true })
      } catch {
        failed = true
        onFailure('invalid_utf8')
      }
    }

    if (chunk.byteLength > accepted.byteLength && !failed) {
      failed = true
      onFailure('output_overflow')
    }
  }

  function finish() {
    if (failed) {
      return
    }

    try {
      text += decoder.decode()
    } catch {
      failed = true
      onFailure('invalid_utf8')
    }
  }

  return {
    consume,
    finish,
    get text() {
      return text
    },
    get bytes() {
      return bytes
    }
  }
}

function makeTailCapture(limit: number) {
  let tail = Buffer.alloc(0)
  let bytes = 0

  function consume(chunk: Buffer) {
    bytes += chunk.byteLength
    const combined = Buffer.concat([tail, chunk])
    tail = combined.byteLength > limit ? Buffer.from(combined.subarray(combined.byteLength - limit)) : combined
  }

  function finish() {}

  return {
    consume,
    finish,
    // 末尾で切れた先頭の文字や不正な byte は置換文字にする
    get text() {
      return new TextDecoder('utf-8').decode(tail)
    },
    get bytes() {
      return bytes
    }
  }
}

function makeCapture(options: OutputOptions, onFailure: (reason: 'output_overflow' | 'invalid_utf8') => void) {
  if (!Number.isInteger(options.limitBytes) || options.limitBytes < 0) {
    throw new Error('output limit must be a non-negative integer')
  }

  return options.mode === 'tail' ? makeTailCapture(options.limitBytes) : makeStrictCapture(options.limitBytes, onFailure)
}

export async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions
) {
  // process group で子孫ごと止めるため Windows は対象外
  if (process.platform === 'win32') {
    throw new Error('bounded process groups are not supported on Windows')
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60 * 60 * 1000) {
    throw new Error('subprocess timeout must be between 1000 and 3600000 milliseconds')
  }

  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS

  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 0 || terminationGraceMs > MAX_TERMINATION_GRACE_MS) {
    throw new Error(`termination grace must be between 0 and ${MAX_TERMINATION_GRACE_MS} milliseconds`)
  }

  if (options.signal?.aborted === true) {
    const aborted: BoundedProcessResult = {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      terminationReason: 'aborted',
      terminationConfirmed: true
    }

    return aborted
  }

  let terminationReason: BoundedProcessResult['terminationReason']
  let settled = false
  let forceKillTimer: NodeJS.Timeout | undefined
  let abandonmentTimer: NodeJS.Timeout | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let spawnError: Error | undefined
  let resolveResult: ((result: BoundedProcessResult) => void) | undefined
  const stdoutCapture = makeCapture(options.stdout ?? { mode: 'strict', limitBytes: MAX_STDOUT_BYTES }, (reason) => {
    requestTermination(reason)
  })
  const stderrCapture = makeCapture(options.stderr ?? { mode: 'strict', limitBytes: MAX_STDERR_BYTES }, (reason) => {
    requestTermination(reason)
  })
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    detached: true,
    stdio: 'pipe',
    windowsHide: true
  })

  function killGroup(signal: NodeJS.Signals) {
    if (child.pid === undefined) {
      return
    }

    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        return
      }
    }
  }

  function clearTimers() {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
    }

    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer)
    }

    if (abandonmentTimer !== undefined) {
      clearTimeout(abandonmentTimer)
    }
  }

  function onAbort() {
    requestTermination('aborted')
  }

  function settle(result: BoundedProcessResult) {
    if (settled) {
      return
    }

    settled = true
    clearTimers()
    options.signal?.removeEventListener('abort', onAbort)
    resolveResult?.(result)
  }

  function abandon() {
    if (settled) {
      return
    }

    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    settle({
      exitCode: null,
      signal: null,
      stdout: stdoutCapture.text,
      stderr: stderrCapture.text,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
      terminationReason,
      terminationConfirmed: false
    })
  }

  function requestTermination(reason: 'timeout' | 'output_overflow' | 'invalid_utf8' | 'aborted') {
    if (terminationReason !== undefined || settled) {
      return
    }

    terminationReason = reason
    killGroup('SIGTERM')
    forceKillTimer = setTimeout(() => {
      killGroup('SIGKILL')
      abandonmentTimer = setTimeout(abandon, ABANDONMENT_AFTER_KILL_MS)
    }, terminationGraceMs)
  }

  const promise = new Promise<BoundedProcessResult>((resolve) => {
    resolveResult = resolve
  })

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutCapture.consume(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrCapture.consume(chunk)
  })
  child.once('error', (error) => {
    spawnError = error
  })
  child.once('close', (exitCode, signal) => {
    stdoutCapture.finish()
    stderrCapture.finish()
    settle({
      exitCode,
      signal,
      stdout: stdoutCapture.text,
      stderr: stderrCapture.text,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
      terminationReason,
      terminationConfirmed: true
    })
  })
  child.stdin.once('error', (error) => {
    if (!isErrno(error, 'EPIPE') && terminationReason === undefined) {
      spawnError = error
    }
  })

  timeoutTimer = setTimeout(() => {
    requestTermination('timeout')
  }, options.timeoutMs)
  options.signal?.addEventListener('abort', onAbort, { once: true })

  if (options.input === undefined) {
    child.stdin.end()
  } else {
    child.stdin.end(options.input, 'utf8')
  }

  const result = await promise

  if (spawnError !== undefined) {
    throw Object.assign(new Error(`subprocess could not be launched or its input pipe failed: ${spawnError.message}`), {
      code: 'subprocess_launch_failed'
    })
  }

  return result
}

async function isDirectory(target: string) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      return false
    }

    throw error
  }
}

function notStarted(reason: string) {
  const result: VerificationCommandResult = {
    status: 'failed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    terminationConfirmed: true,
    reason
  }

  return result
}

export async function runVerificationCommand(input: VerificationCommandInput) {
  const executable = input.command[0]

  if (executable === undefined || executable === '') {
    return notStarted('launch_failed')
  }

  if (!await isDirectory(input.cwd)) {
    return notStarted('cwd_missing')
  }

  let result: BoundedProcessResult

  const launch = input.launch ?? runBoundedCommand

  try {
    result = await launch(executable, input.command.slice(1), {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: VERIFICATION_TERMINATION_GRACE_MS,
      stdout: { mode: 'tail', limitBytes: VERIFICATION_OUTPUT_BYTES },
      stderr: { mode: 'tail', limitBytes: VERIFICATION_OUTPUT_BYTES },
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })
  } catch (error) {
    if (isErrno(error, 'subprocess_launch_failed')) {
      return notStarted('launch_failed')
    }

    throw error
  }

  const status = result.terminationReason === 'timeout'
    ? 'timeout'
    : result.exitCode === 0 && result.signal === null && result.terminationConfirmed
      ? 'passed'
      : 'failed'

  const verification: VerificationCommandResult = {
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    terminationConfirmed: result.terminationConfirmed,
    ...(!result.terminationConfirmed
      ? { reason: 'termination_unconfirmed' }
      : result.terminationReason === 'aborted'
        ? { reason: 'aborted' }
        : {})
  }

  return verification
}
