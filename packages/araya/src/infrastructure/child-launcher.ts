// systemd unit の main process（runner）が Discord bot の bounded shutdown を待つための共通 helper。
// runner が bot より先に死ぬと KillMode=control-group の systemd は残った process を SIGKILL して
// drain を途中で潰す。runner は bot の終了まで生き、それでも越えたら自発的に SIGKILL して終了する。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export const DEFAULT_LAUNCHER_STOP_WAIT_MS = 28_000

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
    let killTimer: NodeJS.Timeout | undefined

    function finish(outcome: ChildStopOutcome) {
      if (settled) {
        return
      }

      settled = true

      if (killTimer !== undefined) {
        clearTimeout(killTimer)
      }

      process.off('SIGTERM', forwardSignal)
      process.off('SIGINT', forwardSignal)
      resolve(outcome)
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

    process.once('SIGTERM', () => {
      forwardSignal('SIGTERM')
    })
    process.once('SIGINT', () => {
      forwardSignal('SIGINT')
    })
    child.once('error', () => {
      finish({ exitCode: 127, signal: null, killedByLauncher })
    })
    child.once('exit', (code, signal) => {
      if (killedByLauncher) {
        finish({ exitCode: 1, signal: signal ?? null, killedByLauncher })

        return
      }

      if (signal !== null) {
        // bot が signal で死んだ（SIGKILL 等）のは異常。systemd に失敗として伝える。
        finish({ exitCode: code ?? 1, signal, killedByLauncher })

        return
      }

      finish({ exitCode: code ?? 1, signal: null, killedByLauncher })
    })
  })
}
