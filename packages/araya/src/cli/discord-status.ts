// Discord bot の unit 稼働の確かめ（`araya discord status`）。
// install / uninstall は unit を触る command なので、読-only の状態確認をここに分ける。
// 出力は unit 名・ActiveState/SubState・起動時刻・restart 回数・last ready 時刻（IDs と状態だけ。token は読まない）

import fs from 'node:fs/promises'
import { realpathOrResolved } from './command-support.ts'
import {
  dataDirHash,
  discordUnitName,
  unitFilePath,
  type SystemdOps,
} from '../infrastructure/systemd.ts'
import { discordStateFilePath, readDiscordBotState, type DiscordBotState } from '../discord/state.ts'

const STATUS_PROPERTIES = [
  'ActiveState',
  'SubState',
  'UnitFileState',
  'NRestarts',
  'ExecMainStartTimestamp',
] as const

function parseSystemctlProperties(text: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const index = line.indexOf('=')

    if (index <= 0) {
      continue
    }

    values[line.slice(0, index)] = line.slice(index + 1).trim()
  }

  return values
}

export type DiscordStatusReport = {
  unit: string
  installed: boolean
  activeState: string
  subState: string
  unitFileState: string
  restarts: number
  startedAt: string | null
  lastReadyAt: string | null
  stateFile: string
  unitFile: string
}

export async function readDiscordUnitStatus(
  ops: SystemdOps,
  dataDir: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DiscordStatusReport> {
  const unit = discordUnitName(dataDirHash(await realpathOrResolved(dataDir)))
  const unitPath = unitFilePath(env, homeDir, unit)
  let installed = false

  try {
    await fs.stat(unitPath)
    installed = true
  } catch {
    installed = false
  }

  const result = await ops.systemctl(
    ['--user', 'show', `--property=${STATUS_PROPERTIES.join(',')}`, unit],
    10_000,
  )
  const properties = parseSystemctlProperties(result.stdout)
  let state: DiscordBotState | null = null

  try {
    state = readDiscordBotState(dataDir)
  } catch {
    // state file が無い = まだ ready になっていない（または uninstall 済み）
    state = null
  }

  return {
    unit,
    installed,
    activeState: properties['ActiveState'] ?? 'unknown',
    subState: properties['SubState'] ?? 'unknown',
    unitFileState: properties['UnitFileState'] ?? 'unknown',
    restarts: Number(properties['NRestarts'] ?? '0') || 0,
    startedAt: nonEmpty(properties['ExecMainStartTimestamp']) ? String(properties['ExecMainStartTimestamp']) : null,
    lastReadyAt: state?.lastReadyAt ?? null,
    stateFile: discordStateFilePath(dataDir),
    unitFile: unitPath,
  }
}

function nonEmpty(value: string | undefined) {
  return typeof value === 'string' && value !== ''
}

export function formatDiscordStatusReport(report: DiscordStatusReport): string {
  const lines = [
    `unit: ${report.unit}`,
    `unit file: ${report.unitFile}（${report.installed ? 'あります' : 'ありません'}）`,
    `state: ${report.activeState} / ${report.subState}（unit file: ${report.unitFileState}）`,
    `restarts: ${report.restarts.toString()}`,
    `main process 起動: ${report.startedAt ?? 'わかりません'}`,
    `last ready: ${report.lastReadyAt ?? 'ready 記録がありません'}`,
    `state file: ${report.stateFile}`,
  ]

  if (!report.installed) {
    lines.push('araya discord install をまだ実行していない可能性があります（unit file が無い）')
  } else if (report.activeState !== 'active') {
    lines.push('unit が active ではありません。araya-discord-<hash>.service の log を確かめてください')
  }

  return lines.join('\n')
}
