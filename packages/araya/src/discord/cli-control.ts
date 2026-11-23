// CLI から入れた control request を bot process 側で拾う loop（Issue #33 の control plane を CLI にも開く）
// request を書くのは人間の shell だけ（src/cli/control-commands.ts）。ここではDiscord gateway を介さずに
// chat handler の runControl を呼ぶので、slash command と完全に同じ operation・同じ kernel を通る
import {
  claimControlRequest,
  finishControlRequest,
  pruneControlFiles,
  readPendingControlRequests,
  type ControlCommandName,
} from '../infrastructure/control-bus.ts'

export const CLI_CONTROL_POLL_MS = 1000
const CLI_CONTROL_MAX_PER_TICK = 4

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type CliControlLoopDependencies = {
  dataDir: string
  nowMs(): number
  log(entry: Record<string, unknown>): void
  // bot process 内の control 実行（chat handler の runControl を渡す）。throw すれば result 側へ error として書く
  run(command: ControlCommandName, requestId: string): Promise<string>
  // result file に書く文字列の redaction（chat handler 側でも伏字するが、error 文は bot の code 側から来る）
  redact?(text: string): string
  pollMs?: number
}

export type CliControlLoop = {
  start(): void
  stop(): void
  // test 用に 1 周させる
  drainOnce(): Promise<number>
}

export function createCliControlLoop(deps: CliControlLoopDependencies): CliControlLoop {
  const pollMs = deps.pollMs ?? CLI_CONTROL_POLL_MS
  const redact = deps.redact ?? ((text: string) => {
    return text
  })
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false

  async function drainOnce(): Promise<number> {
    if (ticking) {
      return 0
    }

    ticking = true
    let handled = 0

    try {
      await pruneControlFiles(deps.dataDir, deps.nowMs())
      const pending = await readPendingControlRequests(deps.dataDir)

      for (const request of pending.slice(0, CLI_CONTROL_MAX_PER_TICK)) {
        const claimed = await claimControlRequest(deps.dataDir, request.id)

        if (claimed === null) {
          continue
        }

        const startedAtMs = deps.nowMs()

        try {
          const output = await deps.run(claimed.command, claimed.id)
          await finishControlRequest(deps.dataDir, claimed.id, {
            command: claimed.command,
            ok: true,
            output: redact(output).slice(0, 20_000),
            finishedAt: new Date(deps.nowMs()).toISOString(),
          })
          deps.log({ type: 'discord_control_cli', command: claimed.command, ms: deps.nowMs() - startedAtMs })
        } catch (error) {
          await finishControlRequest(deps.dataDir, claimed.id, {
            command: claimed.command,
            ok: false,
            output: '',
            finishedAt: new Date(deps.nowMs()).toISOString(),
            error: redact(errorMessage(error)).slice(0, 500),
          })
          deps.log({ type: 'discord_control_cli_failed', command: claimed.command, message: errorMessage(error).slice(0, 500) })
        }

        handled += 1
      }
    } finally {
      ticking = false
    }

    return handled
  }

  return {
    start() {
      if (timer !== undefined) {
        return
      }

      timer = setInterval(() => {
        void drainOnce().catch(() => {
          // poll の失敗は次の周に任せる（process を止めない）
        })
      }, pollMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
    drainOnce,
  }
}
