import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHootLoop, type HootTickOutcome } from '../src/hoot/tick.ts'
import { readHootState, setGoalStatus, writeHootState } from '../src/hoot/store.ts'
import { defaultState, proposalKeyOf, type HootGoal, type HootProposal, type HootSettings, type HootState } from '../src/hoot/model.ts'
import { collectSecretValues, createRedactor } from '../src/infrastructure/redaction.ts'
import type { BoundedProcessResult } from '../src/infrastructure/process.ts'

function ghResult(payload: unknown): BoundedProcessResult {
  const stdout = JSON.stringify(payload)

  return {
    exitCode: 0,
    signal:
      null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true,
  }
}

function goalFixture(key = 'araya-quality', overrides: Partial<HootGoal> = {}): HootGoal {
  const now = new Date('2026-11-19T00:00:00.000Z').toISOString()

  return {
    key,
    objective: 'open issue と draft PR を拾って次作業の提案を作る',
    scope: ['github:koh110/araya'],
    constraints: ['merge は人間の承認後だけ'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    // tick test の now（2026-11-19T09:00Z）より後ろ。review 期限切れで自動 paused させない
    reviewAt: new Date('2026-12-19T00:00:00.000Z').toISOString(),
    ...overrides,
  }
}

function proposalFixture(overrides: Partial<HootProposal> = {}): HootProposal {
  return {
    key: proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'request_human' }),
    decision: 'request_human',
    goalKeys: ['araya-quality'],
    reason: '優先順位を決めてください',
    createdAt: '2026-11-19T08:30:00.000Z',
    updatedAt: '2026-11-19T08:30:00.000Z',
    lastReminderAt: null,
    reminders: 0,
    expiresAt: '2026-11-19T12:00:00.000Z',
    status: 'open',
    evidenceOccurrenceKeys: ['hoot:2026-11-19T08:30:00.000Z'],
    ...overrides,
  }
}

async function makeHootLoopFixture(input: {
  settings?: Partial<HootSettings>
  goals?: HootGoal[]
  runs?: HootState['runs']
  proposals?: HootProposal[]
  loop?: Partial<HootState['loop']>
  decide?: (request: { prompt: string; conversationId: number | null }) => Promise<{ text: string; conversationId: number }>
  command?: (args: readonly string[]) => BoundedProcessResult
  env?: Record<string, string | undefined>
  nowIso?: string
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-hoot-tick-test-')))
  const dataDir = path.join(root, 'data')
  let currentMs = new Date(input.nowIso ?? '2026-11-19T09:00:00.000Z').getTime()
  const nowMs = () => {
    return currentMs
  }

  const settings: HootSettings = { ...defaultState().settings, ...input.settings }
  await writeHootState(dataDir, {
    ...defaultState(),
    settings,
    goals: input.goals ?? [],
    runs: input.runs ?? [],
    proposals: input.proposals ?? [],
    loop: { ...defaultState().loop, ...input.loop },
  })

  const logs: Record<string, unknown>[] = []
  const notices: { text: string; nonce: string }[] = []
  const decideInputs: { prompt: string; requestId: string; conversationId: number | null }[] = []
  const commandCalls: string[][] = []

  const env = input.env ?? {}
  const loop = createHootLoop({
    dataDir,
    devRoot: root,
    redactor: createRedactor(collectSecretValues(env)),
    decide: async (request) => {
      decideInputs.push({
        prompt: request.prompt,
        requestId: request.requestId,
        conversationId: request.conversationId,
      })

      if (input.decide !== undefined) {
        return await input.decide({ prompt: request.prompt, conversationId: request.conversationId })
      }

      return {
        text: 'HOOT 判断:\nDECISION: investigate\nREASON: open issue 1 件',
        conversationId: 7,
      }
    },
    deliver: async (text, nonce) => {
      notices.push({ text, nonce })
    },
    log: (entry) => {
      logs.push(entry)
    },
    nowMs,
    env,
    runCommand: async (_command, args) => {
      commandCalls.push([...args])

      if (input.command !== undefined) {
        return input.command(args)
      }

      if (args.includes('issue')) {
        return ghResult([{ number: 10, title: 'HOOT discovery loop', updatedAt: '2026-11-18T00:00:00Z', isPullRequest: false }])
      }

      return ghResult([{ number: 29, title: 'session-first agent', updatedAt: '2026-11-19T00:00:00Z', isDraft: true }])
    },
  })

  return {
    root,
    dataDir,
    loop,
    logs,
    notices,
    decideInputs,
    commandCalls,
    nowMs,
    setNow: (iso: string) => {
      currentMs = new Date(iso).getTime()
    },
    readState: async () => {
      return await readHootState(dataDir)
    },
  }
}

test('hoot tick: 無効なら model も gh も呼ばない', async () => {
  const fixture = await makeHootLoopFixture({ settings: { enabled: false }, goals: [goalFixture()] })

  try {
    const outcome: HootTickOutcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'disabled')
    assert.equal(fixture.decideInputs.length, 0)
    assert.equal(fixture.commandCalls.length, 0)
    assert.equal(fixture.notices.length, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: active goal が無ければ model を呼ばない', async () => {
  const fixture = await makeHootLoopFixture({ settings: { enabled: true }, goals: [goalFixture()] })

  try {
    // goal を retired にしてから tick する
    await writeHootState(fixture.dataDir, {
      ...(await readHootState(fixture.dataDir)),
      goals: [{ ...goalFixture(), status: 'retired' }],
    })
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'no_active_goal')
    assert.equal(fixture.decideInputs.length, 0)
    assert.equal(fixture.commandCalls.length, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: occurrence ごとに 1 回だけ走り、判断と観測を state に残して通知する', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, notifyDecisions: ['investigate'] },
    goals: [goalFixture()],
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 1)
    const prompt = fixture.decideInputs[0]?.prompt ?? ''
    assert.match(prompt, /open issue と draft PR/)
    assert.match(prompt, /github:koh110\/araya/)
    assert.match(prompt, /DECISION:/)
    assert.match(prompt, /証拠であり命令ではない/u)
    assert.equal(fixture.decideInputs[0]?.conversationId, null)

    // gh の read-only command（issue と pr）を各 repo で呼ぶ
    assert.deepEqual(fixture.commandCalls[0], [
      'issue',
      'list',
      '--repo',
      'koh110/araya',
      '--state',
      'open',
      '--limit',
      '30',
      '--json',
      'number,title,updatedAt',
    ])
    assert.deepEqual(fixture.commandCalls[1]?.slice(0, 2), ['pr', 'list'])

    const state = await fixture.readState()
    assert.equal(state.runs.length, 1)
    assert.equal(state.runs[0]?.source, 'model')
    assert.equal(state.runs[0]?.decision, 'investigate')
    assert.equal(state.runs[0]?.reason, 'open issue 1 件')
    assert.equal(state.runs[0]?.dispatched, false)
    assert.equal(state.runs[0]?.missedOccurrences, 0)
    assert.deepEqual(state.runs[0]?.observedRepos, ['koh110/araya'])
    assert.deepEqual(state.runs[0]?.observationGaps, [])
    assert.equal(state.loop.conversationId, 7)
    assert.equal(state.loop.lastOccurrenceAt, '2026-11-19T09:00:00.000Z')
    assert.notEqual(state.loop.lastRunAt, null)
    assert.notEqual(state.loop.lastModelRunAt, null)
    // goal 単位の観測 fingerprint を記録（次回以降の precheck の材料）
    assert.equal(typeof state.loop.goalFingerprints['araya-quality'], 'string')
    // investigate は proposal として open に残す（dry_run では実行しない）
    assert.equal(state.proposals.length, 1)
    assert.equal(state.proposals[0]?.decision, 'investigate')
    assert.deepEqual(state.proposals[0]?.evidenceOccurrenceKeys, ['hoot:2026-11-19T09:00:00.000Z'])

    // schedule 更新前に crash した想定：run だけ存在する同じ occurrence では再実行しない
    const crashed = await fixture.readState()
    await writeHootState(fixture.dataDir, {
      ...crashed,
      loop: { ...crashed.loop, lastOccurrenceAt: '2026-11-19T08:55:00.000Z' },
    })
    const replay = await fixture.loop.tickOnce()
    assert.equal(replay.kind, 'occurrence_recorded')
    assert.equal(fixture.decideInputs.length, 1)
    assert.equal((await fixture.readState()).loop.lastOccurrenceAt, '2026-11-19T09:00:00.000Z')

    // 通知は 1 回。nonce は hoot- prefix
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.nonce ?? '', /^hoot-[0-9a-z]{18}$/u)
    assert.match(fixture.notices[0]?.text ?? '', /HOOT 判断 \[investigate\]/u)
    assert.match(fixture.notices[0]?.text ?? '', /mode: dry_run/u)
    assert.match(fixture.logs.map((entry) => JSON.stringify(entry)).join('\n'), /"type":"hoot_run"/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: noop は state に記録だけして通知しない（notifyDecisions 既定）', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    decide: async () => {
      return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 11 }
    },
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    const state = await fixture.readState()
    assert.equal(state.runs[0]?.decision, 'noop')
    assert.equal(fixture.notices.length, 0)
    assert.equal(state.loop.conversationId, 11)
    // noop は proposal を作らない
    assert.equal(state.proposals.length, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: request_human は dry_run でも即時通知し、open proposal として残す（dispatch はしない）', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    decide: async () => {
      return { text: 'DECISION: request_human\nREASON: 要人の判断: 優先順位を決めてください', conversationId: 12 }
    },
  })

  try {
    await fixture.loop.tickOnce()
    const state = await fixture.readState()
    assert.equal(state.runs[0]?.decision, 'request_human')
    assert.equal(state.runs[0]?.dispatched, false)
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /request_human/)
    assert.equal(state.proposals.length, 1)
    assert.equal(state.proposals[0]?.status, 'open')
    assert.match(state.proposals[0]?.reason ?? '', /優先順位/)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 予定より後になっても latest occurrence 1 件だけを走り、past は skip として数える', async () => {
  const fixture = await makeHootLoopFixture({
    // catch-up の数え方を見る test なので precheck（model を飛ばす機能）は切っておく
    settings: { enabled: true, tickMinutes: 5, precheckObservation: false },
    goals: [goalFixture()],
    loop: { lastOccurrenceAt: '2026-11-19T07:00:00.000Z' },
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    let state = await fixture.readState()
    // 07:00 から now 09:00 に 5 分刻みの予定が 24 回分過ぎている。latest 1 件を走り 23 件 skip する
    assert.equal(state.runs[0]?.missedOccurrences, 23)
    assert.equal(state.runs[0]?.occurrenceKey, 'hoot:2026-11-19T09:00:00.000Z')
    assert.equal(state.loop.lastOccurrenceAt, '2026-11-19T09:00:00.000Z')

    // 数日分空いていても同じ。古い予定を順に走らせると model を叩きすぎるので 1 件で now に追いつく
    await writeHootState(fixture.dataDir, {
      ...state,
      loop: { ...state.loop, lastOccurrenceAt: '2026-11-15T00:00:00.000Z', lastRunAt: null },
      runs: [],
    })
    const catchUp = await fixture.loop.tickOnce()
    assert.equal(catchUp.kind, 'ran')
    state = await fixture.readState()
    assert.equal(state.runs.length, 1)
    // 1259 回分 skip。数は 1000 で打ち切って記録する（schedule は now に追いつく）
    assert.equal(state.runs[0]?.missedOccurrences, 1000)
    assert.equal(state.runs[0]?.occurrenceKey, 'hoot:2026-11-19T09:00:00.000Z')
    assert.equal(fixture.decideInputs.length, 2)

    // 同じ occurrence は繰り返さない
    const again = await fixture.loop.tickOnce()
    assert.equal(again.kind, 'not_due')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 1 日の model run 上限を超えると model を呼ばない', async () => {
  const decidedAt = '2026-11-19T08:55:00.000Z'
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, maxRunsPerDay: 1 },
    goals: [goalFixture()],
    loop: { lastOccurrenceAt: '2026-11-19T08:50:00.000Z', lastRunAt: decidedAt },
    runs: [
      {
        occurrenceKey: 'hoot:2026-11-19T08:45:00.000Z',
        plannedAt: '2026-11-19T08:45:00.000Z',
        decidedAt,
        source: 'model',
        decision: 'noop',
        reason: '変化なし',
        summary: '',
        goalKeys: [],
        missedOccurrences: 0,
        dispatched: false,
        observedRepos: [],
        observationGaps: [],
      },
    ],
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'daily_limit')
    assert.equal(fixture.decideInputs.length, 0)
    assert.equal(fixture.notices.length, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 判断 run の失敗は run を記録せず、次予定まで cooldown（3 件連続で通知）', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    decide: async () => {
      throw new Error('model unavailable: supersecret must not leak')
    },
    env: { SUPER_TOKEN: 'supersecret' },
  })

  try {
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'failed')
    assert.equal(first.consecutiveFailures, 1)

    let state = await fixture.readState()
    assert.equal(state.runs.length, 0)
    assert.equal(state.loop.lastRunAt, null)
    assert.equal(state.loop.consecutiveFailures, 1)
    assert.notEqual(state.loop.failureCooldownUntil, null)

    // cooldown 中は何もしない
    const cooling = await fixture.loop.tickOnce()
    assert.equal(cooling.kind, 'failure_cooldown')
    assert.equal(fixture.decideInputs.length, 1)

    // 連続失敗を積み上げて 3 件目では通知する
    for (let index = 0; index < 2; index += 1) {
      const stateNow = await fixture.readState()
      assert.notEqual(stateNow.loop.failureCooldownUntil, null)
      await writeHootState(fixture.dataDir, {
        ...stateNow,
        loop: { ...stateNow.loop, failureCooldownUntil: null },
      })
      const failed = await fixture.loop.tickOnce()
      assert.equal(failed.kind, 'failed')
      assert.equal(failed.consecutiveFailures, index + 2)
    }

    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /HOOT 判断 run が 3 回続けて失敗/)
    const dump = JSON.stringify({ notices: fixture.notices, logs: fixture.logs })
    assert.doesNotMatch(dump, /supersecret/u)
    assert.match(dump, /\[REDACTED\]/u)

    state = await fixture.readState()
    assert.equal(state.runs.length, 0)
    assert.equal(state.loop.consecutiveFailures, 3)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 判断 text が決まり形式でなければ invalid として記録し、安全側で通知する', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    decide: async () => {
      return { text: 'たぶん noop だと思う', conversationId: 13 }
    },
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    const state = await fixture.readState()
    assert.equal(state.runs[0]?.decision, 'invalid')
    assert.equal(state.runs[0]?.reason, 'DECISION 行がありません')
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /HOOT 判断 \[invalid\]/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: gh 観測の失敗は gaps に残し、判断 run 自体は走らせる', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    command: (args) => {
      if (args.includes('issue')) {
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'gh: HTTP 401',
          stdoutBytes: 0,
          stderrBytes: 13,
          terminationReason: undefined,
          terminationConfirmed: true,
        }
      }

      return ghResult([])
    },
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    const state = await fixture.readState()
    assert.equal(state.runs.length, 1)
    assert.deepEqual(state.runs[0]?.observationGaps, [
      'gh issue list koh110/araya: exit 1 gh: HTTP 401',
    ])
    assert.deepEqual(state.runs[0]?.observedRepos, ['koh110/araya'])
    assert.match(JSON.stringify(fixture.logs), /"type":"hoot_observation_gaps"/u)
    assert.match(fixture.decideInputs[0]?.prompt ?? '', /gap/u)
    // 証拠が欠けている occurrence は fingerprint を「unknown」寄りにして毎回判断させる（precheck で飛ばさない）
    assert.match(state.loop.goalFingerprints['araya-quality'] ?? '', /.+/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 観測に gap がある occurrence は fingerprint が同じでも precheck しない（証拠なしで noop にしない）', async () => {
  let broken = false
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    command: (args) => {
      if (broken) {
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'gh: HTTP 500',
          stdoutBytes: 0,
          stderrBytes: 12,
          terminationReason: undefined,
          terminationConfirmed: true,
        }
      }

      if (args.includes('issue')) {
        return ghResult([{ number: 30, title: 'HOOT wakeup dry run', updatedAt: '2026-11-19T00:00:00Z' }])
      }

      return ghResult([])
    },
  })

  try {
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    const afterFirst = await fixture.readState()
    assert.ok(afterFirst.loop.goalFingerprints['araya-quality'] !== undefined)

    // 同じ観測のまま gh が壊れた occurrence: fingerprint 比較では「変わっていない」が、証拠が無いので precheck しない
    broken = true
    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    assert.equal(second.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 2)
    const state = await fixture.readState()
    assert.equal(state.runs[1]?.source, 'model')
    assert.deepEqual(state.runs[1]?.observationGaps, [
      'gh issue list koh110/araya: exit 1 gh: HTTP 500',
      'gh pr list koh110/araya: exit 1 gh: HTTP 500',
    ])

    // 壊れた観測が続く occurrence: fingerprint は前と同一になる。それでも precheck しないで model を呼ぶ
    const brokenFingerprint = state.loop.goalFingerprints['araya-quality']
    assert.ok(brokenFingerprint !== undefined)
    fixture.setNow('2026-11-19T09:10:00.000Z')
    const third = await fixture.loop.tickOnce()
    assert.equal(third.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 3)
    const afterThird = await fixture.readState()
    assert.equal(afterThird.runs[2]?.source, 'model')
    assert.equal(afterThird.loop.goalFingerprints['araya-quality'], brokenFingerprint)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 観測 fingerprint が変わらなければ model を呼ばず precheck noop を記録する', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
  })

  try {
    // 最初の occurrence は lastModelRunAt が無いので watchdog 対象。ここでは model が 1 回走る
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 1)
    const afterFirst = await fixture.readState()
    const fingerprint = afterFirst.loop.goalFingerprints['araya-quality'] ?? ''

    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    assert.equal(second.kind, 'prechecked_noop')
    // 変化がないので model も gh の fingerprint 比較以降の判断も呼ばない（gh 観測自体は毎回集める）
    assert.equal(fixture.decideInputs.length, 1)
    assert.equal(second.occurrenceKey, 'hoot:2026-11-19T09:05:00.000Z')

    const state = await fixture.readState()
    assert.equal(state.runs.length, 2)
    assert.equal(state.runs[1]?.source, 'precheck')
    assert.equal(state.runs[1]?.decision, 'noop')
    assert.match(state.runs[1]?.reason ?? '', /fingerprint/u)
    assert.equal(state.loop.goalFingerprints['araya-quality'], fingerprint)
    // precheck noop は schedule を進めるが lastModelRunAt は進めない
    assert.equal(state.loop.lastOccurrenceAt, '2026-11-19T09:05:00.000Z')
    assert.equal(state.loop.lastModelRunAt, afterFirst.loop.lastModelRunAt)
    assert.match(JSON.stringify(fixture.logs), /"type":"hoot_precheck_noop"/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 観測が変われば model を呼び、open proposal は同じ goal・decision なら 1 件に寄せる', async () => {
  let issueNumber = 10
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture()],
    decide: async () => {
      return { text: 'DECISION: request_human\nREASON: 優先順位を決めてください', conversationId: 14 }
    },
    command: (args) => {
      if (args.includes('issue')) {
        return ghResult([{ number: issueNumber, title: 'HOOT discovery loop', updatedAt: '2026-11-18T00:00:00Z' }])
      }

      return ghResult([{ number: 29, title: 'session-first agent', updatedAt: '2026-11-19T00:00:00Z', isDraft: true }])
    },
  })

  try {
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    issueNumber = 11
    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    assert.equal(second.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 2)

    const state = await fixture.readState()
    // 同じ goal・同じ decision の提案は積み上げない（人間が応答するまで 1 件 + 再提醒）
    assert.equal(state.proposals.length, 1)
    assert.equal(state.proposals[0]?.decision, 'request_human')
    assert.equal(state.proposals[0]?.evidenceOccurrenceKeys.length, 2)

    // open proposals は判断 prompt に出ていて、同じ提案の再生産を止める材料にする
    assert.match(fixture.decideInputs[1]?.prompt ?? '', /未解決の提案/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: watchdogHours が過ぎている occurrence では観測が変わらなくても model を呼ぶ', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, watchdogHours: 24 },
    goals: [goalFixture()],
  })

  try {
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    const state1 = await fixture.readState()
    // 直近の model run を 25 時間前に戻す（観測も fingerprint も同じまま）
    await writeHootState(fixture.dataDir, {
      ...state1,
      proposals: [],
      loop: {
        ...state1.loop,
        lastModelRunAt: '2026-11-18T08:00:00.000Z',
        lastOccurrenceAt: '2026-11-19T08:55:00.000Z',
      },
    })
    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    // precheck の条件（fingerprint 変化なし）を満たしていても watchdog で判断 run を走らせる
    assert.equal(second.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 2)
    const state2 = await fixture.readState()
    assert.equal(state2.loop.goalFingerprints['araya-quality'], state1.loop.goalFingerprints['araya-quality'])
    assert.equal(state2.loop.lastModelRunAt, state2.runs.at(-1)?.decidedAt)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: review 期限を過ぎた active goal を model を呼ばず自動 paused にして案内する', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture('araya-quality', { reviewAt: '2026-11-19T08:00:00.000Z' })],
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'goals_review_paused')
    assert.equal(fixture.decideInputs.length, 0)
    assert.equal(fixture.commandCalls.length, 0)

    const state = await fixture.readState()
    assert.equal(state.goals[0]?.status, 'paused')
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /自動 paused/u)
    assert.match(fixture.notices[0]?.text ?? '', /araya hoot goal resume --key araya-quality/u)

    // paused になったので次の tick は active goal 無しで止まる（空腹を繰り返さない）
    const next = await fixture.loop.tickOnce()
    assert.equal(next.kind, 'no_active_goal')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 自動 paused になった goal は resume 後の occurrence で再 pause しない（resume が review 期限を伸ばす）', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [goalFixture('araya-quality', { reviewAt: '2026-11-19T08:00:00.000Z' })],
  })

  try {
    const paused = await fixture.loop.tickOnce()
    assert.equal(paused.kind, 'goals_review_paused')
    assert.equal(fixture.notices.length, 1)

    // 人間の応答（CLI と同じ store 経路）。active に戻すときに過ぎた期限を goalReviewDays 分伸ばす
    await setGoalStatus(fixture.dataDir, 'araya-quality', 'active')
    const afterResume = await fixture.readState()
    assert.equal(afterResume.goals[0]?.status, 'active')
    assert.ok(Date.parse(afterResume.goals[0]?.reviewAt ?? '') > Date.parse('2026-11-19T09:00:00.000Z'))

    fixture.setNow('2026-11-19T09:05:00.000Z')
    const next = await fixture.loop.tickOnce()
    // すぐ再 pause ではなく判断 run が走る（resume が歯止めを無効化しない）
    assert.equal(next.kind, 'ran')

    const state = await fixture.readState()
    assert.equal(state.goals[0]?.status, 'active')
    assert.equal(fixture.notices.filter((notice) => {
      return /自動 paused/u.test(notice.text)
    }).length, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: open proposal の再提醒は backoff で届き、上限を超えない', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, maxProposalReminders: 2 },
    goals: [goalFixture()],
    proposals: [proposalFixture()],
    decide: async () => {
      return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 15 }
    },
  })

  try {
    // createdAt 08:30 から 30 分経っているので 1 件目の提醒（5 分 * 2^0）は約束通り届く
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    assert.equal(first.remindersSent, 1)
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /HOOT 提案の再提醒 1\/2/u)
    assert.match(fixture.notices[0]?.text ?? '', /優先順位を決めてください/u)

    // 次は 5 分 * 2^1 = 10 分後。09:06 ではまだ送らない（model を呼ばない occurrence でも提醒は届く）
    fixture.setNow('2026-11-19T09:06:00.000Z')
    const second = await fixture.loop.tickOnce()
    assert.equal(second.kind, 'prechecked_noop')
    assert.equal(second.remindersSent, 0)
    assert.equal(fixture.notices.length, 1)

    fixture.setNow('2026-11-19T09:15:00.000Z')
    const third = await fixture.loop.tickOnce()
    assert.equal(third.kind, 'prechecked_noop')
    assert.equal(third.remindersSent, 1)
    assert.equal(fixture.notices.length, 2)
    assert.match(fixture.notices[1]?.text ?? '', /再提醒 2\/2/u)

    // 上限を超えた提醒は送らない（期限が来るまで人間に繰り返さない）
    fixture.setNow('2026-11-19T09:40:00.000Z')
    const fourth = await fixture.loop.tickOnce()
    assert.equal(fourth.kind, 'prechecked_noop')
    assert.equal(fourth.remindersSent, 0)
    assert.equal(fixture.notices.length, 2)
    assert.equal(fixture.decideInputs.length, 1)

    const state = await fixture.readState()
    assert.equal(state.proposals.length, 1)
    assert.equal(state.proposals[0]?.reminders, 2)
    assert.equal(state.proposals[0]?.status, 'open')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: proposal の期限切れは closed にし、digest 以外の通知を増やさない', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, digestHourUtc: null },
    goals: [goalFixture()],
    proposals: [proposalFixture({ expiresAt: '2026-11-19T08:59:00.000Z' })],
    decide: async () => {
      return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 16 }
    },
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    assert.equal(outcome.remindersSent, 0)
    const state = await fixture.readState()
    assert.equal(state.proposals[0]?.status, 'expired')
    // 期限切れを人間に繰り返して通知しない（status 変更だけ）
    assert.equal(fixture.notices.length, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: digest は UTC 1 日 1 件で、noop の内訳を返す', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, digestHourUtc: 9 },
    goals: [goalFixture()],
    decide: async () => {
      return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 17 }
    },
  })

  try {
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    assert.equal(first.digestSent, true)
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /HOOT digest 2026-11-19/u)
    assert.match(fixture.notices[0]?.text ?? '', /noop: 1/u)

    const afterFirst = await fixture.readState()
    assert.equal(afterFirst.loop.lastDigestAt, '2026-11-19T09:00:00.000Z')

    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    // 同じ UTC 日にもう 1 件は送らない
    assert.equal(second.kind, 'prechecked_noop')

    if (second.kind === 'prechecked_noop') {
      assert.equal(second.digestSent, false)
    }
    assert.equal(fixture.notices.length, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: digest は open proposal を key 付きで返し、人間が応答できる形にする', async () => {
  const proposal = proposalFixture({
    // 提醒はもう上限まで送済み。digest 以外を増やさない
    reminders: 1,
    lastReminderAt: '2026-11-19T08:50:00.000Z',
    expiresAt: '2026-11-19T12:00:00.000Z',
  })
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, digestHourUtc: 9, maxProposalReminders: 1 },
    goals: [goalFixture()],
    proposals: [proposal],
    decide: async () => {
      return { text: 'DECISION: noop\nREASON: 変化なし', conversationId: 19 }
    },
  })

  try {
    const outcome = await fixture.loop.tickOnce()
    assert.equal(outcome.kind, 'ran')
    assert.equal(outcome.remindersSent, 0)
    assert.equal(outcome.digestSent, true)
    assert.equal(fixture.notices.length, 1)
    assert.match(fixture.notices[0]?.text ?? '', /open proposals: 1/u)
    assert.match(fixture.notices[0]?.text ?? '', new RegExp(proposal.key, 'u'))
    assert.match(fixture.notices[0]?.text ?? '', /\[request_human\]/u)
    assert.match(fixture.notices[0]?.text ?? '', /優先順位を決めてください/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: resetConversationAfterRuns で HOOT 判断会話を新しくする', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, precheckObservation: false, resetConversationAfterRuns: 2 },
    goals: [goalFixture()],
    loop: { conversationId: 7, conversationRuns: 1 },
    decide: async (request) => {
      return {
        text: 'DECISION: wait\nREASON: 次の observation まで待つ（2026-11-19T10:00:00.000Z）',
        conversationId: request.conversationId ?? 21,
      }
    },
  })

  try {
    // 1 件目: conversationRuns 1 < 2 なので現在の会話をContinuation
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    assert.equal(fixture.decideInputs[0]?.conversationId, 7)
    let state = await fixture.readState()
    assert.equal(state.loop.conversationRuns, 2)
    assert.equal(state.loop.conversationId, 7)

    // 2 件目: 閾値に達したので会話を作らせない（conversationId null で依頼する）
    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    assert.equal(second.kind, 'ran')
    assert.equal(fixture.decideInputs[1]?.conversationId, null)
    assert.match(JSON.stringify(fixture.logs), /"type":"hoot_conversation_reset"/u)
    state = await fixture.readState()
    assert.equal(state.loop.conversationId, 21)
    assert.equal(state.loop.conversationRuns, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 複数 goal ではどれか 1 つでも変われば model を呼ぶ', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
    goals: [
      goalFixture('goal-a', { scope: ['github:koh110/araya'] }),
      goalFixture('goal-b', { scope: ['github:koh110/other'] }),
    ],
    decide: async () => {
      return { text: 'DECISION: noop\nREASON: 変化する goal がある', conversationId: 18 }
    },
    command: (args) => {
      if (args.includes('issue')) {
        return ghResult([{ number: 10, title: 'HOOT discovery loop', updatedAt: '2026-11-18T00:00:00Z' }])
      }

      return ghResult([])
    },
  })

  try {
    const first = await fixture.loop.tickOnce()
    assert.equal(first.kind, 'ran')
    const afterFirst = await fixture.readState()
    assert.deepEqual(
      Object.keys(afterFirst.loop.goalFingerprints).sort(),
      ['goal-a', 'goal-b']
    )

    // 2 件目: どちらも変わっていないので precheck で飛ばす
    fixture.setNow('2026-11-19T09:05:00.000Z')
    const second = await fixture.loop.tickOnce()
    assert.equal(second.kind, 'prechecked_noop')
    assert.equal(fixture.decideInputs.length, 1)

    // 3 件目: 片方の goal を編集（updatedAt が変わる）と model を呼ぶ
    const state = await fixture.readState()
    await writeHootState(fixture.dataDir, {
      ...state,
      goals: state.goals.map((goal) => {
        return goal.key === 'goal-b' ? { ...goal, updatedAt: '2026-11-19T09:05:30.000Z' } : goal
      }),
    })
    fixture.setNow('2026-11-19T09:10:00.000Z')
    const third = await fixture.loop.tickOnce()
    assert.equal(third.kind, 'ran')
    assert.equal(fixture.decideInputs.length, 2)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: stop() は wait 中に割り込んで loop を終える', async () => {
  const fixture = await makeHootLoopFixture({ settings: { enabled: false } })
  fixture.loop.stop()

  try {
    const started = fixture.loop.run()
    fixture.loop.stop()
    await started
    assert.equal(fixture.decideInputs.length, 0)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
