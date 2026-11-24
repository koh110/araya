import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import {
  DEFAULT_LAUNCHER_STOP_WAIT_MS,
  launchChildAndWait,
  launcherStopWaitMs,
  stderrLineWriter,
} from './child-launcher.ts'
import { discordUnitSections } from './systemd.ts'
import { SHUTDOWN_BUDGET_TOTAL_MS } from '../discord/bot.ts'

test('child launcher: stderrLineWriter は 1 件を 1 行として書き、改行を二重エスケープしない', () => {
  const chunks: string[] = []
  const write = stderrLineWriter((chunk) => {
    chunks.push(chunk)
  })

  write('discord-env-runner: bot line 1')
  write('discord-env-runner: bot line 2')

  assert.deepEqual(chunks, ['discord-env-runner: bot line 1\n', 'discord-env-runner: bot line 2\n'])
  // `${line}\\n` のようにリテラルの \n を混ぜると log が 1 行に連結する
  assert.ok(!chunks.some((chunk) => chunk.includes('\\n')), JSON.stringify(chunks))
})

test('child launcher: bot の stderr は行ごとに redact して writeError へ渡す', async () => {
  const lines: string[] = []
  const outcome = await launchChildAndWait({
    command: process.execPath,
    args: ['-e', 'process.stderr.write("trace with bot-secret-value line\\nsecond line\\n")'],
    env: { ...process.env },
    stopWaitMs: 5_000,
    secretValues: ['bot-secret-value'],
    label: 'fake-runner',
    writeError: stderrLineWriter((line) => {
      lines.push(line)
    }),
  })

  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome))
  assert.equal(outcome.killedByLauncher, false)
  // child の終了理由（code / signal）が stderr 本文の後ろに残り、launch log から trace が落ちない（#36 の死因切り分け）
  assert.deepEqual(lines, [
    'fake-runner: trace with [redacted] line\n',
    'fake-runner: second line\n',
    'fake-runner: child 終了（code=0, signal=none）\n',
  ])
})

test('child launcher: stop wait の default は bot の shutdown budget と unit TimeoutStopSec の間に入る', () => {
  assert.equal(launcherStopWaitMs({}), DEFAULT_LAUNCHER_STOP_WAIT_MS)
  assert.equal(launcherStopWaitMs({ ARAYA_LAUNCHER_STOP_WAIT_MS: '21000' }), 21_000)
  // 数字でない物と bounds 外は default に戻す
  assert.equal(
    launcherStopWaitMs({ ARAYA_LAUNCHER_STOP_WAIT_MS: 'abc' }),
    DEFAULT_LAUNCHER_STOP_WAIT_MS,
  )
  assert.equal(
    launcherStopWaitMs({ ARAYA_LAUNCHER_STOP_WAIT_MS: '50' }),
    DEFAULT_LAUNCHER_STOP_WAIT_MS,
  )

  // #36 の跨 file 不変条件: runner は bot の drain より先に死なず、unit の SIGKILL より先に諦める
  const sections = discordUnitSections({
    authMode: 'env-file',
    dataDir: '/tmp/araya-child-launcher-invariant',
    nodePath: '/usr/bin/node',
    botEntrypoint: '/usr/bin/node',
    envFilePath: '/tmp/araya-child-launcher-invariant/.env',
    environment: [],
  })
  const timeoutStopSec = Number(
    sections.service.find(([name]) => {
      return name === 'TimeoutStopSec'
    })?.[1] ?? '0',
  )

  assert.ok(timeoutStopSec > 0, 'unit に TimeoutStopSec がない')
  assert.ok(
    DEFAULT_LAUNCHER_STOP_WAIT_MS > SHUTDOWN_BUDGET_TOTAL_MS,
    `runner の stop wait ${DEFAULT_LAUNCHER_STOP_WAIT_MS} ms が bot の shutdown budget ${SHUTDOWN_BUDGET_TOTAL_MS} ms より短い`,
  )
  assert.ok(
    DEFAULT_LAUNCHER_STOP_WAIT_MS < timeoutStopSec * 1_000,
    `runner の stop wait ${DEFAULT_LAUNCHER_STOP_WAIT_MS} ms が TimeoutStopSec ${timeoutStopSec} s を越えている`,
  )
})
