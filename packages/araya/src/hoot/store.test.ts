import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'

import {
  enqueueHootInject,
  finishHootInject,
  hootStateFilePath,
  mergeSettings,
  pauseExpiredGoals,
  readHootState,
  recordHootDigest,
  recordHootRun,
  resetSchedule,
  resolveProposal,
  setGoal,
  setGoalStatus,
  setHootConversationId,
  takePendingInject,
  takeProposalReminder,
  updateHootState,
  updateSettings,
  upsertProposal,
  writeHootState,
} from './store.ts'
import {
  DEFAULT_GOAL_REVIEW_DAYS,
  DEFAULT_INJECT_COOLDOWN_MINUTES,
  DEFAULT_MAX_INJECTS_PER_DAY,
  DEFAULT_NOTIFY_DECISIONS,
  HOOT_STATE_VERSION,
  HOOT_STATE_VERSION_INJECT,
  MAX_GOALS,
  MAX_INJECTS_KEPT,
  MAX_INJECT_ATTEMPTS,
  MAX_OPEN_PROPOSALS,
  MAX_PROPOSAL_EVIDENCE_KEYS,
  MAX_PROPOSALS_KEPT,
  MAX_RUNS_KEPT,
  defaultSettings,
  defaultState,
  injectKeyOf,
  isoUtc,
  proposalKeyOf,
  reviewPassed,
  utcDayKey,
  type HootGoal,
  type HootGoalInput,
  type HootInjectRequest,
  type HootProposal,
  type HootRun,
  type HootSettings,
  type HootState,
} from './model.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

async function makeHootFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-hoot-store-test-')))

  return { root, dataDir: path.join(root, 'data') }
}

function runFixture(
  occurrenceKey: string,
  decidedAt: string,
  overrides: Partial<HootRun> = {},
): HootRun {
  return {
    occurrenceKey,
    // occurrenceKey は plannedAt そのもの（hoot:<ISO>）。schedule の advance は plannedAt を使う
    plannedAt: occurrenceKey.replace('hoot:', ''),
    decidedAt,
    // v2: 'model' は判断 run、'precheck' は観測変化なしの code 側 noop（model を呼んでいない）
    source: 'model',
    decision: 'noop',
    reason: '変化なし',
    summary: '',
    goalKeys: ['quality'],
    missedOccurrences: 0,
    dispatched: false,
    observedRepos: [],
    observationGaps: [],
    conversationReads: { calls: 0, entries: 0, chars: 0 },
    ...overrides,
  }
}

function goalFixture(key: string, overrides: Partial<HootGoal> = {}): HootGoal {
  return {
    key,
    objective: `${key} の objective`,
    scope: [],
    constraints: [],
    status: 'active',
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
    reviewAt: null,
    ...overrides,
  }
}

function proposalFixture(key: string, overrides: Partial<HootProposal> = {}): HootProposal {
  return {
    key,
    decision: 'request_human',
    goalKeys: ['araya-quality'],
    reason: '優先順位を決めてください',
    createdAt: '2026-11-19T08:00:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
    lastReminderAt: null,
    reminders: 0,
    expiresAt: isoUtc(Date.parse('2026-11-19T08:00:00.000Z') + 72 * HOUR_MS),
    status: 'open',
    evidenceOccurrenceKeys: ['hoot:2026-11-19T08:00:00.000Z'],
    ...overrides,
  }
}

// version 1（goal review・precheck・proposal のない state file）の形。settings に notifyNoop がある
function v1StateFixture(
  overrides: {
    settings?: Record<string, unknown>
    goals?: Record<string, unknown>[]
    loop?: Record<string, unknown>
    runs?: Record<string, unknown>[]
  } = {},
) {
  return {
    version: 1,
    settings: {
      enabled: true,
      mode: 'dry_run',
      tickMinutes: 30,
      maxRunsPerDay: 5,
      notifyNoop: true,
      ...overrides.settings,
    },
    goals: overrides.goals ?? [
      {
        key: 'legacy-goal',
        objective: 'legacy objective',
        scope: ['github:koh110/araya'],
        constraints: ['merge は人間の承認後だけ'],
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    loop: overrides.loop ?? {
      lastOccurrenceAt: '2026-01-03T00:00:00.000Z',
      lastRunAt: '2026-01-03T00:00:05.000Z',
      conversationId: 11,
      consecutiveFailures: 2,
      failureCooldownUntil: null,
    },
    runs: overrides.runs ?? [
      {
        occurrenceKey: 'hoot:2026-01-03T00:00:00.000Z',
        plannedAt: '2026-01-03T00:00:00.000Z',
        decidedAt: '2026-01-03T00:00:05.000Z',
        decision: 'noop',
        reason: '変化なし',
        summary: '',
        goalKeys: ['legacy-goal'],
        missedOccurrences: 0,
        dispatched: false,
        observedRepos: [],
        observationGaps: [],
      },
    ],
  }
}

async function writeV1File(dataDir: string, value: unknown) {
  await fs.mkdir(path.join(dataDir, 'hoot'), { recursive: true, mode: 0o700 })
  await fs.writeFile(hootStateFilePath(dataDir), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readStateFile(dataDir: string) {
  return JSON.parse(await fs.readFile(hootStateFilePath(dataDir), 'utf8')) as Record<
    string,
    unknown
  >
}

// 形が壊れていることを test したい state は型を通さず渡す（writeHootState / readHootState の検査を通す）
function brokenState(patch: Record<string, unknown>): HootState {
  return { ...defaultState(), ...patch } as unknown as HootState
}

test('hoot store: 初期 state は version 2 で enabled=false・mode=dry_run・新しい settings 既定を持ち、goal と settings を lock 付きで更新できる', async () => {
  const fixture = await makeHootFixture()

  try {
    const initial = await readHootState(fixture.dataDir)
    const beforeAddMs = Date.now()
    assert.deepEqual(initial, defaultState())
    assert.equal(initial.version, HOOT_STATE_VERSION)
    assert.deepEqual(initial.settings.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS])
    assert.equal(initial.settings.precheckObservation, true)
    assert.equal(initial.settings.watchdogHours, 24)
    assert.equal(initial.settings.digestHourUtc, 21)
    assert.equal(initial.settings.resetConversationAfterRuns, 24)
    assert.equal(initial.settings.goalReviewDays, DEFAULT_GOAL_REVIEW_DAYS)
    assert.equal(initial.settings.proposalTtlHours, 72)
    assert.equal(initial.settings.maxProposalReminders, 3)
    assert.deepEqual(initial.proposals, [])
    assert.equal(initial.loop.lastModelRunAt, null)
    assert.equal(initial.loop.lastDigestAt, null)
    assert.equal(initial.loop.conversationRuns, 0)
    assert.deepEqual(initial.loop.goalFingerprints, {})

    const added = await setGoal(
      fixture.dataDir,
      {
        key: 'araya-quality',
        objective: 'open issue と draft PR を拾って次作業の提案を作る',
        scope: ['github:koh110/araya'],
        constraints: ['merge は人間の承認後だけ'],
      },
      { replace: false },
    )
    assert.equal(added.created, true)
    assert.equal(added.goal.key, 'araya-quality')
    // goal add は review 期限を自動で入れる（tick の test 時刻より後ろになって自動 paused しない）
    assert.notEqual(added.goal.reviewAt, null)
    assert.ok(
      Date.parse(added.goal.reviewAt ?? '') >=
        beforeAddMs + (DEFAULT_GOAL_REVIEW_DAYS - 1) * DAY_MS,
    )

    await assert.rejects(() => {
      return setGoal(
        fixture.dataDir,
        { key: 'araya-quality', objective: 'duplicate' },
        { replace: false },
      )
    }, /hoot_goal_exists/)

    const updated = await setGoal(
      fixture.dataDir,
      { key: 'araya-quality', objective: '更新後の objective', scope: ['github:koh110/araya'] },
      { replace: true },
    )
    assert.equal(updated.created, false)
    const state = await readHootState(fixture.dataDir)
    assert.equal(state.goals.length, 1)
    assert.equal(state.goals[0]?.objective, '更新後の objective')
    assert.equal(state.goals[0]?.createdAt, added.goal.createdAt)
    // 更新で reviewAt を渡さなければ前の期限を保つ
    assert.equal(state.goals[0]?.reviewAt, added.goal.reviewAt)

    const paused = await setGoalStatus(fixture.dataDir, 'araya-quality', 'paused')
    assert.equal(paused.status, 'paused')
    await assert.rejects(() => {
      return setGoalStatus(fixture.dataDir, 'missing-key', 'active')
    }, /hoot_goal_not_found/)

    const settings = await updateSettings(fixture.dataDir, {
      enabled: true,
      tickMinutes: 15,
      maxRunsPerDay: 3,
      notifyDecisions: ['noop', 'request_human'],
      watchdogHours: 12,
    })
    assert.equal(settings.enabled, true)
    assert.equal(settings.tickMinutes, 15)
    assert.equal(settings.maxRunsPerDay, 3)
    assert.deepEqual(settings.notifyDecisions, ['noop', 'request_human'])
    assert.equal(settings.watchdogHours, 12)
    assert.equal(settings.mode, 'dry_run')
    // 旧 notifyNoop はもう存在しない
    assert.equal('notifyNoop' in settings, false)

    const modeFile = await fs.stat(hootStateFilePath(fixture.dataDir))
    assert.equal(modeFile.mode & 0o777, 0o600)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: settings の検証（mode=active は inject gate として受け、tickMinutes と inject settings の range）', async () => {
  const fixture = await makeHootFixture()

  try {
    // Issue #31 で mode=active は「承認された dispatch を main 会話へ inject してよい」 setting になった
    // （hoot_mode_unimplemented は廃止）。autoDispatch の既定は false のまま
    const active = await updateSettings(fixture.dataDir, { mode: 'active' })
    assert.equal(active.mode, 'active')
    assert.equal(active.autoDispatch, false)
    assert.equal(active.maxInjectsPerDay, DEFAULT_MAX_INJECTS_PER_DAY)
    assert.equal(active.injectCooldownMinutes, DEFAULT_INJECT_COOLDOWN_MINUTES)
    assert.equal((await readHootState(fixture.dataDir)).settings.mode, 'active')

    await assert.rejects(() => {
      return updateSettings(fixture.dataDir, { tickMinutes: 1 })
    }, /hoot_settings_invalid/)

    await assert.rejects(() => {
      return updateSettings(fixture.dataDir, { maxRunsPerDay: 0 })
    }, /hoot_settings_invalid/)

    // 新しい settings の範囲チェック（mergeSettings 直接でも同じ誤り）
    const current = defaultSettings()
    // 型は正しいが範囲外の patch と、型自体が壊れている patch の両方を store / mergeSettings で弾く
    const invalidPatches: Record<string, unknown>[] = [
      { notifyDecisions: ['noop', 'bogus'] },
      { precheckObservation: 'true' },
      { watchdogHours: 0 },
      { watchdogHours: 169 },
      { digestHourUtc: 24 },
      { resetConversationAfterRuns: -1 },
      { resetConversationAfterRuns: 1001 },
      { goalReviewDays: 366 },
      { proposalTtlHours: 0 },
      { proposalTtlHours: 721 },
      { maxProposalReminders: 11 },
      { mode: 'careful' },
      { autoDispatch: 'true' },
      { maxInjectsPerDay: -1 },
      { maxInjectsPerDay: 11 },
      { injectCooldownMinutes: -1 },
      { injectCooldownMinutes: 1441 },
    ]

    for (const patch of invalidPatches) {
      const settingsPatch = patch as unknown as Partial<HootSettings>

      assert.throws(() => {
        return mergeSettings(current, settingsPatch)
      }, /hoot_settings_invalid/u)

      await assert.rejects(() => {
        return updateSettings(fixture.dataDir, settingsPatch)
      }, /hoot_settings_invalid/)
    }

    // 境界値は通る。notifyDecisions は重複を取り除いて保持
    const merged = mergeSettings(current, {
      notifyDecisions: ['noop', 'noop', 'wait'],
      precheckObservation: false,
      watchdogHours: 168,
      digestHourUtc: null,
      resetConversationAfterRuns: 0,
      goalReviewDays: 0,
      proposalTtlHours: 720,
      maxProposalReminders: 0,
      tickMinutes: 5,
      maxRunsPerDay: 48,
      autoDispatch: true,
      maxInjectsPerDay: 0,
      injectCooldownMinutes: 0,
    })
    assert.deepEqual(merged.notifyDecisions, ['noop', 'wait'])
    assert.equal(merged.precheckObservation, false)
    assert.equal(merged.watchdogHours, 168)
    assert.equal(merged.digestHourUtc, null)
    assert.equal(merged.resetConversationAfterRuns, 0)
    assert.equal(merged.goalReviewDays, 0)
    assert.equal(merged.proposalTtlHours, 720)
    assert.equal(merged.maxProposalReminders, 0)
    assert.equal(merged.autoDispatch, true)
    assert.equal(merged.maxInjectsPerDay, 0)
    assert.equal(merged.injectCooldownMinutes, 0)
    assert.equal(merged.enabled, current.enabled)
    assert.equal(merged.mode, current.mode)

    const settings = await updateSettings(fixture.dataDir, { mode: 'dry_run', watchdogHours: 1 })
    assert.equal(settings.mode, 'dry_run')
    assert.equal(settings.watchdogHours, 1)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.settings.watchdogHours, 1)
    assert.equal('notifyNoop' in state.settings, false)
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
      state.goals
        .map((goal) => {
          return goal.key
        })
        .sort(),
      ['goal-one', 'goal-three', 'goal-two'],
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 同じ occurrenceKey の run は書き込まず、記録は直近分だけ保つ（source model / precheck を保持）', async () => {
  const fixture = await makeHootFixture()

  try {
    const first = await recordHootRun(
      fixture.dataDir,
      runFixture('hoot:2026-11-19T00:00:00.000Z', '2026-11-19T00:00:01.000Z'),
    )
    assert.equal(first.recorded, true)
    assert.equal(first.run.source, 'model')

    const replay = await recordHootRun(
      fixture.dataDir,
      runFixture('hoot:2026-11-19T00:00:00.000Z', '2026-11-19T00:09:00.000Z'),
    )
    assert.equal(replay.recorded, false)
    assert.equal(replay.run.decidedAt, '2026-11-19T00:00:01.000Z')

    // precheck noop（model を呼んでいない）も occurrence を 1 件消費する run として残る
    const prechecked = await recordHootRun(
      fixture.dataDir,
      runFixture('hoot:2026-11-19T01:00:00.000Z', '2026-11-19T01:00:01.000Z', {
        source: 'precheck',
        reason: '観測 fingerprint が前回と同じため model を呼ばない',
      }),
    )
    assert.equal(prechecked.recorded, true)

    let state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.lastOccurrenceAt, '2026-11-19T01:00:00.000Z')
    assert.equal(state.loop.lastRunAt, '2026-11-19T01:00:01.000Z')
    // recordHootRun が watchdog の基準も進める（source: 'model' の run だけ。precheck noop と
    // 同じ occurrenceKey の replay は進めない）。tick は別途 lastModelRunAt を書き直さない
    assert.equal(state.loop.lastModelRunAt, '2026-11-19T00:00:01.000Z')
    assert.equal(state.runs[1]?.source, 'precheck')

    const padded = (value: number) => {
      return String(value).padStart(4, '0')
    }

    for (let index = 0; index < MAX_RUNS_KEPT + 5; index += 1) {
      await recordHootRun(
        fixture.dataDir,
        runFixture(
          `hoot:2026-11-20T00:${padded(index)}:00.000Z`,
          `2026-11-20T00:${padded(index)}:01.000Z`,
        ),
      )
    }

    state = await readHootState(fixture.dataDir)
    assert.equal(state.runs.length, MAX_RUNS_KEPT)
    assert.equal(state.runs[0]?.occurrenceKey, `hoot:2026-11-20T00:${padded(5)}:00.000Z`)
    assert.equal(
      state.runs.at(-1)?.occurrenceKey,
      `hoot:2026-11-20T00:${padded(MAX_RUNS_KEPT + 4)}:00.000Z`,
    )

    await setHootConversationId(fixture.dataDir, 42)
    await resetSchedule(fixture.dataDir)
    state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.conversationId, 42)
    assert.equal(state.loop.lastOccurrenceAt, null)
    // schedule reset は run 記録・settings・proposals を保つ
    assert.equal(state.runs.length, MAX_RUNS_KEPT)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 壊れた state は復旧せず誤り、書き込みは atomic（一時 file を残さない）', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, defaultState())
    await fs.writeFile(hootStateFilePath(fixture.dataDir), '{ not json', 'utf8')

    await assert.rejects(() => {
      return readHootState(fixture.dataDir)
    }, /hoot_state_invalid/)

    await assert.rejects(() => {
      return updateHootState(fixture.dataDir, (state) => {
        state.settings.enabled = true
      })
    }, /hoot_state_invalid/)

    const directory = path.dirname(hootStateFilePath(fixture.dataDir))
    const leftovers = (await fs.readdir(directory)).filter((entry) => {
      return entry.endsWith('.tmp')
    })
    assert.deepEqual(leftovers, [])

    await fs.writeFile(hootStateFilePath(fixture.dataDir), JSON.stringify({ version: 99 }), 'utf8')
    await assert.rejects(() => {
      return readHootState(fixture.dataDir)
    }, /hoot_state_invalid/)

    // version 2 でも field が欠けていれば hoot_state_invalid（黙って既定値で作り直さない）
    await writeHootState(fixture.dataDir, defaultState())

    // settings の range 外
    await assert.rejects(() => {
      return writeHootState(
        fixture.dataDir,
        brokenState({ settings: { ...defaultSettings(), watchdogHours: 10_000 } }),
      )
    }, /hoot_state_invalid/)

    // 旧 notifyNoop だけの settings（notifyDecisions が無い）は v2 の形ではない
    const legacySettings = { ...defaultSettings(), notifyNoop: true } as Partial<HootSettings>
    delete legacySettings.notifyDecisions
    await assert.rejects(() => {
      return writeHootState(fixture.dataDir, brokenState({ settings: legacySettings }))
    }, /hoot_state_invalid/)

    // run の source 欠落
    await assert.rejects(() => {
      return writeHootState(
        fixture.dataDir,
        brokenState({
          runs: [
            {
              ...runFixture('hoot:2026-11-19T00:00:00.000Z', '2026-11-19T00:00:01.000Z'),
              source: undefined,
            },
          ],
        }),
      )
    }, /hoot_state_invalid/)

    // goal の reviewAt 欠落（v2 は null を含む reviewAt を要求する）
    await assert.rejects(() => {
      return writeHootState(
        fixture.dataDir,
        brokenState({ goals: [{ ...goalFixture('no-review'), reviewAt: undefined }] }),
      )
    }, /hoot_state_invalid/)

    // loop の新しい field 欠落
    await assert.rejects(() => {
      return writeHootState(
        fixture.dataDir,
        brokenState({
          loop: {
            ...defaultState().loop,
            goalFingerprints: undefined,
            conversationRuns: undefined,
          },
        }),
      )
    }, /hoot_state_invalid/)

    // proposals が配列でない（migration で埋める前提が崩れている）
    await assert.rejects(() => {
      return writeHootState(fixture.dataDir, brokenState({ proposals: undefined }))
    }, /hoot_state_invalid/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: version 1 の state.json は読み取り時に v2 へ migration する（読み取りでは file を書き換えない）', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeV1File(fixture.dataDir, v1StateFixture())

    const beforeMs = Date.now()
    const migrated = await readHootState(fixture.dataDir)
    const afterMs = Date.now()

    assert.equal(migrated.version, HOOT_STATE_VERSION)
    // settings は v1 の値を写して新项目は既定。notifyNoop は notifyDecisions の noop 1 本に寄せる
    assert.equal(migrated.settings.enabled, true)
    assert.equal(migrated.settings.mode, 'dry_run')
    assert.equal(migrated.settings.tickMinutes, 30)
    assert.equal(migrated.settings.maxRunsPerDay, 5)
    assert.deepEqual(migrated.settings.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS, 'noop'])
    assert.equal('notifyNoop' in migrated.settings, false)
    assert.equal(migrated.settings.precheckObservation, defaultSettings().precheckObservation)
    assert.equal(migrated.settings.watchdogHours, defaultSettings().watchdogHours)
    assert.equal(migrated.settings.digestHourUtc, defaultSettings().digestHourUtc)
    assert.equal(
      migrated.settings.resetConversationAfterRuns,
      defaultSettings().resetConversationAfterRuns,
    )
    assert.equal(migrated.settings.goalReviewDays, DEFAULT_GOAL_REVIEW_DAYS)
    assert.equal(migrated.settings.proposalTtlHours, defaultSettings().proposalTtlHours)
    assert.equal(migrated.settings.maxProposalReminders, defaultSettings().maxProposalReminders)

    // goal の review 期限は file 内容から決める（v1 の loop.lastRunAt と goal.updatedAt の新しい方 + goalReviewDays）。
    // read のたびに期限が前進しない。最後に走ったのが 2026-01-03 なので期限は 2026-02-02 で、read 時点では過ぎている
    // （tick が自動 paused にして人間に resume / retire を問う形になる）
    assert.equal(migrated.goals[0]?.reviewAt, '2026-02-02T00:00:05.000Z')
    assert.ok(reviewPassed(migrated.goals[0] ?? { reviewAt: null }, beforeMs))
    assert.equal(migrated.goals[0]?.objective, 'legacy objective')
    assert.deepEqual(migrated.goals[0]?.scope, ['github:koh110/araya'])
    assert.equal(migrated.goals[0]?.createdAt, '2026-01-01T00:00:00.000Z')
    assert.equal(migrated.goals[0]?.updatedAt, '2026-01-02T00:00:00.000Z')

    // loop は v1 の値を保ち、新しい field だけ埋める
    assert.equal(migrated.loop.lastOccurrenceAt, '2026-01-03T00:00:00.000Z')
    assert.equal(migrated.loop.lastRunAt, '2026-01-03T00:00:05.000Z')
    assert.equal(migrated.loop.lastModelRunAt, '2026-01-03T00:00:05.000Z')
    assert.equal(migrated.loop.lastDigestAt, null)
    assert.equal(migrated.loop.conversationRuns, 0)
    assert.deepEqual(migrated.loop.goalFingerprints, {})
    assert.equal(migrated.loop.conversationId, 11)
    assert.equal(migrated.loop.consecutiveFailures, 2)
    assert.equal(migrated.loop.failureCooldownUntil, null)

    // 既存 run は source 'model'
    assert.equal(migrated.runs[0]?.source, 'model')
    assert.equal(migrated.runs[0]?.occurrenceKey, 'hoot:2026-01-03T00:00:00.000Z')
    assert.equal(migrated.runs[0]?.decidedAt, '2026-01-03T00:00:05.000Z')
    assert.deepEqual(migrated.proposals, [])

    // 読み取りでは file を書き換えない（v1 のまま）
    const fileAfterRead = await readStateFile(fixture.dataDir)
    assert.equal(fileAfterRead.version, 1)
    assert.ok('notifyNoop' in (fileAfterRead.settings as Record<string, unknown>))
    assert.equal('notifyDecisions' in (fileAfterRead.settings as Record<string, unknown>), false)
    const firstRunInFile = (fileAfterRead.runs as Record<string, unknown>[])[0] ?? {}
    assert.equal('source' in firstRunInFile, false)

    // 次の updateHootState で v2 で保存される
    await updateSettings(fixture.dataDir, { tickMinutes: 45 })
    const fileAfterWrite = await readStateFile(fixture.dataDir)
    assert.equal(fileAfterWrite.version, HOOT_STATE_VERSION)
    const persisted = fileAfterWrite.settings as Record<string, unknown>
    assert.equal(persisted.tickMinutes, 45)
    assert.deepEqual(persisted.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS, 'noop'])
    assert.equal('notifyNoop' in persisted, false)
    const persistedGoal = (fileAfterWrite.goals as Record<string, unknown>[])[0] ?? {}
    // migration は file 内容基準（read ごとに期限が動かない）。v2 に保存した値とも一致する
    assert.equal(String(persistedGoal.reviewAt), migrated.goals[0]?.reviewAt)
    assert.equal((fileAfterWrite.runs as Record<string, unknown>[])[0]?.source, 'model')

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.settings.tickMinutes, 45)
    assert.equal(state.goals[0]?.reviewAt, migrated.goals[0]?.reviewAt)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: version 1 migration の notifyNoop=false / 壊れた version 1 の扱い', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeV1File(fixture.dataDir, v1StateFixture({ settings: { notifyNoop: false } }))
    const migrated = await readHootState(fixture.dataDir)
    assert.deepEqual(migrated.settings.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS])

    // v1 settings に notifyNoop が無い file（手で直した / 古い v1）も読める。notifyDecisions は既定
    await writeV1File(fixture.dataDir, {
      ...v1StateFixture(),
      settings: { enabled: false, mode: 'dry_run', tickMinutes: 60, maxRunsPerDay: 8 },
    })
    const withoutFlag = await readHootState(fixture.dataDir)
    assert.equal(withoutFlag.settings.enabled, false)
    assert.deepEqual(withoutFlag.settings.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS])

    // 型が違う notifyNoop は v1 の形として受け付けない
    await writeV1File(fixture.dataDir, v1StateFixture({ settings: { notifyNoop: 'yes' } }))
    await assert.rejects(() => {
      return readHootState(fixture.dataDir)
    }, /hoot_state_invalid/)

    // loop の durable field が壊れた version 1 も誤り
    await writeV1File(
      fixture.dataDir,
      v1StateFixture({
        loop: {
          lastRunAt: null,
          conversationId: 0,
          consecutiveFailures: 0,
          failureCooldownUntil: null,
        },
      }),
    )
    await assert.rejects(() => {
      return readHootState(fixture.dataDir)
    }, /hoot_state_invalid/)

    // proposal の形が壊れた version 2 も誤り（migration で救わない）。file に直接書いて read だけの状態で見る
    await writeV1File(fixture.dataDir, {
      ...defaultState(),
      proposals: [{ ...proposalFixture('broken-proposal'), reminders: -1 }],
    })
    await assert.rejects(() => {
      return readHootState(fixture.dataDir)
    }, /hoot_state_invalid/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: setGoalStatus active は review 期限を過ぎた goal の期限を goalReviewDays だけ伸ばす（次の tick で再 pause しない）', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      goals: [
        goalFixture('expired-goal', { reviewAt: '2026-11-19T08:00:00.000Z' }),
        goalFixture('future-goal', { reviewAt: '2026-12-19T00:00:00.000Z' }),
        goalFixture('none-goal', { reviewAt: null }),
        goalFixture('paused-past-goal', { status: 'paused', reviewAt: '2026-01-01T00:00:00.000Z' }),
      ],
    })

    const nowMs = Date.now()
    const paused = await pauseExpiredGoals(fixture.dataDir, nowMs)
    assert.deepEqual(
      paused.map((goal) => {
        return goal.key
      }),
      ['expired-goal'],
    )

    const resumed = await setGoalStatus(fixture.dataDir, 'expired-goal', 'active')
    const resumedUpdatedAtMs = Date.parse(resumed.updatedAt)
    const resumedReviewAtMs = Date.parse(resumed.reviewAt ?? '')
    // resume は過ぎた期限を settings.goalReviewDays 分だけ伸ばす（これをしないと次の tick で即再 pause になる）
    assert.ok(resumedUpdatedAtMs >= nowMs)
    assert.equal(resumedReviewAtMs, resumedUpdatedAtMs + DEFAULT_GOAL_REVIEW_DAYS * DAY_MS)
    // resume 後は同じ goal を繰り返さない
    const second = await pauseExpiredGoals(fixture.dataDir, Date.now())
    assert.equal(second.length, 0)

    // まだ過ぎていない期限は動かさない
    const future = await setGoalStatus(fixture.dataDir, 'future-goal', 'active')
    assert.equal(future.reviewAt, '2026-12-19T00:00:00.000Z')

    // 無期限の goal は resume でも null のまま（期限を作らない）
    const none = await setGoalStatus(fixture.dataDir, 'none-goal', 'active')
    assert.equal(none.reviewAt, null)

    // pause は review 期限を変えない（resume で決める）
    const pausedAgain = await setGoalStatus(fixture.dataDir, 'expired-goal', 'paused')
    assert.equal(pausedAgain.reviewAt, resumed.reviewAt)

    // goalReviewDays=0 の設定で過ぎた期限を resume するなら無期限に戻す
    await updateSettings(fixture.dataDir, { goalReviewDays: 0 })
    const indefinite = await setGoalStatus(fixture.dataDir, 'paused-past-goal', 'active')
    assert.equal(indefinite.reviewAt, null)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 最近使った version 1 の migration は goal を即 pause しない期限で v2 化する（read ごとに動かない）', async () => {
  const fixture = await makeHootFixture()

  try {
    const recentRunAt = isoUtc(Date.now() - 60_000)

    await writeV1File(
      fixture.dataDir,
      v1StateFixture({
        loop: {
          lastOccurrenceAt: recentRunAt,
          lastRunAt: recentRunAt,
          conversationId: null,
          consecutiveFailures: 0,
          failureCooldownUntil: null,
        },
        goals: [
          {
            key: 'legacy-goal',
            objective: 'legacy objective',
            scope: [],
            constraints: [],
            status: 'active',
            createdAt: recentRunAt,
            updatedAt: recentRunAt,
          },
        ],
      }),
    )

    const migrated = await readHootState(fixture.dataDir)
    const reviewAtMs = Date.parse(migrated.goals[0]?.reviewAt ?? '')
    // 基準は file 内の lastRunAt / goal.updatedAt。最近使った file なら期限は過ぎていない
    assert.equal(reviewAtMs, Date.parse(recentRunAt) + DEFAULT_GOAL_REVIEW_DAYS * DAY_MS)
    assert.ok(reviewAtMs > Date.now())

    const paused = await pauseExpiredGoals(fixture.dataDir, Date.now())
    assert.equal(paused.length, 0)

    const again = await readHootState(fixture.dataDir)
    assert.equal(again.goals[0]?.reviewAt, migrated.goals[0]?.reviewAt)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: goal key / objective / scope / constraint の検証', async () => {
  const fixture = await makeHootFixture()

  try {
    const created = await setGoal(fixture.dataDir, {
      key: 'araya-quality',
      objective: '  更新後の objective  ',
      scope: [' github:koh110/araya ', 'github:koh110/araya', 'local:notes'],
      constraints: ['merge は人間の承認後だけ', 'merge は人間の承認後だけ'],
    })
    assert.equal(created.goal.key, 'araya-quality')
    // trim して重複を除いた entry を goal に保存する（github: でない scope は観測対象にならない）
    assert.deepEqual(created.goal.scope, ['github:koh110/araya', 'local:notes'])
    assert.deepEqual(created.goal.constraints, ['merge は人間の承認後だけ'])
    assert.equal(created.goal.objective, '更新後の objective')

    const invalidGoals: HootGoalInput[] = [
      { key: 'Bad_Key', objective: 'o' },
      { key: '-lead', objective: 'o' },
      { key: 'a'.repeat(65), objective: 'o' },
      { key: '', objective: 'o' },
      { key: 'ok-key', objective: '   ' },
      { key: 'ok-key', objective: 'x'.repeat(1501) },
      {
        key: 'ok-key',
        objective: 'o',
        scope: Array.from({ length: 13 }, (unused, index) => `github:a${index}/b`),
      },
      { key: 'ok-key', objective: 'o', scope: ['x'.repeat(201)] },
      { key: 'ok-key', objective: 'o', constraints: Array.from({ length: 13 }, () => 'c') },
      { key: 'ok-key', objective: 'o', constraints: ['c'.repeat(301)] },
    ]

    for (const input of invalidGoals) {
      await assert.rejects(() => {
        return setGoal(fixture.dataDir, input, { replace: true })
      }, /hoot_goal_invalid/)
    }

    // 誤り之后も state は変わらない（書き込み前に止まる）
    const state = await readHootState(fixture.dataDir)
    assert.deepEqual(
      state.goals.map((goal) => {
        return goal.key
      }),
      ['araya-quality'],
    )

    // goal は最大 MAX_GOALS 件
    for (let index = 0; index < MAX_GOALS - 1; index += 1) {
      await setGoal(fixture.dataDir, { key: `goal-${index}`, objective: 'o' })
    }

    await assert.rejects(() => {
      return setGoal(fixture.dataDir, { key: 'goal-over-limit', objective: 'o' })
    }, /hoot_goal_limit/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: setGoal は settings.goalReviewDays で reviewAt を入れ、更新では保持し none / 日付 / ISO を受け取る', async () => {
  const fixture = await makeHootFixture()

  try {
    await updateSettings(fixture.dataDir, { goalReviewDays: 7 })
    const beforeMs = Date.now()
    const added = await setGoal(fixture.dataDir, { key: 'review-default', objective: 'o' })
    const afterMs = Date.now()
    const reviewAtMs = Date.parse(added.goal.reviewAt ?? '')
    assert.ok(reviewAtMs >= beforeMs + 7 * DAY_MS)
    assert.ok(reviewAtMs <= afterMs + 7 * DAY_MS)

    const kept = await setGoal(
      fixture.dataDir,
      { key: 'review-default', objective: '更新' },
      { replace: true },
    )
    assert.equal(kept.goal.reviewAt, added.goal.reviewAt)

    const dated = await setGoal(fixture.dataDir, {
      key: 'review-date',
      objective: 'o',
      reviewAt: '2026-12-01',
    })
    assert.equal(dated.goal.reviewAt, '2026-12-01T00:00:00.000Z')

    const iso = await setGoal(fixture.dataDir, {
      key: 'review-iso',
      objective: 'o',
      reviewAt: '2026-12-02T09:30:00.000Z',
    })
    assert.equal(iso.goal.reviewAt, '2026-12-02T09:30:00.000Z')

    const none = await setGoal(fixture.dataDir, {
      key: 'review-none',
      objective: 'o',
      reviewAt: 'none',
    })
    assert.equal(none.goal.reviewAt, null)

    const explicitNull = await setGoal(fixture.dataDir, {
      key: 'review-null',
      objective: 'o',
      reviewAt: null,
    })
    assert.equal(explicitNull.goal.reviewAt, null)

    // 更新で 'none' を渡すと無期限に戻す
    const cleared = await setGoal(
      fixture.dataDir,
      { key: 'review-date', objective: '更新', reviewAt: 'none' },
      { replace: true },
    )
    assert.equal(cleared.goal.reviewAt, null)

    await assert.rejects(() => {
      return setGoal(fixture.dataDir, { key: 'review-bad', objective: 'o', reviewAt: 'not-a-date' })
    }, /hoot_goal_invalid/)

    // 不正な reviewAt の更新では既存 goal の期限がそのまま残る
    const state = await readHootState(fixture.dataDir)
    assert.equal(
      state.goals.find((goal) => goal.key === 'review-default')?.reviewAt,
      added.goal.reviewAt,
    )
    assert.equal(
      state.goals.some((goal) => {
        return goal.key === 'review-bad'
      }),
      false,
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: settings.goalReviewDays=0 は 新しい goal を無期限にする', async () => {
  const fixture = await makeHootFixture()

  try {
    const settings = await updateSettings(fixture.dataDir, { goalReviewDays: 0 })
    assert.equal(settings.goalReviewDays, 0)

    const added = await setGoal(fixture.dataDir, { key: 'review-zero', objective: 'o' })
    assert.equal(added.goal.reviewAt, null)

    const state = await readHootState(fixture.dataDir)
    assert.equal(
      state.goals.find((goal) => {
        return goal.key === 'review-zero'
      })?.reviewAt,
      null,
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: pauseExpiredGoals は reviewAt を過ぎた active goal だけ paused にして変更分を返す', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      goals: [
        goalFixture('expired-goal', { reviewAt: '2026-11-19T08:00:00.000Z' }),
        goalFixture('boundary-goal', { reviewAt: '2026-11-19T09:00:00.000Z' }),
        goalFixture('future-goal', { reviewAt: '2026-12-19T00:00:00.000Z' }),
        goalFixture('none-goal', { reviewAt: null }),
        goalFixture('already-paused', { status: 'paused', reviewAt: '2026-11-19T07:00:00.000Z' }),
        goalFixture('retired-goal', { status: 'retired', reviewAt: '2026-11-19T07:00:00.000Z' }),
      ],
    })

    const nowMs = Date.parse('2026-11-19T09:00:00.000Z')
    const paused = await pauseExpiredGoals(fixture.dataDir, nowMs)

    // reviewAt <= now の active だけ。境界（reviewAt === now）も含む
    assert.deepEqual(
      paused.map((goal) => {
        return goal.key
      }),
      ['expired-goal', 'boundary-goal'],
    )
    assert.deepEqual(
      paused.map((goal) => {
        return goal.updatedAt
      }),
      ['2026-11-19T09:00:00.000Z', '2026-11-19T09:00:00.000Z'],
    )
    assert.equal(paused[0]?.reviewAt, '2026-11-19T08:00:00.000Z')

    const state = await readHootState(fixture.dataDir)
    assert.deepEqual(
      state.goals.map((goal) => {
        return `${goal.key}=${goal.status}`
      }),
      [
        'expired-goal=paused',
        'boundary-goal=paused',
        'future-goal=active',
        'none-goal=active',
        'already-paused=paused',
        'retired-goal=retired',
      ],
    )

    // 2 回目以降は変更がない（毎回 paused を返さない）
    const again = await pauseExpiredGoals(fixture.dataDir, nowMs + DAY_MS)
    assert.deepEqual(again, [])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: upsertProposal は同じ key の open を更新し、open 上限と evidence 件数で抑止する', async () => {
  const fixture = await makeHootFixture()

  try {
    const key = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'request_human' })
    const created = await upsertProposal(fixture.dataDir, {
      key,
      decision: 'request_human',
      goalKeys: ['araya-quality', 'araya-quality'],
      reason: '最初の理由',
      occurrenceKey: 'hoot:2026-11-19T08:00:00.000Z',
      nowMs: Date.parse('2026-11-19T08:00:00.000Z'),
    })
    assert.equal(created.created, true)
    assert.equal(created.proposal?.key, key)
    assert.deepEqual(created.proposal?.goalKeys, ['araya-quality'])
    assert.equal(created.proposal?.status, 'open')
    assert.equal(created.proposal?.reminders, 0)
    assert.equal(created.proposal?.lastReminderAt, null)
    assert.equal(
      created.proposal?.expiresAt,
      isoUtc(Date.parse('2026-11-19T08:00:00.000Z') + 72 * HOUR_MS),
    )

    // 同じ key（同じ goal keys + decision）の open は 1 件に寄せる。期限・提醒回数・作成時刻は据え置く
    const merged = await upsertProposal(fixture.dataDir, {
      key,
      decision: 'request_human',
      goalKeys: ['araya-quality'],
      reason: 'x'.repeat(400),
      occurrenceKey: 'hoot:2026-11-19T09:00:00.000Z',
      nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
    })
    assert.equal(merged.created, false)
    assert.equal(merged.proposal?.createdAt, '2026-11-19T08:00:00.000Z')
    assert.equal(merged.proposal?.updatedAt, '2026-11-19T09:00:00.000Z')
    assert.equal(merged.proposal?.expiresAt, created.proposal?.expiresAt)
    assert.equal(merged.proposal?.reminders, 0)
    assert.equal(merged.proposal?.reason, 'x'.repeat(300))
    assert.deepEqual(merged.proposal?.evidenceOccurrenceKeys, [
      'hoot:2026-11-19T08:00:00.000Z',
      'hoot:2026-11-19T09:00:00.000Z',
    ])

    let state = await readHootState(fixture.dataDir)
    assert.equal(state.proposals.length, 1)

    // evidence の occurrence key は新しいものを MAX_PROPOSAL_EVIDENCE_KEYS 件だけ保つ
    for (let index = 3; index <= 14; index += 1) {
      await upsertProposal(fixture.dataDir, {
        key,
        decision: 'request_human',
        goalKeys: ['araya-quality'],
        reason: '同じ状況',
        occurrenceKey: `hoot:${index}`,
        nowMs: Date.parse('2026-11-19T09:30:00.000Z'),
      })
    }

    state = await readHootState(fixture.dataDir)
    const evidence = state.proposals[0]?.evidenceOccurrenceKeys ?? []
    assert.equal(evidence.length, MAX_PROPOSAL_EVIDENCE_KEYS)
    assert.equal(evidence[0], 'hoot:5')
    assert.equal(evidence.at(-1), 'hoot:14')

    // open が MAX_OPEN_PROPOSALS 以上では新しい proposal を作らない（既存の open 更新は続く）
    const openBefore = (await readHootState(fixture.dataDir)).proposals.filter((proposal) => {
      return proposal.status === 'open'
    }).length
    const room = MAX_OPEN_PROPOSALS - openBefore
    assert.ok(room > 0)

    for (let index = 0; index < room + 2; index += 1) {
      const result = await upsertProposal(fixture.dataDir, {
        key: `other-${index}`,
        decision: 'dispatch',
        goalKeys: [`goal-${index}`],
        reason: 'r',
        occurrenceKey: `hoot:other-${index}`,
        nowMs: Date.parse('2026-11-19T10:00:00.000Z'),
      })
      assert.equal(result.created, index < room)
      assert.equal(result.proposal === null, index >= room)
    }

    state = await readHootState(fixture.dataDir)
    const openCount = state.proposals.filter((proposal) => {
      return proposal.status === 'open'
    }).length
    assert.equal(openCount, MAX_OPEN_PROPOSALS)

    const stillUpdated = await upsertProposal(fixture.dataDir, {
      key,
      decision: 'request_human',
      goalKeys: ['araya-quality'],
      reason: '上限後も更新される',
      occurrenceKey: 'hoot:late',
      nowMs: Date.parse('2026-11-19T10:30:00.000Z'),
    })
    assert.equal(stillUpdated.created, false)
    assert.equal(stillUpdated.proposal?.reason, '上限後も更新される')

    // resolved 済みの同じ key は新しい open として作り直す（open 枠を 1 件空けてから確認する）
    const reopenedKey = 'resolved-then-open'
    await resolveProposal(fixture.dataDir, 'other-0', Date.parse('2026-11-19T11:00:00.000Z'))

    const opened = await upsertProposal(fixture.dataDir, {
      key: reopenedKey,
      decision: 'investigate',
      goalKeys: ['goal-x'],
      reason: 'old',
      occurrenceKey: 'hoot:old',
      nowMs: Date.parse('2026-11-19T11:10:00.000Z'),
    })
    assert.equal(opened.created, true)

    await resolveProposal(fixture.dataDir, reopenedKey, Date.parse('2026-11-19T11:20:00.000Z'))

    const reopened = await upsertProposal(fixture.dataDir, {
      key: reopenedKey,
      decision: 'investigate',
      goalKeys: ['goal-x'],
      reason: 'new',
      occurrenceKey: 'hoot:new',
      nowMs: Date.parse('2026-11-19T11:30:00.000Z'),
    })
    assert.equal(reopened.created, true)
    assert.equal(reopened.proposal?.status, 'open')
    assert.equal(reopened.proposal?.reminders, 0)
    assert.equal(reopened.proposal?.createdAt, '2026-11-19T11:30:00.000Z')

    const finalState = await readHootState(fixture.dataDir)
    assert.deepEqual(
      finalState.proposals
        .filter((proposal) => {
          return proposal.key === reopenedKey
        })
        .map((proposal) => {
          return `${proposal.status}:${proposal.reason}`
        }),
      ['resolved:old', 'open:new'],
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: proposal key は decision と goal keys だけから決まる（順序・重複を正規化し fingerprint を含まない）', async () => {
  const fixture = await makeHootFixture()

  try {
    const keyAb = proposalKeyOf({ goalKeys: ['goal-b', 'goal-a'], decision: 'request_human' })
    const keyShuffled = proposalKeyOf({
      goalKeys: ['goal-a', 'goal-b', 'goal-a'],
      decision: 'request_human',
    })
    const keyOtherDecision = proposalKeyOf({
      goalKeys: ['goal-b', 'goal-a'],
      decision: 'investigate',
    })
    const keyOtherGoals = proposalKeyOf({ goalKeys: ['goal-a'], decision: 'request_human' })

    assert.equal(keyAb, keyShuffled)
    assert.notEqual(keyAb, keyOtherDecision)
    assert.notEqual(keyAb, keyOtherGoals)
    assert.match(keyAb, /^[0-9a-f]{16}$/u)

    // goal keys の並びを変えて生成した key も同じ open proposal を更新する（run の fingerprint は key に無関係）
    const first = await upsertProposal(fixture.dataDir, {
      key: keyAb,
      decision: 'request_human',
      goalKeys: ['goal-b', 'goal-a'],
      reason: '初回の理由',
      occurrenceKey: 'hoot:2026-11-19T06:00:00.000Z',
      nowMs: Date.parse('2026-11-19T06:00:00.000Z'),
    })
    const second = await upsertProposal(fixture.dataDir, {
      key: keyShuffled,
      decision: 'request_human',
      goalKeys: ['goal-a', 'goal-b', 'goal-a'],
      reason: '更新後の理由',
      occurrenceKey: 'hoot:2026-11-19T07:00:00.000Z',
      nowMs: Date.parse('2026-11-19T07:00:00.000Z'),
    })

    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.proposal?.key, keyAb)
    assert.deepEqual(second.proposal?.goalKeys, ['goal-a', 'goal-b'])
    assert.equal(second.proposal?.reason, '更新後の理由')
    assert.deepEqual(second.proposal?.evidenceOccurrenceKeys, [
      'hoot:2026-11-19T06:00:00.000Z',
      'hoot:2026-11-19T07:00:00.000Z',
    ])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: upsertProposal は保持上限で closed を古い順に落とし open を残す', async () => {
  const fixture = await makeHootFixture()

  try {
    const proposals = Array.from({ length: MAX_PROPOSALS_KEPT }, (unused, index) => {
      return proposalFixture(`k${String(index).padStart(3, '0')}`, {
        status: index < MAX_PROPOSALS_KEPT - 3 ? 'resolved' : 'open',
      })
    })
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      goals: [goalFixture('araya-quality')],
      proposals,
    })

    const added = await upsertProposal(fixture.dataDir, {
      key: 'brand-new',
      decision: 'dispatch',
      goalKeys: ['araya-quality'],
      reason: 'new',
      occurrenceKey: 'hoot:new',
      nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
    })
    assert.equal(added.created, true)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.proposals.length, MAX_PROPOSALS_KEPT)
    // 先頭の closed（k000）が落ち、open と新しい open は残る
    assert.equal(
      state.proposals.some((proposal) => {
        return proposal.key === 'k000'
      }),
      false,
    )
    const expectedOpen = [
      ...Array.from({ length: 3 }, (unused, index) => {
        return `k${String(MAX_PROPOSALS_KEPT - 3 + index).padStart(3, '0')}`
      }),
      'brand-new',
    ]
    assert.deepEqual(
      state.proposals
        .filter((proposal) => {
          return proposal.status === 'open'
        })
        .map((proposal) => {
          return proposal.key
        }),
      expectedOpen,
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: takeProposalReminder は期限切れを closed にし、backoff で 1 件だけ取り出す', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      proposals: [
        proposalFixture('p-backoff', { expiresAt: '2026-12-19T00:00:00.000Z' }),
        proposalFixture('p-expired', {
          decision: 'dispatch',
          goalKeys: ['other-goal'],
          createdAt: '2026-11-19T07:00:00.000Z',
          expiresAt: '2026-11-19T08:59:00.000Z',
        }),
      ],
    })

    const everyMs = HOUR_MS

    // 期限前（createdAt + everyMs > now）は送らない
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-19T08:59:59.000Z'),
        everyMs,
      }),
      null,
    )

    const first = await takeProposalReminder(fixture.dataDir, {
      nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
      everyMs,
    })
    assert.equal(first?.proposal.key, 'p-backoff')
    assert.equal(first?.reminderIndex, 1)
    assert.equal(first?.proposal.reminders, 1)
    assert.equal(first?.proposal.lastReminderAt, '2026-11-19T09:00:00.000Z')
    assert.equal(first?.proposal.status, 'open')

    // 同じ now では 2 件目を送らない。期限切れの closed は file に書き込まれる
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
        everyMs,
      }),
      null,
    )
    let state = await readHootState(fixture.dataDir)
    assert.equal(
      state.proposals.find((proposal) => proposal.key === 'p-expired')?.status,
      'expired',
    )

    // backoff は everyMs * 2 ** reminders（60 分 → 120 分 → 240 分）
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-19T10:59:00.000Z'),
        everyMs,
      }),
      null,
    )

    const second = await takeProposalReminder(fixture.dataDir, {
      nowMs: Date.parse('2026-11-19T11:00:00.000Z'),
      everyMs,
    })
    assert.equal(second?.reminderIndex, 2)
    assert.equal(second?.proposal.reminders, 2)

    const third = await takeProposalReminder(fixture.dataDir, {
      nowMs: Date.parse('2026-11-19T15:00:00.000Z'),
      everyMs,
    })
    assert.equal(third?.reminderIndex, 3)
    assert.equal(third?.proposal.reminders, 3)

    // maxProposalReminders（既定 3）を超えたら送らない
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-19T23:00:00.000Z'),
        everyMs,
      }),
      null,
    )

    state = await readHootState(fixture.dataDir)
    assert.deepEqual(
      state.proposals.map((proposal) => {
        return `${proposal.key}=${proposal.status}/${proposal.reminders}`
      }),
      ['p-backoff=open/3', 'p-expired=expired/0'],
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: takeProposalReminder は maxProposalReminders=0 で送らない（期限切れの closed 更新は行う）', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      settings: { ...defaultSettings(), maxProposalReminders: 0 },
      proposals: [
        proposalFixture('p-zero', { decision: 'dispatch', expiresAt: '2026-11-19T08:30:00.000Z' }),
      ],
    })

    const taken = await takeProposalReminder(fixture.dataDir, {
      nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
      everyMs: HOUR_MS,
    })
    assert.equal(taken, null)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.proposals[0]?.status, 'expired')
    assert.equal(state.proposals[0]?.reminders, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: resolveProposal は open を resolved にし、open が無い key は hoot_proposal_not_found', async () => {
  const fixture = await makeHootFixture()

  try {
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      proposals: [
        proposalFixture('p-open', { reminders: 2, lastReminderAt: '2026-11-19T08:40:00.000Z' }),
        proposalFixture('p-expiring', { status: 'open', expiresAt: '2026-11-19T08:30:00.000Z' }),
      ],
    })

    const resolved = await resolveProposal(
      fixture.dataDir,
      'p-open',
      Date.parse('2026-11-19T09:00:00.000Z'),
    )
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.updatedAt, '2026-11-19T09:00:00.000Z')
    assert.equal(resolved.reason, '優先順位を決めてください')

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.proposals.find((proposal) => proposal.key === 'p-open')?.status, 'resolved')

    // 同じ key をもう resolve できない（open だけでは探す）
    await assert.rejects(() => {
      return resolveProposal(fixture.dataDir, 'p-open')
    }, /hoot_proposal_not_found/)

    await assert.rejects(() => {
      return resolveProposal(fixture.dataDir, 'missing-key')
    }, /hoot_proposal_not_found/)

    // 期限切れの open も resolve 対象にならない（takeProposalReminder で closed になる）
    await takeProposalReminder(fixture.dataDir, {
      nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
      everyMs: HOUR_MS,
    })
    await assert.rejects(() => {
      return resolveProposal(fixture.dataDir, 'p-expiring')
    }, /hoot_proposal_not_found/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: recordHootDigest は loop.lastDigestAt を書き UTC 日の key を返す', async () => {
  const fixture = await makeHootFixture()

  try {
    const nowMs = Date.parse('2026-11-19T21:05:00.000Z')
    const day = await recordHootDigest(fixture.dataDir, nowMs)
    assert.equal(day, utcDayKey(nowMs))
    assert.equal(day, '2026-11-19')

    let state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.lastDigestAt, '2026-11-19T21:05:00.000Z')

    // 同じ UTC 日でも記録は更新される（1 日 1 回の抑止は tick 側の lastDigestAt 比較）
    const sameDay = await recordHootDigest(fixture.dataDir, Date.parse('2026-11-19T22:00:00.000Z'))
    assert.equal(sameDay, '2026-11-19')
    state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.lastDigestAt, '2026-11-19T22:00:00.000Z')

    const nextDay = await recordHootDigest(fixture.dataDir, Date.parse('2026-11-20T00:10:00.000Z'))
    assert.equal(nextDay, '2026-11-20')
    state = await readHootState(fixture.dataDir)
    assert.equal(state.loop.lastDigestAt, '2026-11-20T00:10:00.000Z')
    // digest 記録は schedule・run・proposal を壊さない
    assert.equal(state.loop.lastOccurrenceAt, null)
    assert.deepEqual(state.proposals, [])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: investigate proposal も inject request になる（人間の承認 / autoDispatch gate）', async () => {
  const fixture = await makeHootFixture()
  const investigateKey = proposalKeyOf({ goalKeys: ['quality'], decision: 'investigate' })
  const requestHumanKey = proposalKeyOf({ goalKeys: ['quality'], decision: 'request_human' })

  try {
    await setGoal(fixture.dataDir, {
      key: 'quality',
      objective: 'quality の objective',
      scope: ['github:koh110/araya'],
    })
    for (const [key, decision] of [
      [investigateKey, 'investigate'],
      [requestHumanKey, 'request_human'],
    ] as const) {
      await upsertProposal(fixture.dataDir, {
        key,
        decision,
        goalKeys: ['quality'],
        reason: `${decision} の理由`,
        occurrenceKey: 'hoot:2026-11-20T00:00:00.000Z',
        nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
      })
    }

    // dry_run では investigate でも request を作らない
    await assert.rejects(() => {
      return enqueueHootInject(fixture.dataDir, {
        proposalKey: investigateKey,
        authorizedBy: 'human',
        nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
      })
    }, /hoot_mode_dry_run/)

    await updateSettings(fixture.dataDir, { mode: 'active' })

    // autoDispatch=false の限り mode=active でも自動では作らない
    const auto = await enqueueHootInject(fixture.dataDir, {
      proposalKey: investigateKey,
      authorizedBy: 'mode_active',
      nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
    })
    assert.equal(auto.request, null)
    assert.equal(auto.skipped, 'auto_dispatch_off')

    const enqueued = await enqueueHootInject(fixture.dataDir, {
      proposalKey: investigateKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
    })
    assert.equal(enqueued.request?.proposalKey, investigateKey)
    assert.equal(enqueued.request?.status, 'pending')
    assert.equal(enqueued.request?.authorizedBy, 'human')

    await assert.rejects(() => {
      return enqueueHootInject(fixture.dataDir, {
        proposalKey: requestHumanKey,
        authorizedBy: 'human',
        nowMs: Date.parse('2026-11-20T02:30:00.000Z'),
      })
    }, /hoot_inject_not_injectable/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: inject request は mode gate・cooldown・daily limit・pending 重複で作り、take / finish で status を進める', async () => {
  const fixture = await makeHootFixture()
  const proposalKey = proposalKeyOf({ goalKeys: ['quality'], decision: 'dispatch' })
  const otherKey = proposalKeyOf({ goalKeys: ['docs'], decision: 'dispatch' })
  const requestHumanKey = proposalKeyOf({ goalKeys: ['quality'], decision: 'request_human' })

  try {
    await setGoal(fixture.dataDir, {
      key: 'quality',
      objective: 'quality の objective',
      scope: ['github:koh110/araya'],
    })
    await setGoal(fixture.dataDir, {
      key: 'docs',
      objective: 'docs の objective',
      scope: ['github:koh110/araya'],
    })

    for (const [key, decision] of [
      [proposalKey, 'dispatch'],
      [otherKey, 'dispatch'],
      [requestHumanKey, 'request_human'],
    ] as const) {
      await upsertProposal(fixture.dataDir, {
        key,
        decision,
        goalKeys: decision === 'dispatch' && key === otherKey ? ['docs'] : ['quality'],
        reason: `${decision} の理由`,
        occurrenceKey: 'hoot:2026-11-20T00:00:00.000Z',
        nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
      })
    }

    // dry_run では request さえ作らない（mode=active のときだけ inject を考える）
    await assert.rejects(() => {
      return enqueueHootInject(fixture.dataDir, {
        proposalKey,
        authorizedBy: 'human',
        nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
      })
    }, /hoot_mode_dry_run/)

    await updateSettings(fixture.dataDir, { mode: 'active' })

    // autoDispatch=false の限り mode=active でも request は作らない
    const auto = await enqueueHootInject(fixture.dataDir, {
      proposalKey,
      authorizedBy: 'mode_active',
      nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
    })
    assert.equal(auto.request, null)
    assert.equal(auto.skipped, 'auto_dispatch_off')

    const enqueued = await enqueueHootInject(fixture.dataDir, {
      proposalKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
    })
    assert.equal(enqueued.skipped, null)
    const request = enqueued.request
    assert.notEqual(request, null)
    assert.equal(request?.status, 'pending')
    assert.equal(request?.attempts, 0)
    assert.equal(request?.authorizedBy, 'human')
    assert.equal(request?.decision, 'dispatch')
    assert.deepEqual(request?.goalKeys, ['quality'])
    assert.equal(request?.requestId, request?.key)

    // 同じ proposal に pending の間は重ねて作らない
    const again = await enqueueHootInject(fixture.dataDir, {
      proposalKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T01:10:00.000Z'),
    })
    assert.equal(again.request, null)
    assert.equal(again.skipped, 'already_pending')

    await assert.rejects(() => {
      return enqueueHootInject(fixture.dataDir, {
        proposalKey: 'hoot-prop-missing',
        authorizedBy: 'human',
        nowMs: Date.parse('2026-11-20T01:20:00.000Z'),
      })
    }, /hoot_proposal_not_found/)

    // inject してよい decision は dispatch / investigate（request_human は人間への依頼なので提案のまま）
    await assert.rejects(() => {
      return enqueueHootInject(fixture.dataDir, {
        proposalKey: requestHumanKey,
        authorizedBy: 'human',
        nowMs: Date.parse('2026-11-20T01:20:00.000Z'),
      })
    }, /hoot_inject_not_injectable/)

    // take は attempts を 1 増やす。requestId は attempt を含まないので、再試行でも同じ dedupe key
    // （Pi durable が同じ dispatch を 2 度走らせない）
    const taken = await takePendingInject(fixture.dataDir, Date.parse('2026-11-20T02:10:00.000Z'))
    assert.equal(taken?.key, request?.key)
    assert.equal(taken?.attempts, 1)
    assert.equal(taken?.requestId, request?.key)
    assert.equal(taken?.requestId, request?.requestId)

    // 失敗はまだ上限（2 attempt）に達していないので pending に戻す
    const failedOnce = await finishHootInject(fixture.dataDir, request?.key ?? '', {
      ok: false,
      nowMs: Date.parse('2026-11-20T02:11:00.000Z'),
      error: 'gateway closed',
    })
    assert.equal(failedOnce.request.status, 'pending')
    assert.equal(failedOnce.request.attempts, 1)
    assert.equal(failedOnce.request.lastError, 'gateway closed')
    // 失敗では proposal を open のまま残す（人間が dispatch をやり直せる）
    assert.equal(failedOnce.proposalResolved, false)

    const takenAgain = await takePendingInject(
      fixture.dataDir,
      Date.parse('2026-11-20T02:12:00.000Z'),
    )
    assert.equal(takenAgain?.attempts, 2)
    assert.equal(takenAgain?.requestId, request?.key)

    // 上限に達した失敗は failed。failed は next poll で選ばれない
    const failedTwice = await finishHootInject(fixture.dataDir, request?.key ?? '', {
      ok: false,
      nowMs: Date.parse('2026-11-20T02:13:00.000Z'),
      error: 'session stopped',
    })
    assert.equal(failedTwice.request.status, 'failed')
    assert.equal(failedTwice.request.attempts, MAX_INJECT_ATTEMPTS)
    assert.equal(failedTwice.proposalResolved, false)
    assert.equal(
      await takePendingInject(fixture.dataDir, Date.parse('2026-11-20T02:14:00.000Z')),
      null,
    )

    // cooldown（120 分に伸ばした）は同じ proposal への新しい request も抑える
    await updateSettings(fixture.dataDir, { injectCooldownMinutes: 120 })
    const cooling = await enqueueHootInject(fixture.dataDir, {
      proposalKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T02:20:00.000Z'),
    })
    assert.equal(cooling.request, null)
    assert.equal(cooling.skipped, 'cooldown')

    // cooldown を過ぎると key の index が上がる（pending かどうかは無関係に 1 案件 1 key）
    const later = await enqueueHootInject(fixture.dataDir, {
      proposalKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T05:00:00.000Z'),
    })
    assert.equal(later.skipped, null)
    assert.notEqual(later.request?.key, request?.key)
    assert.match(later.request?.key ?? '', /:2$/u)

    // 注入成功: injected になり lastError を消す
    const injectedTaken = await takePendingInject(
      fixture.dataDir,
      Date.parse('2026-11-20T05:01:00.000Z'),
    )
    assert.equal(injectedTaken?.key, later.request?.key)
    const injected = await finishHootInject(fixture.dataDir, later.request?.key ?? '', {
      ok: true,
      nowMs: Date.parse('2026-11-20T05:01:30.000Z'),
    })
    assert.equal(injected.request.status, 'injected')
    assert.equal(injected.request.injectedAt, '2026-11-20T05:01:30.000Z')
    assert.equal(injected.request.lastError, null)
    // delivery が届いた proposal は open に戻さない（再提醒と「未完了 pending」を止める）
    assert.equal(injected.proposalResolved, true)

    const injectedState = await readHootState(fixture.dataDir)
    assert.deepEqual(
      injectedState.proposals
        .filter((entry) => {
          return entry.key === proposalKey
        })
        .map((entry) => {
          return entry.status
        }),
      ['resolved'],
    )

    // daily limit は人間の承認も数える（cooldown を切って別の proposal で試す）
    await updateSettings(fixture.dataDir, { injectCooldownMinutes: 0 })
    const overLimit = await enqueueHootInject(fixture.dataDir, {
      proposalKey: otherKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T05:30:00.000Z'),
    })
    assert.equal(overLimit.request, null)
    assert.equal(overLimit.skipped, 'daily_limit')

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests.length, 2)
    assert.deepEqual(
      state.injectRequests.map((entry) => {
        return entry.status
      }),
      ['failed', 'injected'],
    )
    // inject の記録は schedule・proposal・run を壊さない
    assert.equal(state.proposals.length, 3)
    assert.equal(state.loop.lastOccurrenceAt, null)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: inject request は直近保持で prune しても pending を落とさない', async () => {
  const fixture = await makeHootFixture()

  try {
    await updateSettings(fixture.dataDir, {
      mode: 'active',
      injectCooldownMinutes: 0,
      maxInjectsPerDay: 10,
    })

    // 満杯の injected 記録を直接書いてから新しい pending を足す
    const old: HootInjectRequest[] = []

    for (let index = 0; index < MAX_INJECTS_KEPT; index += 1) {
      old.push({
        key: `hoot-inject:old:${index}`,
        requestId: `hoot-inject:old:${index}`,
        proposalKey: `hoot-prop-old:${index}`,
        decision: 'dispatch',
        goalKeys: ['quality'],
        authorizedBy: 'human',
        authorizedAt: `2026-11-19T0${index % 10}:00:00.000Z`,
        status: 'injected',
        attempts: 1,
        createdAt: `2026-11-19T0${index % 10}:00:00.000Z`,
        updatedAt: `2026-11-19T0${index % 10}:00:05.000Z`,
        injectedAt: `2026-11-19T0${index % 10}:00:05.000Z`,
        lastError: null,
      })
    }

    await updateHootState(fixture.dataDir, (state) => {
      state.injectRequests = old

      return state.injectRequests
    })

    await setGoal(fixture.dataDir, { key: 'quality', objective: 'quality の objective' })
    await upsertProposal(fixture.dataDir, {
      key: 'hoot-prop-new',
      decision: 'dispatch',
      goalKeys: ['quality'],
      reason: '新しい dispatch',
      occurrenceKey: 'hoot:2026-11-20T00:00:00.000Z',
      nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
    })

    const enqueued = await enqueueHootInject(fixture.dataDir, {
      proposalKey: 'hoot-prop-new',
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T01:00:00.000Z'),
    })
    assert.notEqual(enqueued.request, null)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests.length, MAX_INJECTS_KEPT)
    assert.equal(state.injectRequests.at(-1)?.key, enqueued.request?.key)
    // 古い pending はないので先頭（一番古い injected）から落とす
    assert.equal(state.injectRequests[0]?.key, 'hoot-inject:old:1')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: version 2 の state file は読み取り時に v3 へ寄す（read ごとに reviewAt などの値を動かさない）', async () => {
  const fixture = await makeHootFixture()
  const v2State = {
    version: HOOT_STATE_VERSION_INJECT,
    settings: {
      enabled: true,
      mode: 'dry_run',
      tickMinutes: 30,
      maxRunsPerDay: 5,
      notifyDecisions: ['request_human', 'invalid'],
      precheckObservation: true,
      watchdogHours: 24,
      digestHourUtc: 21,
      resetConversationAfterRuns: 40,
      goalReviewDays: 30,
      proposalTtlHours: 72,
      maxProposalReminders: 3,
    },
    goals: [
      {
        key: 'legacy-two',
        objective: 'legacy two objective',
        scope: ['github:koh110/araya'],
        constraints: ['production deploy は人間だけ'],
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        reviewAt: '2026-12-01T00:00:00.000Z',
      },
    ],
    loop: {
      lastOccurrenceAt: '2026-11-19T00:00:00.000Z',
      lastRunAt: '2026-11-19T00:00:05.000Z',
      conversationId: 21,
      consecutiveFailures: 0,
      failureCooldownUntil: null,
      lastModelRunAt: '2026-11-19T00:00:05.000Z',
      lastDigestAt: null,
      conversationRuns: 3,
      goalFingerprints: { 'legacy-two': 'fingerprint-1' },
    },
    runs: [],
    proposals: [],
  }

  try {
    await fs.mkdir(path.join(fixture.dataDir, 'hoot'), { recursive: true })
    await fs.writeFile(hootStateFilePath(fixture.dataDir), JSON.stringify(v2State), 'utf8')

    const first = await readHootState(fixture.dataDir)
    assert.equal(first.version, HOOT_STATE_VERSION)
    assert.deepEqual(first.injectRequests, [])
    assert.equal(first.settings.autoDispatch, false)
    assert.equal(first.settings.maxInjectsPerDay, DEFAULT_MAX_INJECTS_PER_DAY)
    assert.equal(first.settings.injectCooldownMinutes, DEFAULT_INJECT_COOLDOWN_MINUTES)
    assert.equal(first.goals[0]?.reviewAt, '2026-12-01T00:00:00.000Z')
    assert.equal(first.loop.conversationRuns, 3)

    // 読み取りでは file を書き換えない（version を上げた file を作り直さない）
    const raw = JSON.parse(await fs.readFile(hootStateFilePath(fixture.dataDir), 'utf8')) as {
      version: number
    }
    assert.equal(raw.version, HOOT_STATE_VERSION_INJECT)

    // 再読込みでも値が動かない（read ごとに deadline を作り直さない）
    const second = await readHootState(fixture.dataDir)
    assert.deepEqual(second, first)

    // 次の update で v3 として保存される
    await resetSchedule(fixture.dataDir)
    const saved = JSON.parse(await fs.readFile(hootStateFilePath(fixture.dataDir), 'utf8')) as {
      version: number
      settings: Record<string, unknown>
    }
    assert.equal(saved.version, HOOT_STATE_VERSION)
    assert.equal(saved.settings.autoDispatch, false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: version 3 の state file は migration で conversationRead と conversationReads を得る', async () => {
  const fixture = await makeHootFixture()

  try {
    // 旧 process が書いた version 3（conversationRead も conversationReads も無い）をそのまま置く
    const legacyRun = {
      occurrenceKey: 'hoot:2026-11-19T08:00:00.000Z',
      plannedAt: '2026-11-19T08:00:00.000Z',
      decidedAt: '2026-11-19T08:00:01.000Z',
      source: 'model',
      decision: 'noop',
      reason: '変化なし',
      summary: '',
      goalKeys: [],
      missedOccurrences: 0,
      dispatched: false,
      observedRepos: [],
      observationGaps: [],
    }
    const legacyState = {
      version: 3,
      settings: {
        enabled: true,
        mode: 'active',
        tickMinutes: 15,
        maxRunsPerDay: 4,
        notifyDecisions: ['dispatch', 'request_human'],
        precheckObservation: true,
        watchdogHours: 6,
        digestHourUtc: null,
        resetConversationAfterRuns: 20,
        goalReviewDays: 14,
        proposalTtlHours: 72,
        maxProposalReminders: 2,
        autoDispatch: true,
        maxInjectsPerDay: 3,
        injectCooldownMinutes: 30,
      },
      goals: [],
      runs: [legacyRun],
      proposals: [],
      injectRequests: [],
      loop: {
        lastOccurrenceAt: null,
        lastRunAt: null,
        conversationId: 9,
        conversationRuns: 1,
        consecutiveFailures: 0,
        failureCooldownUntil: null,
        goalFingerprints: {},
        lastModelRunAt: null,
        lastDigestAt: null,
      },
    }
    await fs.mkdir(path.join(fixture.dataDir, 'hoot'), { recursive: true })
    await fs.writeFile(hootStateFilePath(fixture.dataDir), JSON.stringify(legacyState), 'utf8')

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.version, HOOT_STATE_VERSION)
    // 新しい permission は既定で off。旧 file の enabled / mode はそのまま保つ
    assert.equal(state.settings.conversationRead, false)
    assert.equal(state.settings.enabled, true)
    assert.equal(state.settings.mode, 'active')
    assert.equal(state.settings.autoDispatch, true)
    assert.deepEqual(state.runs[0]?.conversationReads, { calls: 0, entries: 0, chars: 0 })
    assert.equal(state.loop.conversationId, 9)

    // 読み取りだけでは file を書き換えない（古い process と混ぜても壊さない）
    const before = JSON.parse(await fs.readFile(hootStateFilePath(fixture.dataDir), 'utf8')) as {
      version: number
    }
    assert.equal(before.version, 3)

    // 人間が tool を有効化する update で version 4 として保存される
    const updated = await updateSettings(fixture.dataDir, { conversationRead: true })
    assert.equal(updated.conversationRead, true)
    const after = JSON.parse(await fs.readFile(hootStateFilePath(fixture.dataDir), 'utf8')) as {
      version: number
      runs: { conversationReads?: { calls: number } }[]
    }
    assert.equal(after.version, HOOT_STATE_VERSION)
    assert.equal(after.runs[0]?.conversationReads?.calls, 0)
    assert.equal((await readHootState(fixture.dataDir)).settings.conversationRead, true)

    // 無効化も元に戻せる
    const disabled = await updateSettings(fixture.dataDir, { conversationRead: false })
    assert.equal(disabled.conversationRead, false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: conversationRead settings の validation と per-run の read 記録', async () => {
  const fixture = await makeHootFixture()

  try {
    const state = await readHootState(fixture.dataDir)
    assert.equal(state.settings.conversationRead, false)

    await assert.rejects(async () => {
      return await updateSettings(fixture.dataDir, {
        conversationRead: 'yes' as unknown as boolean,
      })
    }, /hoot_settings_invalid: conversationRead/u)

    // 判断 run の tool 使用実績は run ごとに記録し、次の run に引き継がない
    await recordHootRun(fixture.dataDir, {
      occurrenceKey: 'hoot:2026-11-19T08:00:00.000Z',
      plannedAt: '2026-11-19T08:00:00.000Z',
      decidedAt: '2026-11-19T08:00:01.000Z',
      source: 'model',
      decision: 'wait',
      reason: 'main 会話を確認した',
      summary: '',
      goalKeys: [],
      missedOccurrences: 0,
      dispatched: false,
      observedRepos: [],
      observationGaps: [],
      conversationReads: { calls: 3, entries: 12, chars: 4_200 },
    })
    await recordHootRun(fixture.dataDir, {
      occurrenceKey: 'hoot:2026-11-19T08:05:00.000Z',
      plannedAt: '2026-11-19T08:05:00.000Z',
      decidedAt: '2026-11-19T08:05:01.000Z',
      source: 'model',
      decision: 'noop',
      reason: '変化なし',
      summary: '',
      goalKeys: [],
      missedOccurrences: 0,
      dispatched: false,
      observedRepos: [],
      observationGaps: [],
      conversationReads: { calls: 0, entries: 0, chars: 0 },
    })

    const after = await readHootState(fixture.dataDir)
    assert.deepEqual(after.runs[0]?.conversationReads, { calls: 3, entries: 12, chars: 4_200 })
    assert.deepEqual(after.runs[1]?.conversationReads, { calls: 0, entries: 0, chars: 0 })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
test('hoot store: inject の delivery で open proposal を resolved にし、人間の再 dispatch は同じ key を open にやり直す', async () => {
  const fixture = await makeHootFixture()

  try {
    await updateSettings(fixture.dataDir, {
      mode: 'active',
      injectCooldownMinutes: 0,
      maxInjectsPerDay: 10,
    })

    const key = proposalKeyOf({ goalKeys: ['quality'], decision: 'investigate' })
    await upsertProposal(fixture.dataDir, {
      key,
      decision: 'investigate',
      goalKeys: ['quality'],
      reason: 'open issue の再現条件を読む',
      occurrenceKey: 'hoot:2026-11-20T00:00:00.000Z',
      nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
    })

    const enqueued = await enqueueHootInject(fixture.dataDir, {
      proposalKey: key,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T00:10:00.000Z'),
    })
    assert.equal(enqueued.skipped, null)

    const settled = await finishHootInject(fixture.dataDir, enqueued.request?.key ?? '', {
      ok: true,
      nowMs: Date.parse('2026-11-20T00:11:00.000Z'),
    })
    assert.equal(settled.proposalResolved, true)

    const delivered = await readHootState(fixture.dataDir)
    assert.deepEqual(
      delivered.proposals.map((entry) => {
        return `${entry.status}:${entry.reminders}`
      }),
      ['resolved:0'],
    )
    // resolved は pending ではないので再提醒走らない
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-21T00:00:00.000Z'),
        everyMs: HOUR_MS,
      }),
      null,
    )

    // 人間が同じ案件を承認し直すと open にやり直す（期限・提醒は新しいものになる）。key の index は上がる
    const again = await enqueueHootInject(fixture.dataDir, {
      proposalKey: key,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-21T01:00:00.000Z'),
    })
    assert.equal(again.skipped, null)
    assert.match(again.request?.key ?? '', /:2$/u)

    const revived = await readHootState(fixture.dataDir)
    const sameKey = revived.proposals.filter((entry) => {
      return entry.key === key
    })
    assert.equal(sameKey.length, 1)
    assert.equal(sameKey[0]?.status, 'open')
    assert.equal(sameKey[0]?.createdAt, '2026-11-21T01:00:00.000Z')
    assert.equal(sameKey[0]?.expiresAt, '2026-11-24T01:00:00.000Z')
    assert.equal(sameKey[0]?.reminders, 0)
    assert.equal(sameKey[0]?.lastReminderAt, null)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: 同じ key に open と closed が並ぶとき dispatch は open を選び、expired だけなら誤りにする', async () => {
  const fixture = await makeHootFixture()

  try {
    await updateSettings(fixture.dataDir, {
      mode: 'active',
      injectCooldownMinutes: 0,
      maxInjectsPerDay: 10,
    })

    const key = proposalKeyOf({ goalKeys: ['quality'], decision: 'dispatch' })
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      settings: { ...defaultState().settings, mode: 'active', injectCooldownMinutes: 0, maxInjectsPerDay: 10 },
      proposals: [
        proposalFixture(key, { decision: 'dispatch', goalKeys: ['quality'], status: 'resolved' }),
        proposalFixture(key, {
          decision: 'dispatch',
          goalKeys: ['quality'],
          status: 'open',
          createdAt: '2026-11-20T02:00:00.000Z',
          updatedAt: '2026-11-20T02:00:00.000Z',
          reason: '新しい観測で再提案された',
        }),
      ],
    })

    const enqueued = await enqueueHootInject(fixture.dataDir, {
      proposalKey: key,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T02:10:00.000Z'),
    })
    assert.equal(enqueued.skipped, null)

    const state = await readHootState(fixture.dataDir)
    assert.deepEqual(
      state.proposals.map((entry) => {
        return entry.status
      }),
      ['resolved', 'open'],
    )

    // expired だけの key は承認できない（open に戻さない）
    await writeHootState(fixture.dataDir, {
      ...state,
      proposals: [proposalFixture(key, { decision: 'dispatch', goalKeys: ['quality'], status: 'expired' })],
      injectRequests: [],
    })

    await assert.rejects(() => {
      return enqueueHootInject(fixture.dataDir, {
        proposalKey: key,
        authorizedBy: 'human',
        nowMs: Date.parse('2026-11-20T03:00:00.000Z'),
      })
    }, /hoot_proposal_not_found.*status: expired/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot store: pending inject が入った open proposal は再提醒を抑止し、inject が failed で戻る', async () => {
  const fixture = await makeHootFixture()

  try {
    await updateSettings(fixture.dataDir, {
      mode: 'active',
      injectCooldownMinutes: 0,
      maxInjectsPerDay: 10,
      maxProposalReminders: 3,
    })

    const key = proposalKeyOf({ goalKeys: ['quality'], decision: 'investigate' })
    await upsertProposal(fixture.dataDir, {
      key,
      decision: 'investigate',
      goalKeys: ['quality'],
      reason: 'read-only で再現条件を確認する',
      occurrenceKey: 'hoot:2026-11-20T00:00:00.000Z',
      nowMs: Date.parse('2026-11-20T00:00:00.000Z'),
    })

    const enqueued = await enqueueHootInject(fixture.dataDir, {
      proposalKey: key,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-20T00:10:00.000Z'),
    })
    assert.equal(enqueued.skipped, null)

    // main 会話へ渡す列に入っている間は提醒しない
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-20T10:00:00.000Z'),
        everyMs: HOUR_MS,
      }),
      null,
    )

    // attempts 上限（2 回）まで失敗させて failed にする（pending inject が無くなるまで抑止が続く）
    let failed = await finishHootInject(
      fixture.dataDir,
      (await takePendingInject(fixture.dataDir, Date.parse('2026-11-20T10:10:00.000Z')))?.key ?? '',
      {
        ok: false,
        nowMs: Date.parse('2026-11-20T10:11:00.000Z'),
        error: 'gateway closed',
      },
    )
    assert.equal(failed.request.status, 'pending')
    assert.equal(failed.proposalResolved, false)
    assert.equal(
      await takeProposalReminder(fixture.dataDir, {
        nowMs: Date.parse('2026-11-20T10:30:00.000Z'),
        everyMs: HOUR_MS,
      }),
      null,
    )

    failed = await finishHootInject(
      fixture.dataDir,
      (await takePendingInject(fixture.dataDir, Date.parse('2026-11-20T10:20:00.000Z')))?.key ?? '',
      {
        ok: false,
        nowMs: Date.parse('2026-11-20T10:21:00.000Z'),
        error: 'session stopped',
      },
    )
    assert.equal(failed.request.status, 'failed')
    assert.equal(failed.proposalResolved, false)

    // pending が無くなったので提醒が走る（proposal は open のまま）
    const reminder = await takeProposalReminder(fixture.dataDir, {
      nowMs: Date.parse('2026-11-20T11:00:00.000Z'),
      everyMs: HOUR_MS,
    })
    assert.equal(reminder?.proposal.key, key)
    assert.equal(reminder?.reminderIndex, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
