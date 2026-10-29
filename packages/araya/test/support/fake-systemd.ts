import { appendFileSync } from 'node:fs'
import fs from 'node:fs/promises'

import { runBoundedCommand } from '../../src/infrastructure/process.ts'
import { shellQuote, type CommandResult, type ScopeStopResult, type SystemdOps } from '../../src/infrastructure/systemd.ts'

// 偽物の systemd。scope を作らずに command を直接実行し、process の環境変数 ARAYA_FAKE_SCOPE に scope の名前の印を付ける。
// 印は setsid した子孫にも引き継がれるので、scope と同じく切り離した process も止められる。
// 印の名前には test の dataDir の hash が入るので、ほかの test の process を止めない

const SCOPE_ENV = 'ARAYA_FAKE_SCOPE'
const ENV_PATH = '/usr/bin/env'
const STOP_WAIT_MS = 5000

export type FakeRecord =
  | { type: 'launch'; unit: string; argv: string[] }
  | { type: 'stop'; pattern: string; killed: number[] }
  | { type: 'stop_failed'; pattern: string; remaining: number[] }
  | { type: 'systemctl'; args: string[]; timeoutMs: number }
  | { type: 'loginctl'; args: string[]; timeoutMs: number }

export type FakeSystemdOptions = {
  // true を返した pattern は止めずに失敗にする。test の途中で切り替えられるように関数で受ける
  failStop?: (pattern: string) => boolean
  // stopScopes の始め（failStop の前）に呼び、終わるまで待つ。scope の停止の最中に起きることを test で作るため
  beforeStop?: (pattern: string) => void | Promise<void>
  // systemctl と loginctl の応答。省略時は終了 code 0 で出力なし
  systemctl?: (args: readonly string[]) => CommandResult | Promise<CommandResult>
  loginctl?: (args: readonly string[]) => CommandResult | Promise<CommandResult>
  // process をまたぐ test で、記録を JSONL で追記する file
  recordFile?: string
  systemctlPath?: string
  bashPath?: string
}

export function commandResult(stdout = '', exitCode: number | null = 0, stderr = '') {
  const result: CommandResult = { exitCode, stdout, stderr, timedOut: false }

  return result
}

// glob の * だけを任意の文字列として扱う
function globToRegExp(pattern: string) {
  const source = pattern.split('*').map((part) => {
    return part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
  }).join('.*')

  return new RegExp(`^${source}$`, 'u')
}

async function readScopeMarker(pid: number) {
  try {
    const environ = await fs.readFile(`/proc/${pid}/environ`, 'utf8')
    const entry = environ.split('\0').find((item) => {
      return item.startsWith(`${SCOPE_ENV}=`)
    })

    return entry === undefined ? null : entry.slice(SCOPE_ENV.length + 1)
  } catch {
    return null
  }
}

// zombie と消えた process は止まったとみなす
async function isAlive(pid: number) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)

    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

// 印の名前が pattern に当たる process の pid
export async function findMarkedProcesses(pattern: string) {
  const matcher = globToRegExp(pattern)
  const pids: number[] = []

  for (const name of await fs.readdir('/proc')) {
    if (!/^[0-9]+$/u.test(name)) {
      continue
    }

    const pid = Number(name)
    const marker = await readScopeMarker(pid)

    if (marker !== null && matcher.test(marker) && await isAlive(pid)) {
      pids.push(pid)
    }
  }

  return pids
}

export function createFakeSystemd(options: FakeSystemdOptions = {}) {
  const records: FakeRecord[] = []
  const bashPath = options.bashPath ?? '/bin/bash'

  function record(entry: FakeRecord) {
    records.push(entry)

    if (options.recordFile !== undefined) {
      appendFileSync(options.recordFile, `${JSON.stringify(entry)}\n`, 'utf8')
    }
  }

  async function stopScopes(pattern: string) {
    await options.beforeStop?.(pattern)

    if (options.failStop?.(pattern) === true) {
      const remaining = await findMarkedProcesses(pattern)
      record({ type: 'stop_failed', pattern, remaining })
      const result: ScopeStopResult = { ok: false, error: 'fake systemd: stop failed', remaining: remaining.map(String) }

      return result
    }

    const killed = await findMarkedProcesses(pattern)

    for (const pid of killed) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        continue
      }
    }

    const deadline = Date.now() + STOP_WAIT_MS
    let remaining = killed

    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      const alive: number[] = []

      for (const pid of remaining) {
        if (await isAlive(pid)) {
          alive.push(pid)
        }
      }

      remaining = alive
    }

    if (remaining.length > 0) {
      record({ type: 'stop_failed', pattern, remaining })
      const result: ScopeStopResult = { ok: false, error: 'fake systemd: processes remain', remaining: remaining.map(String) }

      return result
    }

    record({ type: 'stop', pattern, killed })
    const result: ScopeStopResult = { ok: true }

    return result
  }

  const ops: SystemdOps = {
    systemctlPath: options.systemctlPath ?? '/usr/bin/systemctl',
    launchInScope(unit, command, args, commandOptions) {
      record({ type: 'launch', unit, argv: [command, ...args] })

      return runBoundedCommand(ENV_PATH, [`${SCOPE_ENV}=${unit}`, command, ...args], commandOptions)
    },
    bashScopeCommand(unit, command) {
      record({ type: 'launch', unit, argv: [bashPath, '-c', command] })

      return ['exec', ...[ENV_PATH, `${SCOPE_ENV}=${unit}`, bashPath, '-c', command].map(shellQuote)].join(' ')
    },
    async systemctl(args, timeoutMs) {
      record({ type: 'systemctl', args: [...args], timeoutMs })

      return options.systemctl === undefined ? commandResult() : options.systemctl(args)
    },
    async loginctl(args, timeoutMs) {
      record({ type: 'loginctl', args: [...args], timeoutMs })

      return options.loginctl === undefined ? commandResult() : options.loginctl(args)
    },
    stopScopes
  }

  return {
    ops,
    records() {
      return [...records]
    },
    launches() {
      return records.flatMap((entry) => {
        return entry.type === 'launch' ? [entry] : []
      })
    },
    systemctlCalls() {
      return records.flatMap((entry) => {
        return entry.type === 'systemctl' ? [entry.args] : []
      })
    }
  }
}
