import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  hootStateFilePath,
  readHootState,
  recordHootRun,
  resetSchedule,
  setGoal,
  setGoalStatus,
  setHootConversationId,
  updateHootState,
  updateSettings,
  writeHootState,
} from '../src/hoot/store.ts'
import { MAX_RUNS_KEPT, defaultState, type HootRun } from '../src/hoot/model.ts'

async function makeHootFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-hoot-store-test-')))

  return { root, dataDir: path.join(root, 'data') }
}

function runFixture(occurrenceKey: string, decidedAt: string): HootRun {
  return {
    occurrenceKey,
    // occurrenceKey は plannedAt そのもの（hoot:<ISO>）。schedule の advance は plannedAt を使う
    plannedAt: occurrenceKey.replace('hoot:', ''),
    decidedAt,
    decision: 'noop',
    reason: '変化なし',
    summary: '',
    goalKeys: ['quality'],
    missedOccurrences: 0,
    dispatched: false,
    observedRepos: [],
    observationGaps: [],
  }
}

test('hoot store: 初期 state は enabled=false・mode=dry_run で、goal と settings を lock 付きで更新できる', async () => {
  const fixture = await makeHootFixture()

  try {
    const initial = await readHootState(fixture.dataDir)
    assert.deepEqual(initial, defaultState())

    const added = await setGoal(
      fixture.dataDir,
      {
        key: 'araya-quality',
        objective: 'open issue と draft PR を拾って次作業の提案を作る',
        scope: ['github:koh110/araya'],
        constraints: ['merge は人間の承認後だけ'],
      },
      { replace: false }
    )
    assert.equal(added.created, true)
    assert.equal(added.goal.key, 'araya-quality')

    await assert.rejects(
      () => {
        return setGoal(fixture.dataDir, { key: 'araya-quality', objective: 'duplicate' }, { replace: false })
      },
      /hoot_goal_exists/
    )

    const updated = await setGoal(
      fixture.dataDir,
      { key: 'araya-quality', objective: '更新後の objective', scope: ['github:koh110/araya'] },
      { replace: true }
    )
    assert.equal(updated.created, false)
    const state = await readHootState(fixture.dataDir)
    assert.equal(state.goals.length, 1)
    assert.equal(state.goals[0]?.objective, '更新後の objective')
    assert.equal(state.goals[0]?.createdAt, added.goal.createdAt)

    const paused = await setGoalStatus(fixture.dataDir, 'araya-quality', 'paused')
    assert.equal(paused.status, 'paused')
    await assert.rejects(
      () => {
        return setGoalStatus(fixture.dataDir, 'missing-key', 'active')
      },
      /hoot_goal_not_found/
    )

    const settings = await updateSettings(fixture.dataDir, {
      enabled: true,
      tickMinutes: 15,
      maxRunsPerDay: 3,
      notifyNoop: true,
    })
    assert.equal(settings.enabled, true)
    assert.equal(settings.tickMinutes, 15)
    assert.equal(settings.maxRunsPerDay, 3)
    assert.equal(settings.notifyNoop, true)
    assert.equal(settings.mode, 'dry_run')

    const modeFile = await fs.stat(hootStateFilePath(fixture.dataDir))
    assert.equal(modeFile.mode & 0o777, 0o600)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: settings の検証（mode=active は未実装で拒否、tickMinutes の range）', async () => {
  const fixture = await makeHootFixture()

  try {
    await assert.rejects(
      () => {
        return updateSettings(fixture.dataDir, { mode: 'active' })
      },
      /hoot_mode_unimplemented/
    )

    await assert.rejects(
      () => {
        return updateSettings(fixture.dataDir, { tickMinutes: 1 })
      },
      /hoot_settings_invalid/
    )

    await assert.rejects(
      () => {
        return updateSettings(fixture.dataDir, { maxRunsPerDay: 0 })
      },
      /hoot_settings_invalid/
    )

    const settings = await updateSettings(fixture.dataDir, { mode: 'dry_run' })
    assert.equal(settings.mode, 'dry_run')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 同時更新は lock で直列化され、両方の goal が残る', async () => {
  const fixture = await makeHootFixture()

  try {
    await Promise.all([
      setGoal(fixture.dataDir, { key: 'goal-one', objective: 'one' }),
      setGoal(fixture.dataDir, { key: 'goal-two', objective: 'two' }),
      setGoal(fixture.dataDir, { key: 'goal-three', objective: 'three' }),
    ])

    const state = await readHootState(fixture.dataDir)
    // lock で直列化されるので 3 件とも残る。lock 取得順は process 側で決まるため goal の並びは fix しない
    assert.deepEqual(
      state.goals.map((goal) => {
        return goal.key
      }).sort(),
      ['goal-one', 'goal-three', 'goal-two']
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 同じ occurrenceKey の run は書き込まず、記録は直近分だけ保つ', async () => {
  const fixture = await makeHootFixture()

  try {
    const first = await recordHootRun(fixture.dataDir, runFixture('hoot:2026-11-19T00:00:00.000Z', '2026-11-19T00:00:01.000Z'))
    assert.equal(first.recorded, true)

    const replay = await recordHootRun(fixture.dataDir, runFixture('hoot:2026-11-19T00:00:00.000Z', '2026-11-19T00:09:00.000Z'))
    assert.equal(replay.recorded, false)
    assert.equal(replay.run.decidedAt, '2026-11-19T00:00:01.000Z')

    let state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.lastOccurrenceAt, '2026-11-19T00:00:00.000Z')
    assert.equal(state.loop.lastRunAt, '2026-11-19T00:00:01.000Z')

    const padded = (value: number) => {
      return String(value).padStart(4, '0')
    }

    for (let index = 0; index < MAX_RUNS_KEPT + 5; index += 1) {
      await recordHootRun(
        fixture.dataDir,
        runFixture(`hoot:2026-11-20T00:${padded(index)}:00.000Z`, `2026-11-20T00:${padded(index)}:01.000Z`)
      )
    }

    state = await readHootState(fixture.dataDir)
    assert.equal(state.runs.length, MAX_RUNS_KEPT)
    assert.equal(state.runs[0]?.occurrenceKey, `hoot:2026-11-20T00:${padded(5)}:00.000Z`)
    assert.equal(state.runs.at(-1)?.occurrenceKey, `hoot:2026-11-20T00:${padded(MAX_RUNS_KEPT + 4)}:00.000Z`)

    await setHootConversationId(fixture.dataDir, 42)
    await resetSchedule(fixture.dataDir)
    state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.conversationId, 42)
    assert.equal(state.loop.lastOccurrenceAt, null)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 壊れた state は復旧せず誤り、書き込みは atomic（一時 file を残さない）', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, defaultState())
    await fs.writeFile(hootStateFilePath(fixture.dataDir), '{ not json', 'utf8')

    await assert.rejects(
      () => {
        return readHootState(fixture.dataDir)
      },
      /hoot_state_invalid/
    )

    await assert.rejects(
      () => {
        return updateHootState(fixture.dataDir, (state) => {
          state.settings.enabled = true
        })
      },
      /hoot_state_invalid/
    )

    const directory = path.dirname(hootStateFilePath(fixture.dataDir))
    const leftovers = (await fs.readdir(directory)).filter((entry) => {
      return entry.endsWith('.tmp')
    })
    assert.deepEqual(leftovers, [])

    await fs.writeFile(hootStateFilePath(fixture.dataDir), JSON.stringify({ version: 99 }), 'utf8')
    await assert.rejects(
      () => {
        return readHootState(fixture.dataDir)
      },
      /hoot_state_invalid/
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
