import { appendFileSync } from 'node:fs'

import type { CommandResult, SystemdOps } from '../../src/infrastructure/systemd.ts'

// 偽物の systemd。systemctl と loginctl の呼び出しを記録して、test が決めた応答を返す。
// unit file の install・uninstall が実際に systemctl を呼ばないこと（ctl-path の代用）を test で確かめるため使う。

export type FakeRecord =
  | { type: 'systemctl'; args: string[]; timeoutMs: number }
  | { type: 'loginctl'; args: string[]; timeoutMs: number }

export type FakeSystemdOptions = {
  // systemctl と loginctl の応答。省略時は終了 code 0 で出力なし
  systemctl?: (args: readonly string[]) => CommandResult | Promise<CommandResult>
  loginctl?: (args: readonly string[]) => CommandResult | Promise<CommandResult>
  // process をまたぐ test で、記録を JSONL で追記する file
  recordFile?: string
}

export function commandResult(stdout = '', exitCode: number | null = 0, stderr = '') {
  const result: CommandResult = { exitCode, stdout, stderr, timedOut: false }

  return result
}

export function createFakeSystemd(options: FakeSystemdOptions = {}) {
  const records: FakeRecord[] = []

  function record(entry: FakeRecord) {
    records.push(entry)

    if (options.recordFile !== undefined) {
      appendFileSync(options.recordFile, `${JSON.stringify(entry)}\n`, 'utf8')
    }
  }

  const ops: SystemdOps = {
    async systemctl(args, timeoutMs) {
      record({ type: 'systemctl', args: [...args], timeoutMs })

      return options.systemctl === undefined ? commandResult() : options.systemctl(args)
    },
    async loginctl(args, timeoutMs) {
      record({ type: 'loginctl', args: [...args], timeoutMs })

      return options.loginctl === undefined ? commandResult() : options.loginctl(args)
    },
  }

  return {
    ops,
    records() {
      return [...records]
    },
    systemctlCalls() {
      return records.flatMap((entry) => {
        return entry.type === 'systemctl' ? [entry.args] : []
      })
    },
  }
}
