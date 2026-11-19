import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHootLoop, type HootTickOutcome } from '../src/hoot/tick.ts'
import { readHootState, writeHootState } from '../src/hoot/store.ts'
import { defaultState, type HootGoal, type HootSettings, type HootState } from '../src/hoot/model.ts'
import { collectSecretValues, createRedactor } from '../src/infrastructure/redaction.ts'
import type { BoundedProcessResult } from '../src/infrastructure/process.ts'

function ghResult(payload: unknown): BoundedProcessResult {
  const stdout = JSON.stringify(payload)

  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true,
  }
}

function goalFixture(key = 'araya-quality'): HootGoal {
  const now = new Date('2026-11-19T00:00:00.000Z').toISOString()

  return {
    key,
    objective: 'open issue と draft PR を拾って次作業の提案を作る',
    scope: ['github:koh110/araya'],
    constraints: ['merge は人間の承認後だけ'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

async function makeHootLoopFixture(input: {
  settings?: Partial<HootSettings>
  goals?: HootGoal[]
  runs?: HootState['runs']
  loop?: Partial<HootState['loop']>
  decide?: (request: { prompt: string; conversationId: number | null }) => Promise<{ text: string; conversationId: number }>
  command?: (args: readonly string[]) => BoundedProcessResult
  env?: Record<string, string | undefined>
  nowIso?: string
} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-hoot-tick-test-')))
  const dataDir = path.join(root, 'data')
  const nowMs = () => {
    return new Date(input.nowIso ?? '2026-11-19T09:00:00.000Z').getTime()
  }

  const settings: HootSettings = { ...defaultState().settings, ...input.settings }
  await writeHootState(dataDir, {
    ...defaultState(),
    settings,
    goals: input.goals ?? [],
    runs: input.runs ?? [],
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
    settings: { enabled: true, tickMinutes: 5 },
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
    assert.equal(state.runs[0]?.decision, 'investigate')
    assert.equal(state.runs[0]?.reason, 'open issue 1 件')
    assert.equal(state.runs[0]?.dispatched, false)
    assert.equal(state.runs[0]?.missedOccurrences, 0)
    assert.deepEqual(state.runs[0]?.observedRepos, ['koh110/araya'])
    assert.deepEqual(state.runs[0]?.observationGaps, [])
    assert.equal(state.loop.conversationId, 7)
    assert.equal(state.loop.lastOccurrenceAt, '2026-11-19T09:00:00.000Z')
    assert.notEqual(state.loop.lastRunAt, null)

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
    assert.match(fixture.logs.map((entry) => JSON.stringify(entry)).join('\n'), /"type":"hoot_run"/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: noop は state に記録だけして通知しない（notifyNoop=false）', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5, notifyNoop: false },
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
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: request_human は dry_run でも通知する（dispatch はしない）', async () => {
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
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('hoot tick: 予定より後になっても latest occurrence 1 件だけを走り、past は skip として数える', async () => {
  const fixture = await makeHootLoopFixture({
    settings: { enabled: true, tickMinutes: 5 },
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

test('hoot tick: 1 日の run 上限を超えると model を呼ばない', async () => {
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
