import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseHootArguments, runHootCommand } from '../src/cli/hoot-commands.ts'
import { readHootState, writeHootState } from '../src/hoot/store.ts'
import { defaultState } from '../src/hoot/model.ts'
import { createHootLoop } from '../src/hoot/tick.ts'
import { collectSecretValues, createRedactor } from '../src/infrastructure/redaction.ts'

async function makeHootCliFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-hoot-cli-test-')))
  const dataDir = path.join(root, 'data')
  const lines: string[] = []

  const run = async (args: string[]) => {
    lines.length = 0

    try {
      await runHootCommand(args, {
        dataDir,
        stdout: (text) => {
          lines.push(text)
        },
        nowMs: () => {
          return Date.parse('2026-11-19T09:00:00.000Z')
        },
      })

      return { ok: true, output: lines.join('\n'), message: '' }
    } catch (error) {
      return {
        ok: false,
        output: lines.join('\n'),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { root, dataDir, run }
}

test('hoot cli: 引数の解析（positional と --key value）', () => {
  const parsed = parseHootArguments(['goal', 'add', '--key', 'araya-quality', '--objective', 'a b c', '--scope', 'github:a/b'])
  assert.deepEqual(parsed.positionals, ['goal', 'add'])
  assert.deepEqual(parsed.options, { key: 'araya-quality', objective: 'a b c', scope: 'github:a/b' })

  assert.throws(
    () => {
      return parseHootArguments(['settings', 'set', '--enabled'])
    },
    /hoot_invalid_argument/
  )
})

test('hoot cli: status / goal add / update / pause / settings set / runs が state file に効く', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const status = await fixture.run(['status'])
    assert.equal(status.ok, true)
    assert.match(status.output, /enabled: false/u)
    assert.match(status.output, /mode: dry_run/u)
    assert.match(status.output, /active goals: 0\/0/u)
    assert.match(status.output, /hoot conversationId: （まだ作っていません）/u)

    const added = await fixture.run([
      'goal',
      'add',
      '--key',
      'araya-quality',
      '--objective',
      'open issue と draft PR を拾って次作業の提案を作る',
      '--scope',
      'github:koh110/araya',
      '--constraint',
      'merge は人間の承認後だけ,secret を commit しない',
    ])
    assert.equal(added.ok, true)
    assert.match(added.output, /araya-quality \[active\]/u)
    assert.match(added.output, /constraints: merge は人間の承認後だけ \/ secret を commit しない/u)

    const duplicate = await fixture.run(['goal', 'add', '--key', 'araya-quality', '--objective', 'duplicate'])
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.message, /hoot_goal_exists/u)

    const updated = await fixture.run(['goal', 'update', '--key', 'araya-quality', '--objective', '更新後の objective'])
    assert.equal(updated.ok, true)
    assert.match(updated.output, /更新後の objective/u)

    const missingUpdate = await fixture.run(['goal', 'update', '--key', 'nope', '--objective', 'x'])
    assert.equal(missingUpdate.ok, false)
    assert.match(missingUpdate.message, /hoot_goal_not_found/u)

    const paused = await fixture.run(['goal', 'pause', '--key', 'araya-quality'])
    assert.equal(paused.ok, true)
    assert.match(paused.output, /status を paused/u)

    const settings = await fixture.run([
      'settings',
      'set',
      '--enabled',
      'true',
      '--tick-minutes',
      '10',
      '--max-runs-per-day',
      '4',
      '--notify-noop',
      'true',
    ])
    assert.equal(settings.ok, true)
    assert.match(settings.output, /enabled: true/u)
    assert.match(settings.output, /tickMinutes: 10/u)

    const modeActive = await fixture.run(['settings', 'set', '--mode', 'active'])
    assert.equal(modeActive.ok, false)
    assert.match(modeActive.message, /dry_run/u)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.settings.enabled, true)
    assert.equal(state.settings.tickMinutes, 10)
    assert.equal(state.settings.maxRunsPerDay, 4)
    assert.equal(state.settings.notifyNoop, true)
    assert.equal(state.goals[0]?.status, 'paused')

    const runs = await fixture.run(['runs'])
    assert.equal(runs.ok, true)
    assert.match(runs.output, /判断 run の記録はありません/u)

    const statusAfter = await fixture.run(['status'])
    assert.match(statusAfter.output, /enabled: true/u)
    assert.match(statusAfter.output, /active goals: 0\/1/u)
    assert.match(statusAfter.output, /araya-quality \[paused\]/u)

    const unknown = await fixture.run(['nope'])
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /hoot_invalid_argument/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: bot loop と同じ state file を使う（CLI で有効化すると tick が走り、記録は CLI に見える）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    await writeHootState(fixture.dataDir, defaultState())
    const enabled = await fixture.run(['goal', 'add', '--key', 'github-scan', '--objective', 'open issue を数える', '--scope', 'github:koh110/araya'])
    assert.equal(enabled.ok, true)
    assert.equal((await fixture.run(['settings', 'set', '--enabled', 'true'])).ok, true)

    const loop = createHootLoop({
      dataDir: fixture.dataDir,
      devRoot: fixture.root,
      redactor: createRedactor(collectSecretValues({})),
      decide: async () => {
        return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 21 }
      },
      log: () => {},
      nowMs: () => Date.parse('2026-11-19T09:00:00.000Z'),
      env: {},
      runCommand: async () => ({
        exitCode: 0,
        signal: null,
        stdout: '[]',
        stderr: '',
        stdoutBytes: 2,
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }),
    })

    const outcome = await loop.tickOnce()
    assert.equal(outcome.kind, 'ran')

    const runs = await fixture.run(['runs'])
    assert.match(runs.output, /hoot:2026-11-19T09:00:00\.000Z/u)
    assert.match(runs.output, /noop/u)

    const status = await fixture.run(['status'])
    assert.match(status.output, /hoot conversationId: 21/u)
    assert.match(status.output, /next occurrence: 2026-11-19T10:00:00\.000Z/u)

    const reset = await fixture.run(['reset-schedule'])
    assert.equal(reset.ok, true)
    assert.equal((await readHootState(fixture.dataDir)).loop.lastOccurrenceAt, null)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: 壊れた state file に対して restore の手順を誤りに書く（黙って初期化しない）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const written = await fixture.run(['goal', 'add', '--key', 'keep-me', '--objective', 'objective'])
    assert.equal(written.ok, true)
    const statePath = path.join(fixture.dataDir, 'hoot', 'state.json')
    await fs.writeFile(statePath, '{ broken', 'utf8')

    const failed = await fixture.run(['status'])
    assert.equal(failed.ok, false)
    assert.match(failed.message, /hoot_state_invalid/u)
    assert.match(failed.message, /hoot\/state\.json/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
