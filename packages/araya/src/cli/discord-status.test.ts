import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { formatDiscordStatusReport, readDiscordUnitStatus } from './discord-status.ts'
import { DISCORD_STATE_VERSION, discordStateFilePath } from '../discord/state.ts'
import { dataDirHash, discordUnitName, unitFilePath, type CommandResult, type SystemdOps } from '../infrastructure/systemd.ts'

const SHOW_PROPERTIES = 'ActiveState,SubState,UnitFileState,NRestarts,ExecMainStartTimestamp'

function fakeOps(stdout: string, exitCode = 0): SystemdOps {
  const calls: string[][] = []

  const ops: SystemdOps = {
    systemctl: async (args) => {
      calls.push(args.slice())

      const result: CommandResult = {
        exitCode,
        stdout,
        stderr: exitCode === 0 ? '' : 'Failed to get unit file state for unknown unit: No such device or address',
        timedOut: false,
      }

      return result
    },
    loginctl: async () => {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }

  return ops
}

test('araya discord status: unit file・systemctl show・ready 記録をまとめて返す（token は読まない）', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-status-'))
  const homeDir = dataDir
  const unit = discordUnitName(dataDirHash(await fs.realpath(dataDir)))
  const unitPath = unitFilePath({}, homeDir, unit)

  await fs.mkdir(path.dirname(unitPath), { recursive: true })
  await fs.writeFile(unitPath, '[Unit]\nDescription=araya Discord bot (fake)\n[Service]\nExecStart=/bin/true\n', 'utf8')
  await fs.mkdir(path.dirname(discordStateFilePath(dataDir)), { recursive: true })
  await fs.writeFile(
    discordStateFilePath(dataDir),
    `${JSON.stringify({ version: DISCORD_STATE_VERSION, unit, readyId: 'ready-1', lastReadyAt: '2026-11-23T03:41:40.000Z' }, null, 2)}\n`,
    'utf8',
  )

  const report = await readDiscordUnitStatus(
    fakeOps(
      [
        'ActiveState=active',
        'SubState=running',
        'UnitFileState=enabled',
        'NRestarts=2',
        'ExecMainStartTimestamp=Mon 2026-11-23 12:41:33 JST',
      ].join('\n'),
    ),
    dataDir,
    homeDir,
    {},
  )

  assert.equal(report.unit, unit)
  assert.equal(report.installed, true)
  assert.equal(report.activeState, 'active')
  assert.equal(report.subState, 'running')
  assert.equal(report.unitFileState, 'enabled')
  assert.equal(report.restarts, 2)
  assert.equal(report.startedAt, 'Mon 2026-11-23 12:41:33 JST')
  assert.equal(report.lastReadyAt, '2026-11-23T03:41:40.000Z')

  const text = formatDiscordStatusReport(report)
  assert.match(text, /state: active \/ running/)
  assert.match(text, /restarts: 2/)
  assert.match(text, /last ready: 2026-11-23T03:41:40\.000Z/)
  // 表示は unit 名・状態・時刻だけ（unit file の中身も token も出さない）
  assert.ok(!text.includes('ExecStart'))
})

test('araya discord status: unit が無いときは install 前だと案内する（command は失敗しない）', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-status-missing-'))
  const ops = fakeOps(`ActiveState=inactive\nSubState=dead\nUnitFileState=invalid\nNRestarts=0\n`, 1)

  const report = await readDiscordUnitStatus(ops, dataDir, dataDir, {})
  assert.equal(report.installed, false)
  assert.equal(report.activeState, 'inactive')
  assert.equal(report.restarts, 0)
  assert.equal(report.lastReadyAt, null)

  const text = formatDiscordStatusReport(report)
  assert.match(text, /unit file: .*（ありません）/)
  assert.match(text, /araya discord install/)
})

test('araya discord status: 読み取る property は state 用の名前一覧に限定する', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-status-props-'))
  const captured: string[][] = []
  const ops: SystemdOps = {
    systemctl: async (args) => {
      captured.push(args.slice())

      return { exitCode: 0, stdout: 'ActiveState=active\n', stderr: '', timedOut: false }
    },
    loginctl: async () => {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }

  await readDiscordUnitStatus(ops, dataDir, dataDir, {})
  const args = captured[0] ?? []
  assert.deepEqual(args.slice(0, 3), ['--user', 'show', `--property=${SHOW_PROPERTIES}`])
  assert.ok(!args.some((arg) => {
    return arg.includes('Environment') || arg.includes('Token')
  }))
})
