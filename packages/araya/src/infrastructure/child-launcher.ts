// systemd unit の main process（runner）が Discord bot の bounded shutdown を待つための共通 helper。
// runner が bot より先に死ぬと KillMode=control-group の systemd は残った process を SIGKILL して
// drain を途中で潰す。runner は bot の終了まで生き、それでも越えたら自発的に SIGKILL して終了する。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export const DEFAULT_LAUNCHER_STOP_WAIT_MS = 28_000
// child の exit 後に stderr が閉じるのを待つ上限（launcher log に最後の trace を残すため）
export const MAX_CHILD_STDIO_DRAIN_MS = 1_000

export type ChildStopOutcome = {
  exitCode: number
  signal: string | null
  killedByLauncher: boolean
}

export function launcherStopWaitMs(sourceEnv: Readonly<Record<string, string | undefined>>) {
  const raw = sourceEnv['ARAYA_LAUNCHER_STOP_WAIT_MS']

  if (raw === undefined || raw === '') {
    return DEFAULT_LAUNCHER_STOP_WAIT_MS
  }

  const parsed = Number(raw)

  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 120_000) {
    return DEFAULT_LAUNCHER_STOP_WAIT_MS
  }

  return Math.round(parsed)
}

// runner の log には 1 行単位で書く。newline を決める場所を 1 箇所に寄せる（runner 側で
// `${line}\\n` のように二重にエスケープすると log が 1 行に連結して読めなくなる）
export function stderrLineWriter(sink: (chunk: string) => void = (chunk) => {
  process.stderr.write(chunk)
}) {
  return (line: string): void => {
    sink(`${line}\n`)
  }
}

// 秘密値は crash trace に現れうるので、bot の stderr は runner の log に写す前に置換する。
export function redactSecretValues(text: string, secretValues: readonly string[]) {
  let redacted = text

  for (const value of secretValues) {
    if (value.length < 8) {
      continue
    }

    redacted = redacted.split(value).join('[redacted]')
  }

  return redacted
}

function pipeRedactedLines(
  stream: NodeJS.ReadableStream,
  secretValues: readonly string[],
  write: (line: string) => void,
) {
  let buffer = ''

  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk

    while (true) {
      const index = buffer.indexOf('\n')

      if (index === -1) {
        // 行が未完成のあいだ秘密値が chunk で切れて置換をすり抜けるので、改行まで待つ
        if (buffer.length > 8_000) {
          write(redactSecretValues(`${buffer.slice(0, 8_000)}…（長すぎる行）`, secretValues))
          buffer = buffer.slice(8_000)
          continue
        }

        return
      }

      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      write(redactSecretValues(line, secretValues))
    }
  })
  stream.on('end', () => {
    if (buffer !== '') {
      write(redactSecretValues(buffer, secretValues))
      buffer = ''
    }
  })
}

export async function launchChildAndWait(options: {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stopWaitMs: number
  secretValues: readonly string[]
  label: string
  writeError: (line: string) => void
  spawnChild?: (options: {
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
  }) => ChildProcess
}): Promise<ChildStopOutcome> {
  const spawnChild = options.spawnChild ?? ((input) => {
    return spawn(input.command, input.args, {
      env: input.env,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  })
  let child: ChildProcess

  try {
    child = spawnChild({
      command: options.command,
      args: options.args,
      env: options.env,
    })
  } catch {
    options.writeError(`${options.label}: child を起動できません`)

    return Promise.resolve({ exitCode: 127, signal: null, killedByLauncher: false })
  }

  if (child.stderr !== null) {
    pipeRedactedLines(child.stderr, options.secretValues, (line) => {
      options.writeError(`${options.label}: ${line}`)
    })
  }

  return await new Promise<ChildStopOutcome>((resolve) => {
    let settled = false
    let forwarded = false
    let killedByLauncher = false
    let exited = false
    let closed = false
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let killTimer: NodeJS.Timeout | undefined
    let stdioDrainTimer: NodeJS.Timeout | undefined

    function finish(outcome: ChildStopOutcome) {
      if (settled) {
        return
      }

      settled = true

      if (killTimer !== undefined) {
        clearTimeout(killTimer)
      }

      if (stdioDrainTimer !== undefined) {
        clearTimeout(stdioDrainTimer)
      }

      process.off('SIGTERM', onTerminate)
      process.off('SIGINT', onInterrupt)
      resolve(outcome)
    }
    function outcomeFromExit(): ChildStopOutcome {
      const code = exitCode

      if (killedByLauncher) {
        return { exitCode: 1, signal: exitSignal, killedByLauncher }
      }

      if (code !== null) {
        return { exitCode: code, signal: exitSignal, killedByLauncher }
      }

      // signal で死んだ（SIGKILL 等）のは異常。systemd に失敗として伝える
      return { exitCode: 1, signal: exitSignal, killedByLauncher }
    }
    // child の stderr 最後の 1 行（crash trace など）が launcher log から落ちないよう、stdio が閉じるまで待つ。
    // 閉じないまま待ち続けると unit の stop job を延ばすので上限を置く
    function tryFinishAfterExit() {
      if (!exited || !closed) {
        return
      }

      finish(outcomeFromExit())
    }
    function forwardSignal(signal: 'SIGTERM' | 'SIGINT') {
      // 2 回目以降の signal は無視する（SIGKILL 前に bot 自身の budget を見守る）
      if (forwarded) {
        return
      }

      forwarded = true
      child.kill(signal)
      killTimer = setTimeout(() => {
        killedByLauncher = true
        options.writeError(
          `${options.label}: shutdown wait ${options.stopWaitMs}ms を超過、child を SIGKILL します`,
        )
        child.kill('SIGKILL')
      }, options.stopWaitMs)
      killTimer.unref?.()
    }

    function onTerminate() {
      forwardSignal('SIGTERM')
    }
    function onInterrupt() {
      forwardSignal('SIGINT')
    }

    // runner 自身が 2 回目以降の signal を default 動作で殺されないよう on() で張り続ける
    process.on('SIGTERM', onTerminate)
    process.on('SIGINT', onInterrupt)
    child.once('error', () => {
      exited = true
      closed = true
      exitCode = 127
      exitSignal = null
      finish({ exitCode: 127, signal: null, killedByLauncher })
    })
    child.once('exit', (code, signal) => {
      exited = true
      exitCode = code ?? null
      exitSignal = signal ?? null
      // #36 の実測で runner の exit code だけ見て bot の死因が分からなかった。終了理由を log に残す
      options.writeError(
        `${options.label}: child 終了（code=${String(exitCode)}, signal=${exitSignal ?? 'none'}${killedByLauncher ? ', launcher が SIGKILL' : ''}）`,
      )
      stdioDrainTimer = setTimeout(() => {
        closed = true
        tryFinishAfterExit()
      }, MAX_CHILD_STDIO_DRAIN_MS)
      stdioDrainTimer.unref?.()
      tryFinishAfterExit()
    })
    child.once('close', (code, signal) => {
      closed = true

      if (exitCode === null) {
        exitCode = code ?? null
        exitSignal = signal ?? null
      }

      if (exited) {
        tryFinishAfterExit()
      }
    })
  })
}
