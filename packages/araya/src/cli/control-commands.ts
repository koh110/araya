// `araya status・stop・reset`（Discord の slash command `/araya status・stop・reset` と同じ operation）。
// 会話 session を操作できるのは稼働中の Discord bot process だけなので、CLI は file の control request を書き、
// bot がそれを拾って result を返す（src/infrastructure/control-bus.ts / src/discord/cli-control.ts）。
// 同じ OS user だけが file を書けるので、それで許可の境界になる（agent session の shell も同じ user なので叩ける）
import { parseArgs } from 'node:util'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import {
  CONTROL_COMMANDS,
  cancelControlRequest,
  controlRequestId,
  isControlCommandName,
  readControlResult,
  writeControlRequest,
  type ControlCommandName,
} from '../infrastructure/control-bus.ts'
import { runHootCommand } from './hoot-commands.ts'

export const CLI_CONTROL_SUBCOMMANDS = CONTROL_COMMANDS
// bot の poll は既定 1 秒。人間の体感で待たせないように 30 秒まで待つ（reset は SQLite の作り直しで時間がかかる）
export const CLI_CONTROL_WAIT_MS = 30_000
const CLI_CONTROL_POLL_MS = 200
const CLI_CONTROL_WAIT_MAX_S = 120

export type CliControlCommandDependencies = {
  dataDir: string
  stdout(text: string): void
  nowMs(): number
  env: Readonly<Record<string, string | undefined>>
  waitMs?: number
  pollMs?: number
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function hootStatusText(dataDir: string, deps: CliControlCommandDependencies) {
  const lines: string[] = []

  await runHootCommand(
    ['status'],
    {
      dataDir,
      stdout: (text) => {
        lines.push(text)
      },
      nowMs: deps.nowMs,
    },
  )

  return lines.join('\n')
}

export function controlPositionalsOf(args: readonly string[]) {
  const parsed = parseArgs({
    args: args.slice(),
    options: {
      'data-dir': { type: 'string' },
      'wait-seconds': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  })

  return parsed
}

export async function runControlCommand(
  args: readonly string[],
  deps: CliControlCommandDependencies,
): Promise<void> {
  const { positionals, values } = controlPositionalsOf(args)
  const name = positionals[0] ?? ''

  if (!isControlCommandName(name)) {
    throw new Error(
      `不明な control の command: ${positionals.join(' ') || '（なし）'}。${(CONTROL_COMMANDS as readonly string[]).join(' / ')} のどれかを指定してください（araya --help で一覧）`,
    )
  }

  const dataDir = values['data-dir'] ?? deps.dataDir
  const requestedWait = Number(values['wait-seconds'])
  const waitMs =
    deps.waitMs ??
    (Number.isSafeInteger(requestedWait) && requestedWait > 0
      ? Math.min(requestedWait, CLI_CONTROL_WAIT_MAX_S) * 1000
      : CLI_CONTROL_WAIT_MS)
  const pollMs = deps.pollMs ?? CLI_CONTROL_POLL_MS
  const command: ControlCommandName = name
  const id = controlRequestId(deps.nowMs(), `${command}:${process.pid}:${randomUUID()}`)

  await writeControlRequest(dataDir, {
    version: 1,
    id,
    command,
    source: 'cli',
    createdAt: new Date(deps.nowMs()).toISOString(),
  })

  const deadlineMs = deps.nowMs() + waitMs
  let result = await readControlResult(dataDir, id)

  while (result === null && deps.nowMs() < deadlineMs) {
    await sleep(pollMs)
    result = await readControlResult(dataDir, id)
  }

  if (result === null) {
    // 待ち切れにした要求を後で bot が実行しないように取り消す（期限より先に消す）
    await cancelControlRequest(dataDir, id)

    if (command === 'status') {
      // status は読み取りなので、bot が応答しなくても CLI 側で読める部分を返す
      const hootText = await hootStatusText(dataDir, deps)

      deps.stdout(
        `${hootText}\n\n（会話 session の状態は稼働中の bot が答えます。応答がなかったので bot の稼働を araya discord status で確かめてください）`,
      )

      return
    }

    throw new Error(
      `araya_control_unavailable: 稼働中の araya bot が ${command} の要求を受け付けませんでした。araya discord status で unit の稼働を確かめてください`,
    )
  }

  if (!result.ok) {
    throw new Error(`araya_control_failed: ${result.error ?? 'bot 側の処理に失敗しました'}`)
  }

  deps.stdout(result.output)
}
