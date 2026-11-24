import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseHootArguments, runHootCommand } from './hoot-commands.ts'
import { readHootState, upsertProposal, writeHootState } from '../hoot/store.ts'
import {
  DEFAULT_NOTIFY_DECISIONS,
  defaultState,
  proposalKeyOf,
  type HootProposal,
  type HootRun,
  type HootState,
} from '../hoot/model.ts'
import { createHootLoop } from '../hoot/tick.ts'
import { collectSecretValues, createRedactor } from '../infrastructure/redaction.ts'

const HOOT_NOW_ISO = '2026-11-19T09:00:00.000Z'

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
          return Date.parse(HOOT_NOW_ISO)
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

function proposalFixture(key: string, overrides: Partial<HootProposal> = {}): HootProposal {
  return {
    key,
    decision: 'request_human',
    goalKeys: ['araya-quality'],
    reason: '優先順位を決めてください',
    createdAt: '2026-11-19T08:00:00.000Z',
    updatedAt: '2026-11-19T08:00:00.000Z',
    lastReminderAt: null,
    reminders: 1,
    expiresAt: '2026-11-22T08:00:00.000Z',
    status: 'open',
    evidenceOccurrenceKeys: ['hoot:2026-11-19T08:00:00.000Z'],
    ...overrides,
  }
}

function runFixture(occurrenceKey: string, overrides: Partial<HootRun> = {}): HootRun {
  const plannedAt = occurrenceKey.replace('hoot:', '')

  return {
    occurrenceKey,
    plannedAt,
    decidedAt: plannedAt.replace('T00:00:00', 'T00:00:01'),
    source: 'model',
    decision: 'noop',
    reason: '変化なし',
    summary: '',
    goalKeys: ['araya-quality'],
    missedOccurrences: 0,
    dispatched: false,
    observedRepos: ['koh110/araya'],
    observationGaps: [],
        conversationReads: { calls: 0, entries: 0, chars: 0 },
...overrides,
  }
}

test('hoot cli: 引数の解析（positional と --key value、新しい flag）', () => {
  const parsed = parseHootArguments(['goal', 'add', '--key', 'araya-quality', '--objective', 'a b c', '--scope', 'github:a/b'])
  assert.deepEqual(parsed.positionals, ['goal', 'add'])
  assert.deepEqual(parsed.options, { key: 'araya-quality', objective: 'a b c', scope: 'github:a/b' })

  const reviewAt = parseHootArguments(['goal', 'update', '--key', 'araya-quality', '--objective', 'o', '--review-at', 'none'])
  assert.deepEqual(reviewAt.positionals, ['goal', 'update'])
  assert.deepEqual(reviewAt.options, { key: 'araya-quality', objective: 'o', 'review-at': 'none' })

  const settingsFlags = parseHootArguments([
    'settings',
    'set',
    '--notify-decisions',
    'noop,wait',
    '--precheck',
    'false',
    '--watchdog-hours',
    '12',
    '--digest-hour-utc',
    'none',
    '--reset-conversation-after-runs',
    '5',
    '--goal-review-days',
    '14',
    '--proposal-ttl-hours',
    '24',
    '--max-proposal-reminders',
    '1',
    '--auto-dispatch',
    'true',
    '--max-injects-per-day',
    '3',
    '--inject-cooldown-minutes',
    '15',
  ])
  assert.deepEqual(settingsFlags.positionals, ['settings', 'set'])
  assert.deepEqual(settingsFlags.options, {
    'notify-decisions': 'noop,wait',
    precheck: 'false',
    'watchdog-hours': '12',
    'digest-hour-utc': 'none',
    'reset-conversation-after-runs': '5',
    'goal-review-days': '14',
    'proposal-ttl-hours': '24',
    'max-proposal-reminders': '1',
    'auto-dispatch': 'true',
    'max-injects-per-day': '3',
    'inject-cooldown-minutes': '15',
  })

  assert.throws(
    () => {
      return parseHootArguments(['settings', 'set', '--enabled'])
    },
    /hoot_invalid_argument/
  )

  assert.throws(
    () => {
      return parseHootArguments(['goal', 'add', '--objective', '--key', 'araya-quality'])
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
    assert.match(status.output, /hoot conversationId: （まだ作っていません） \/ conversationRuns: 0/u)
    assert.match(status.output, /notifyDecisions: request_human, invalid \/ precheck: true \/ watchdogHours: 24/u)
    assert.match(status.output, /digestHourUtc: 21 \/ resetConversationAfterRuns: 24 \/ goalReviewDays: 30/u)
    assert.match(status.output, /lastModelRunAt: （なし） \/ lastDigestAt: （なし）/u)

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
      '--review-at',
      '2026-12-01',
    ])
    assert.equal(added.ok, true)
    assert.match(added.output, /araya-quality \[active\]/u)
    assert.match(added.output, /constraints: merge は人間の承認後だけ \/ secret を commit しない/u)
    assert.match(added.output, /reviewAt: 2026-12-01T00:00:00\.000Z（過ぎていれば自動 paused）/u)

    const duplicate = await fixture.run(['goal', 'add', '--key', 'araya-quality', '--objective', 'duplicate'])
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.message, /hoot_goal_exists/u)

    const updated = await fixture.run(['goal', 'update', '--key', 'araya-quality', '--objective', '更新後の objective'])
    assert.equal(updated.ok, true)
    assert.match(updated.output, /更新後の objective/u)
    // --review-at を渡さない更新は前の期限を保つ
    assert.match(updated.output, /reviewAt: 2026-12-01T00:00:00\.000Z/u)

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
      '--notify-decisions',
      'noop,wait,request_human',
      '--precheck',
      'false',
      '--watchdog-hours',
      '12',
      '--digest-hour-utc',
      '7',
      '--reset-conversation-after-runs',
      '5',
      '--goal-review-days',
      '14',
      '--proposal-ttl-hours',
      '24',
      '--max-proposal-reminders',
      '1',
    ])
    assert.equal(settings.ok, true)
    assert.match(settings.output, /enabled: true/u)
    assert.match(settings.output, /tickMinutes: 10/u)

    // Issue #31: mode=active は「承認された dispatch を main 会話へ inject してよい」 gate。autoDispatch の既定は false
    const modeActive = await fixture.run(['settings', 'set', '--mode', 'active', '--max-injects-per-day', '1'])
    assert.equal(modeActive.ok, true)
    assert.match(modeActive.output, /mode: active/u)
    assert.match(modeActive.output, /autoDispatch: false/u)
    assert.match(modeActive.output, /maxInjectsPerDay: 1/u)
    assert.match(modeActive.output, /injectCooldownMinutes: 60/u)

    const badInjectSetting = await fixture.run(['settings', 'set', '--max-injects-per-day', '11'])
    assert.equal(badInjectSetting.ok, false)
    assert.match(badInjectSetting.message, /hoot_settings_invalid/u)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.settings.enabled, true)
    assert.equal(state.settings.tickMinutes, 10)
    assert.equal(state.settings.maxRunsPerDay, 4)
    assert.deepEqual(state.settings.notifyDecisions, ['noop', 'wait', 'request_human'])
    assert.equal(state.settings.precheckObservation, false)
    assert.equal(state.settings.watchdogHours, 12)
    assert.equal(state.settings.digestHourUtc, 7)
    assert.equal(state.settings.resetConversationAfterRuns, 5)
    assert.equal(state.settings.goalReviewDays, 14)
    assert.equal(state.settings.proposalTtlHours, 24)
    assert.equal(state.settings.maxProposalReminders, 1)
    assert.equal(state.settings.mode, 'active')
    assert.equal(state.settings.autoDispatch, false)
    assert.equal(state.settings.maxInjectsPerDay, 1)
    assert.equal(state.settings.injectCooldownMinutes, 60)
    assert.deepEqual(state.injectRequests, [])
    assert.equal('notifyNoop' in state.settings, false)
    assert.equal(state.goals[0]?.status, 'paused')
    assert.equal(state.goals[0]?.reviewAt, '2026-12-01T00:00:00.000Z')

    const runs = await fixture.run(['runs'])
    assert.equal(runs.ok, true)
    assert.match(runs.output, /判断 run の記録はありません/u)

    const statusAfter = await fixture.run(['status'])
    assert.match(statusAfter.output, /enabled: true/u)
    assert.match(statusAfter.output, /active goals: 0\/1/u)
    assert.match(statusAfter.output, /araya-quality \[paused\]/u)
    assert.match(statusAfter.output, /reviewAt: 2026-12-01T00:00:00\.000Z/u)
    assert.match(statusAfter.output, /notifyDecisions: noop, wait, request_human \/ precheck: false \/ watchdogHours: 12/u)
    assert.match(statusAfter.output, /digestHourUtc: 7 \/ resetConversationAfterRuns: 5 \/ goalReviewDays: 14/u)

    const unknown = await fixture.run(['nope'])
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /hoot_invalid_argument/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: goal の review 期限（--review-at の YYYY-MM-DD / ISO / none と list・status 表示）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const dated = await fixture.run(['goal', 'add', '--key', 'review-date', '--objective', '期限つき goal', '--review-at', '2026-12-01'])
    assert.equal(dated.ok, true)
    assert.match(dated.output, /reviewAt: 2026-12-01T00:00:00\.000Z/u)

    const iso = await fixture.run([
      'goal',
      'add',
      '--key',
      'review-iso',
      '--objective',
      'ISO 期限の goal',
      '--review-at',
      '2026-12-02T09:30:00.000Z',
    ])
    assert.equal(iso.ok, true)
    assert.match(iso.output, /reviewAt: 2026-12-02T09:30:00\.000Z/u)

    // --review-at を明示した form だけここで確認する（既定の review 期限は別の test で pin する）
    const none = await fixture.run(['goal', 'update', '--key', 'review-iso', '--objective', '無期限に戻す', '--review-at', 'none'])
    assert.equal(none.ok, true)
    assert.match(none.output, /reviewAt: none（過ぎていれば自動 paused）/u)

    const invalid = await fixture.run(['goal', 'add', '--key', 'review-bad', '--objective', 'o', '--review-at', 'not-a-date'])
    assert.equal(invalid.ok, false)
    assert.match(invalid.message, /hoot_goal_invalid/u)
    assert.match(invalid.message, /YYYY-MM-DD/u)

    const listed = await fixture.run(['goal', 'list'])
    assert.equal(listed.ok, true)
    assert.match(listed.output, /review-date \[active\]/u)
    assert.match(listed.output, /reviewAt: 2026-12-01T00:00:00\.000Z（過ぎていれば自動 paused）/u)
    assert.match(listed.output, /review-iso \[active\]/u)
    assert.match(listed.output, /reviewAt: none（過ぎていれば自動 paused）/u)

    const status = await fixture.run(['status'])
    assert.match(status.output, /review-date \[active\]/u)
    assert.match(status.output, /reviewAt: 2026-12-01T00:00:00\.000Z/u)

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.goals.find((goal) => goal.key === 'review-date')?.reviewAt, '2026-12-01T00:00:00.000Z')
    assert.equal(
      state.goals.some((goal) => {
        return goal.key === 'review-bad'
      }),
      false
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: goal add は --review-at を省くと settings.goalReviewDays の期限が入る（0 で無期限）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    assert.equal((await fixture.run(['settings', 'set', '--goal-review-days', '14'])).ok, true)
    const added = await fixture.run(['goal', 'add', '--key', 'review-default', '--objective', '既定期限の goal'])
    assert.equal(added.ok, true)
    assert.match(added.output, /reviewAt: 2\d{3}-\d{2}-\d{2}T/u)

    const state = await readHootState(fixture.dataDir)
    const reviewAt = state.goals.find((goal) => {
      return goal.key === 'review-default'
    })?.reviewAt
    assert.notEqual(reviewAt, null)

    // store が now 起点で settings.goalReviewDays 日先を入れる（CLI fixture の now とは独立なので秒程度の揺れを見る）
    const daysFromNow = (Date.parse(String(reviewAt)) - Date.now()) / (24 * 60 * 60 * 1000)
    assert.ok(daysFromNow > 13.99 && daysFromNow < 14.01, `reviewAt=${String(reviewAt)} / days=${String(daysFromNow)}`)

    // 同じ settings で追加した別の goal も同じ日数
    const second = await fixture.run(['goal', 'add', '--key', 'review-default-2', '--objective', '二つ目の goal'])
    assert.equal(second.ok, true)
    assert.match(second.output, /reviewAt: 2\d{3}-\d{2}-\d{2}T/u)

    // goalReviewDays: 0 は無期限（reviewAt none）。既存 goal の更新で 0 が足し直されないことも確認する
    assert.equal((await fixture.run(['settings', 'set', '--goal-review-days', '0'])).ok, true)
    const unlimited = await fixture.run(['goal', 'add', '--key', 'review-unlimited', '--objective', '無期限の goal'])
    assert.equal(unlimited.ok, true)
    assert.match(unlimited.output, /reviewAt: none（過ぎていれば自動 paused）/u)

    const keptUnlimited = await fixture.run(['goal', 'update', '--key', 'review-unlimited', '--objective', '更新'])
    assert.equal(keptUnlimited.ok, true)
    assert.match(keptUnlimited.output, /reviewAt: none（過ぎていれば自動 paused）/u)

    const stateAfter = await readHootState(fixture.dataDir)
    assert.equal(
      stateAfter.goals.find((goal) => {
        return goal.key === 'review-unlimited'
      })?.reviewAt,
      null
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: settings show / set の新しい flag（notifyDecisions・precheck・watchdog・digest・conversation reset・review days・proposal）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const shown = await fixture.run(['settings'])
    assert.equal(shown.ok, true)
    assert.match(shown.output, /notifyDecisions: request_human, invalid（即時 Discord に送る decision。他は digest）/u)
    assert.match(shown.output, /precheckObservation: true（観測 fingerprint が同じなら model を呼ばない）/u)
    assert.match(shown.output, /watchdogHours: 24（precheck で飛ばしていてもこの時間以内に 1 回は model で見る）/u)
    assert.match(shown.output, /digestHourUtc: 21（UTC 1 日 1 回の digest。none で無効）/u)
    assert.match(shown.output, /resetConversationAfterRuns: 24（この model run 数で HOOT 会話を新しくする）/u)
    assert.match(shown.output, /goalReviewDays: 30（新しい goal の review 期限。0 で無期限）/u)
    assert.match(shown.output, /proposalTtlHours: 72 \/ maxProposalReminders: 3/u)
    assert.match(shown.output, /maxRunsPerDay: 8（既定 8。model を呼んだ run だけを数える）/u)
    // 旧 notifyNoop は settings show に出ない
    assert.equal(shown.output.includes('notifyNoop'), false)

    const set = await fixture.run([
      'settings',
      'set',
      '--notify-decisions',
      'wait,investigate',
      '--precheck',
      'false',
      '--watchdog-hours',
      '48',
      '--digest-hour-utc',
      '23',
      '--reset-conversation-after-runs',
      '0',
      '--goal-review-days',
      '90',
      '--proposal-ttl-hours',
      '120',
      '--max-proposal-reminders',
      '0',
    ])
    assert.equal(set.ok, true)
    assert.match(set.output, /notifyDecisions: wait, investigate/u)
    assert.match(set.output, /precheckObservation: false/u)
    assert.match(set.output, /watchdogHours: 48/u)
    assert.match(set.output, /digestHourUtc: 23/u)
    assert.match(set.output, /resetConversationAfterRuns: 0/u)
    assert.match(set.output, /goalReviewDays: 90/u)
    assert.match(set.output, /proposalTtlHours: 120 \/ maxProposalReminders: 0/u)

    const digestOff = await fixture.run(['settings', 'set', '--digest-hour-utc', 'none'])
    assert.equal(digestOff.ok, true)
    assert.match(digestOff.output, /digestHourUtc: none（UTC 1 日 1 回の digest。none で無効）/u)

    const settingsState = await readHootState(fixture.dataDir)
    assert.equal(settingsState.settings.digestHourUtc, null)
    assert.equal(settingsState.settings.goalReviewDays, 90)

    // 範囲外の integer は store 側の hoot_settings_invalid で拒否（CLI は値を作らない）
    const badWatchdog = await fixture.run(['settings', 'set', '--watchdog-hours', '0'])
    assert.equal(badWatchdog.ok, false)
    assert.match(badWatchdog.message, /hoot_settings_invalid/u)
    assert.match(badWatchdog.message, /1〜168/u)

    const badDigest = await fixture.run(['settings', 'set', '--digest-hour-utc', '24'])
    assert.equal(badDigest.ok, false)
    assert.match(badDigest.message, /hoot_settings_invalid/u)

    const badReminders = await fixture.run(['settings', 'set', '--max-proposal-reminders', '11'])
    assert.equal(badReminders.ok, false)
    assert.match(badReminders.message, /hoot_settings_invalid/u)

    // 未知の notify-decisions は CLI 側で hoot_invalid_argument（state は変わらない）
    const badDecisions = await fixture.run(['settings', 'set', '--notify-decisions', 'noop,bogus'])
    assert.equal(badDecisions.ok, false)
    assert.match(badDecisions.message, /hoot_invalid_argument/u)
    assert.match(badDecisions.message, /--notify-decisions/u)
    assert.deepEqual((await readHootState(fixture.dataDir)).settings.notifyDecisions, ['wait', 'investigate'])

    const badSubcommand = await fixture.run(['settings', 'nope'])
    assert.equal(badSubcommand.ok, false)
    assert.match(badSubcommand.message, /hoot_invalid_argument/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: --notify-noop はもう効かない（notifyDecisions を変えない）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const before = await readHootState(fixture.dataDir)
    assert.deepEqual(before.settings.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS])

    const result = await fixture.run(['settings', 'set', '--notify-noop', 'true', '--tick-minutes', '15'])
    assert.equal(result.ok, true)
    assert.match(result.output, /tickMinutes: 15/u)
    // 撤去された flag なので silent に無視される（notifyDecisions は既定のまま）
    assert.match(result.output, /notifyDecisions: request_human, invalid/u)

    const state = await readHootState(fixture.dataDir)
    assert.deepEqual(state.settings.notifyDecisions, [...DEFAULT_NOTIFY_DECISIONS])
    assert.equal(state.settings.tickMinutes, 15)
    assert.equal('notifyNoop' in state.settings, false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: key は --key でだけ受け取る（subcommand 名を key に取り違えず usage を書いた hoot_invalid_argument）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    assert.equal((await fixture.run(['goal', 'add', '--key', 'keep-key', '--objective', 'objective'])).ok, true)

    for (const subcommand of ['pause', 'resume', 'retire']) {
      const missing = await fixture.run(['goal', subcommand])
      assert.equal(missing.ok, false)
      assert.match(missing.message, new RegExp(`hoot_invalid_argument: --key が必要です（araya hoot goal ${subcommand} --key <key>）`, 'u'))
    }

    // positional で goal key を渡しても key として扱わない（黙って goal を変更しない）
    const positionalKey = await fixture.run(['goal', 'pause', 'keep-key'])
    assert.equal(positionalKey.ok, false)
    assert.match(positionalKey.message, /hoot_invalid_argument: --key が必要です（araya hoot goal pause --key <key>）/u)
    assert.equal(
      (await readHootState(fixture.dataDir)).goals[0]?.status,
      'active'
    )

    const addWithoutKey = await fixture.run(['goal', 'add', 'positional-objective'])
    assert.equal(addWithoutKey.ok, false)
    assert.match(addWithoutKey.message, /hoot_invalid_argument: --key が必要です/u)
    assert.equal((await readHootState(fixture.dataDir)).goals.length, 1)

    const updateWithoutKey = await fixture.run(['goal', 'update', '--objective', 'objective'])
    assert.equal(updateWithoutKey.ok, false)
    assert.match(updateWithoutKey.message, /hoot_invalid_argument: --key が必要です/u)

    const resolveWithoutKey = await fixture.run(['proposal', 'resolve'])
    assert.equal(resolveWithoutKey.ok, false)
    assert.match(resolveWithoutKey.message, /hoot_invalid_argument: araya hoot proposal resolve --key <key>/u)

    // --key 自体に値が無い場合は parser 側で弾く
    const resolveEmptyFlag = await fixture.run(['proposal', 'resolve', '--key'])
    assert.equal(resolveEmptyFlag.ok, false)
    assert.match(resolveEmptyFlag.message, /hoot_invalid_argument: --key は値が必要です/u)

    const listTakesNoKey = await fixture.run(['goal', 'list'])
    assert.equal(listTakesNoKey.ok, true)
    assert.match(listTakesNoKey.output, /keep-key \[active\]/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: --data-dir を渡したときだけ別の state file を指す（既定は deps.dataDir で bot と同じ file）', async () => {
  const fixture = await makeHootCliFixture()
  const otherDir = path.join(fixture.root, 'other-data')

  try {
    const added = await fixture.run(['goal', 'add', '--key', 'external', '--objective', '外部 file の goal', '--data-dir', otherDir])
    assert.equal(added.ok, true)

    const otherState = await readHootState(otherDir)
    assert.equal(otherState.goals[0]?.key, 'external')

    const defaultState = await readHootState(fixture.dataDir)
    assert.equal(defaultState.goals.length, 0)

    const statusOther = await fixture.run(['status', '--data-dir', otherDir])
    assert.match(statusOther.output, /external \[active\]/u)
    assert.match(statusOther.output, new RegExp(`state file: ${path.join(otherDir, 'hoot', 'state.json')}`, 'u'))

    const statusDefault = await fixture.run(['status'])
    assert.match(statusDefault.output, /active goals: 0\/0/u)
    assert.equal(statusDefault.output.includes('external'), false)

    // settings も --data-dir 側の file だけ変わる
    assert.equal((await fixture.run(['settings', 'set', '--tick-minutes', '15', '--data-dir', otherDir])).ok, true)
    assert.equal((await readHootState(otherDir)).settings.tickMinutes, 15)
    assert.equal((await readHootState(fixture.dataDir)).settings.tickMinutes, 60)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: proposal list / proposal resolve --key（open と closed を分け、resolve は state に効く）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const empty = await fixture.run(['proposal'])
    assert.equal(empty.ok, true)
    assert.match(empty.output, /proposal の記録はありません/u)

    const openKey = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'request_human' })
    await upsertProposal(fixture.dataDir, {
      key: openKey,
      decision: 'request_human',
      goalKeys: ['araya-quality'],
      reason: '優先順位を決めてください',
      occurrenceKey: 'hoot:2026-11-19T09:00:00.000Z',
      nowMs: Date.parse('2026-11-19T09:00:00.000Z'),
    })
    await upsertProposal(fixture.dataDir, {
      key: 'other-proposal',
      decision: 'dispatch',
      goalKeys: ['araya-quality'],
      reason: 'draft PR を見る',
      occurrenceKey: 'hoot:2026-11-19T08:00:00.000Z',
      nowMs: Date.parse('2026-11-19T08:00:00.000Z'),
    })

    const listed = await fixture.run(['proposal', 'list'])
    assert.equal(listed.ok, true)
    assert.match(listed.output, /open 2 \/ closed 0/u)
    assert.match(listed.output, new RegExp(`${openKey} \\[open\\] request_human goals=araya-quality`, 'u'))
    assert.match(listed.output, /reason: 優先順位を決めてください/u)
    assert.match(listed.output, /expires: 2026-11-22T09:00:00\.000Z \/ reminders: 0/u)

    const resolveWithoutValue = await fixture.run(['proposal', 'resolve', '--key'])
    assert.equal(resolveWithoutValue.ok, false)
    assert.match(resolveWithoutValue.message, /hoot_invalid_argument/u)

    const resolveMissingKey = await fixture.run(['proposal', 'resolve', '--key', 'no-such-key'])
    assert.equal(resolveMissingKey.ok, false)
    assert.match(resolveMissingKey.message, /hoot_proposal_not_found/u)

    const resolved = await fixture.run(['proposal', 'resolve', '--key', openKey])
    assert.equal(resolved.ok, true)
    assert.match(resolved.output, /resolved/u)
    assert.match(resolved.output, new RegExp(`proposal ${openKey} を resolved にしました（\\[request_human\\]）`, 'u'))

    const state = await readHootState(fixture.dataDir)
    assert.equal(
      state.proposals.find((proposal) => {
        return proposal.key === openKey
      })?.status,
      'resolved'
    )

    // resolved をもう resolve できない（open だけが高い対象）
    const resolveResolved = await fixture.run(['proposal', 'resolve', '--key', openKey])
    assert.equal(resolveResolved.ok, false)
    assert.match(resolveResolved.message, /hoot_proposal_not_found/u)

    const listedAfter = await fixture.run(['proposal', 'list'])
    assert.match(listedAfter.output, /open 1 \/ closed 1/u)
    assert.match(listedAfter.output, new RegExp(`${openKey} \\[resolved\\]`, 'u'))

    const unknownSubcommand = await fixture.run(['proposal', 'nope'])
    assert.equal(unknownSubcommand.ok, false)
    assert.match(unknownSubcommand.message, /proposal の subcommand は list \/ resolve/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: status に open proposals・conversationRuns・lastModelRunAt・lastDigestAt・goal の reviewAt が出る', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const state: HootState = {
      ...defaultState(),
      settings: { ...defaultState().settings, enabled: true },
      goals: [
        {
          key: 'araya-quality',
          objective: 'open issue と draft PR を拾う',
          scope: ['github:koh110/araya'],
          constraints: [],
          status: 'active',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-19T08:00:00.000Z',
          reviewAt: '2026-12-19T00:00:00.000Z',
        },
      ],
      loop: {
        ...defaultState().loop,
        lastOccurrenceAt: '2026-11-19T08:00:00.000Z',
        lastRunAt: '2026-11-19T08:00:02.000Z',
        lastModelRunAt: '2026-11-19T08:00:02.000Z',
        lastDigestAt: '2026-11-18T21:00:00.000Z',
        conversationRuns: 3,
        goalFingerprints: { 'araya-quality': 'abcd0123abcd0123' },
        conversationId: 21,
      },
      runs: [
        runFixture('hoot:2026-11-19T08:00:00.000Z', {
          decidedAt: '2026-11-19T08:00:02.000Z',
          decision: 'request_human',
          reason: '優先順位を決めてください',
          observationGaps: ['koh110/araya: gh が見つかりません'],
        }),
        runFixture('hoot:2026-11-19T09:00:00.000Z', {
          decidedAt: '2026-11-19T09:00:01.000Z',
          source: 'precheck',
          reason: '観測 fingerprint が前回と同じため model を呼ばない',
        }),
      ],
      proposals: [
        proposalFixture('open-proposal'),
        proposalFixture('open-proposal-2', { decision: 'dispatch', goalKeys: ['araya-quality'], reminders: 0 }),
        proposalFixture('closed-proposal', { status: 'resolved', reason: 'すでに回答済み' }),
      ],
    }
    await writeHootState(fixture.dataDir, state)

    const status = await fixture.run(['status'])
    assert.equal(status.ok, true)
    assert.match(status.output, /conversationRuns: 3/u)
    assert.match(status.output, /lastModelRunAt: 2026-11-19T08:00:02\.000Z \/ lastDigestAt: 2026-11-18T21:00:00\.000Z/u)
    assert.match(status.output, /open proposals: 2/u)
    assert.match(status.output, /open-proposal \[open\] request_human goals=araya-quality/u)
    assert.match(status.output, /open-proposal-2 \[open\] dispatch goals=araya-quality/u)
    // closed proposal は status に出さない（proposal list で見る）
    assert.equal(status.output.includes('closed-proposal'), false)
    assert.match(status.output, /reviewAt: 2026-12-19T00:00:00\.000Z/u)
    assert.match(status.output, /next occurrence: 2026-11-19T09:00:00\.000Z/u)
    assert.match(status.output, /last run: 2026-11-19T09:00:01\.000Z noop — 観測 fingerprint が前回と同じため model を呼ばない/u)

    const runs = await fixture.run(['runs', '--limit', '1'])
    assert.equal(runs.ok, true)
    assert.match(runs.output, /2026-11-19T09:00:01\.000Z noop \[hoot:2026-11-19T09:00:00\.000Z\]/u)
    assert.equal(runs.output.includes('2026-11-19T08:00:02.000Z'), false)

    const runsAll = await fixture.run(['runs'])
    assert.match(runsAll.output, /hoot:2026-11-19T08:00:00\.000Z/u)
    assert.match(runsAll.output, /gaps: koh110\/araya: gh が見つかりません/u)

    const proposalList = await fixture.run(['proposal', 'list'])
    assert.match(proposalList.output, /open 2 \/ closed 1/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: bot loop と同じ state file を使う（CLI で有効化すると tick が走り、記録は CLI に見える）', async () => {
  const fixture = await makeHootCliFixture()

  try {
    await writeHootState(fixture.dataDir, defaultState())
    const added = await fixture.run([
      'goal',
      'add',
      '--key',
      'github-scan',
      '--objective',
      'open issue を数える',
      '--scope',
      'github:koh110/araya',
      '--review-at',
      '2026-12-01',
    ])
    assert.equal(added.ok, true)
    assert.equal((await fixture.run(['settings', 'set', '--enabled', 'true'])).ok, true)

    const loop = createHootLoop({
      dataDir: fixture.dataDir,
      devRoot: fixture.root,
      redactor: createRedactor(collectSecretValues({})),
      decide: async () => {
        return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 21 }
      },
      log: () => {},
      nowMs: () => Date.parse(HOOT_NOW_ISO),
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

    const state = await readHootState(fixture.dataDir)
    assert.equal(state.runs[0]?.source, 'model')
    assert.equal(state.loop.lastModelRunAt, '2026-11-19T09:00:00.000Z')
    assert.equal(state.loop.conversationRuns, 1)

    const status = await fixture.run(['status'])
    assert.match(status.output, /hoot conversationId: 21 \/ conversationRuns: 1/u)
    assert.match(status.output, /next occurrence: 2026-11-19T10:00:00\.000Z/u)
    assert.match(status.output, /reviewAt: 2026-12-01T00:00:00\.000Z/u)

    const reset = await fixture.run(['reset-schedule'])
    assert.equal(reset.ok, true)
    assert.equal((await readHootState(fixture.dataDir)).loop.lastOccurrenceAt, null)
    // schedule reset は run 記録・settings・goal の review 期限を保つ
    const afterReset = await readHootState(fixture.dataDir)
    assert.equal(afterReset.runs.length, 1)
    assert.equal(afterReset.settings.enabled, true)
    assert.equal(afterReset.goals[0]?.reviewAt, '2026-12-01T00:00:00.000Z')
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

test('hoot cli: dispatch --key は investigate proposal も inject できる（main 会話の read-only 調査案件）', async () => {
  const fixture = await makeHootCliFixture()
  const investigateKey = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'investigate' })

  try {
    const added = await fixture.run(['goal', 'add', '--key', 'araya-quality', '--objective', 'open issue の再現条件と影響範囲を特定する'])
    assert.equal(added.ok, true)
    const goals = (await readHootState(fixture.dataDir)).goals
    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      goals,
      proposals: [proposalFixture(investigateKey, { decision: 'investigate', reason: 'open issue の再現条件が観測から確定しない' })]
    })

    const dryRun = await fixture.run(['dispatch', '--key', investigateKey])
    assert.equal(dryRun.ok, false)
    assert.match(dryRun.message, /hoot_mode_dry_run/u)

    const enabled = await fixture.run(['settings', 'set', '--enabled', 'true', '--mode', 'active'])
    assert.equal(enabled.ok, true)

    const queued = await fixture.run(['dispatch', '--key', investigateKey])
    assert.equal(queued.ok, true)
    assert.match(queued.output, /inject request を作りました/u)
    assert.match(queued.output, new RegExp(`proposal: ${investigateKey} \\[investigate\\]`, 'u'))

    let state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests.length, 1)
    assert.equal(state.injectRequests[0]?.proposalKey, investigateKey)
    assert.equal(state.injectRequests[0]?.status, 'pending')
    assert.equal(state.injectRequests[0]?.authorizedBy, 'human')

    // bot loop が main 会話へ渡す文面に「read-only 調査案件」の旨が出る（実行するのは main 会話）
    const injectInputs: { content: string; notice: string }[] = []
    const loop = createHootLoop({
      dataDir: fixture.dataDir,
      devRoot: fixture.root,
      redactor: createRedactor(collectSecretValues({})),
      decide: async () => {
        return { text: 'DECISION: noop\nREASON: inject だけ', conversationId: 5 }
      },
      deliver: async () => {},
      dispatchInject: async (input) => {
        injectInputs.push({ content: input.content, notice: input.notice })
      },
      log: () => {},
      nowMs: () => {
        return Date.parse(HOOT_NOW_ISO)
      },
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
      })
    })

    const injected = await loop.injectOnce()
    assert.equal(injected.kind, 'injected')
    assert.equal(injectInputs.length, 1)
    assert.match(injectInputs[0]?.content ?? '', /read-only 調査案件/u)
    assert.match(injectInputs[0]?.content ?? '', /file の変更・commit・deploy・merge を実行しません/u)
    assert.match(injectInputs[0]?.notice ?? '', /人間の承認/u)

    state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests[0]?.status, 'injected')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: dispatch --key は inject request を作り、inject list / status に出す（dry_run では拒否）', async () => {
  const fixture = await makeHootCliFixture()
  const dispatchKey = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'dispatch' })
  const investigateKey = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'investigate' })
  const requestHumanKey = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'request_human' })

  try {
    const added = await fixture.run(['goal', 'add', '--key', 'araya-quality', '--objective', 'open issue と draft PR を拾う'])
    assert.equal(added.ok, true)
    const goals = (await readHootState(fixture.dataDir)).goals

    await writeHootState(fixture.dataDir, {
      ...defaultState(),
      goals,
      proposals: [
        proposalFixture(dispatchKey, { decision: 'dispatch', reason: 'draft PR 1 件を続行すべきか判断したい' }),
        proposalFixture(investigateKey, { decision: 'investigate', reason: 'test workflow の実行を確認する' }),
        proposalFixture(requestHumanKey, { decision: 'request_human', reason: 'mode を active にしてよいか確認したい' }),
      ],
    })

    // dry_run（既定）では request さえ作らない
    const dryRun = await fixture.run(['dispatch', '--key', dispatchKey])
    assert.equal(dryRun.ok, false)
    assert.match(dryRun.message, /hoot_mode_dry_run/u)

    const enabled = await fixture.run(['settings', 'set', '--enabled', 'true', '--mode', 'active'])
    assert.equal(enabled.ok, true)

    const noKey = await fixture.run(['dispatch'])
    assert.equal(noKey.ok, false)
    assert.match(noKey.message, /--key/u)

    const missing = await fixture.run(['dispatch', '--key', 'hoot-prop-missing'])
    assert.equal(missing.ok, false)
    assert.match(missing.message, /hoot_proposal_not_found/u)

    // inject してよい decision は dispatch / investigate。request_human は人間への依頼なので inject しない
    const notInjectable = await fixture.run(['dispatch', '--key', requestHumanKey])
    assert.equal(notInjectable.ok, false)
    assert.match(notInjectable.message, /hoot_inject_not_injectable/u)
    assert.match(notInjectable.message, /investigate/u)

    const queued = await fixture.run(['dispatch', '--key', dispatchKey])
    assert.equal(queued.ok, true)
    assert.match(queued.output, /inject request を作りました/u)
    assert.match(queued.output, new RegExp(`proposal: ${dispatchKey} \\[dispatch\\]`, 'u'))

    // 同じ proposal に pending の間は重ねない
    const again = await fixture.run(['dispatch', '--key', dispatchKey])
    assert.equal(again.ok, true)
    assert.match(again.output, /inject request を作りませんでした（already_pending）/u)

    const list = await fixture.run(['inject', 'list'])
    assert.equal(list.ok, true)
    assert.match(list.output, /hoot-inject:/u)
    assert.match(list.output, /\[pending\]/u)
    assert.match(list.output, /authorized: human/u)

    const badInjectSubcommand = await fixture.run(['inject', 'drop'])
    assert.equal(badInjectSubcommand.ok, false)
    assert.match(badInjectSubcommand.message, /inject の subcommand は list/u)

    const status = await fixture.run(['status'])
    assert.equal(status.ok, true)
    assert.match(status.output, /inject requests: pending 1 \/ injected 0 \/ failed 0/u)
    assert.match(status.output, /araya hoot dispatch --key <proposal key>/u)
    assert.match(status.output, new RegExp(`proposal=${dispatchKey}`, 'u'))

    let state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests.length, 1)
    assert.equal(state.injectRequests[0]?.authorizedBy, 'human')
    assert.equal(state.injectRequests[0]?.status, 'pending')

    // CLI で作った承認を bot loop が main 会話へ渡す（CLI -> loop のつながり）
    const injectInputs: { content: string; notice: string; requestId: string }[] = []
    const loop = createHootLoop({
      dataDir: fixture.dataDir,
      devRoot: fixture.root,
      redactor: createRedactor(collectSecretValues({})),
      decide: async () => {
        return { text: 'DECISION: noop\nREASON: inject だけ', conversationId: 5 }
      },
      deliver: async () => {},
      dispatchInject: async (input) => {
        injectInputs.push({ content: input.content, notice: input.notice, requestId: input.requestId })
      },
      log: () => {},
      nowMs: () => {
        return Date.parse(HOOT_NOW_ISO)
      },
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

    const injected = await loop.injectOnce()
    assert.equal(injected.kind, 'injected')
    assert.equal(injectInputs.length, 1)
    assert.match(injectInputs[0]?.content ?? '', /open issue と draft PR を拾う/u)
    assert.match(injectInputs[0]?.content ?? '', new RegExp(`araya hoot dispatch --key ${dispatchKey}`, 'u'))
    assert.match(injectInputs[0]?.notice ?? '', /人間の承認/u)

    state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests[0]?.status, 'injected')

    const afterInject = await fixture.run(['inject', 'list'])
    assert.match(afterInject.output, /\[injected\]/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot cli: settings set --conversation-read で tool の on/off を表示し、runs は read 実績を出す', async () => {
  const fixture = await makeHootCliFixture()

  try {
    const parsed = parseHootArguments(['settings', 'set', '--conversation-read', 'true'])
    assert.deepEqual(parsed.options, { 'conversation-read': 'true' })

    const initial = await fixture.run(['status'])
    assert.match(initial.output, /conversationRead: false/u)

    const enabled = await fixture.run(['settings', 'set', '--conversation-read', 'true'])
    assert.equal(enabled.ok, true)
    assert.match(enabled.output, /conversationRead: true/u)
    assert.equal((await readHootState(fixture.dataDir)).settings.conversationRead, true)

    const invalid = await fixture.run(['settings', 'set', '--conversation-read', 'yes'])
    assert.equal(invalid.ok, false)
    assert.match(invalid.message, /--conversation-read は true か false/u)

    // read を使った run と使っていない run を並べて表示する
    const state = await readHootState(fixture.dataDir)
    await writeHootState(fixture.dataDir, {
      ...state,
      runs: [
        runFixture('hoot:2026-11-19T08:00:00.000Z', {
          conversationReads: { calls: 2, entries: 9, chars: 2_400 },
          decision: 'wait',
          reason: 'main 会話で人間の変更を取り消すと確認した',
        }),
        runFixture('hoot:2026-11-19T08:05:00.000Z', { decision: 'noop', reason: '変化なし' }),
      ],
    })

    const runs = await fixture.run(['runs'])
    assert.match(runs.output, /reads: 2 calls \/ 9 entries \/ 2400 chars/u)
    assert.equal(runs.output.match(/reads: /gu)?.length ?? 0, 1)

    const status = await fixture.run(['status'])
    assert.match(status.output, /conversationRead: true/u)
    // status の last run は read を使っていない run（0 件）
    assert.match(status.output, /conversation reads: 0 calls \/ 0 entries \/ 0 chars/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
