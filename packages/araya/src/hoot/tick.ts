// HOOT の Wakeup loop（Issue #21）の最小形。interval だけの schedule occurrence を deterministic に決め、
// 判断 run を 1 回走らせて record し、必要なら Discord へ 1 件送る。
// 実行前の gate（enabled・active goal の有無・daily limit・occurrence の重複）と、観測 fingerprint の
// precheck（変化がなければ model を呼ばない）を deterministic な code だけで通す。

import { createHash } from 'node:crypto'

import type { Redactor } from '../infrastructure/redaction.ts'
import { collectGitHubObservations, type HootObservation, type ObservationDependencies } from './observe.ts'
import { HOOT_CONVERSATION_INSTRUCTIONS, PROMPT_RECENT_RUNS, buildDecisionPrompt, buildInjectPrompt } from './prompt.ts'
import {
  HOOT_DECISIONS,
  INJECTABLE_DECISIONS,
  MAX_INJECT_ATTEMPTS,
  MAX_INJECT_ERROR_CHARS,
  MAX_REASON_CHARS,
  MAX_SUMMARY_CHARS,
  PROPOSAL_DECISIONS,
  activeGoalsOf,
  anyGoalChanged,
  githubReposOf,
  goalFingerprintsOf,
  isoUtc,
  parseDecision,
  parseIso,
  proposalKeyOf,
  reviewPassed,
  tickMinutesOf,
  utcDayKey,
  utcHour,
  type HootDecision,
  type HootGoal,
  type HootInjectRequest,
  type HootProposal,
  type HootRun,
  type HootSettings,
  type HootState,
} from './model.ts'
import {
  enqueueHootInject,
  finishHootInject,
  pauseExpiredGoals,
  readHootState,
  recordHootDigest,
  recordHootRun,
  setHootConversationId,
  takePendingInject,
  takeProposalReminder,
  updateHootState,
  upsertProposal,
  type HootInjectSkip,
} from './store.ts'

export const HOOT_TICK_POLL_MS = 60_000
export const HOOT_NOTICE_MAX_CHARS = 1800
export const HOOT_FAILURE_NOTICE_AFTER = 3
export const HOOT_DIGEST_DECISION_LINES = 6
// digest に並べる open proposal の行数（全部は Discord に流さない。full list は CLI）
export const HOOT_DIGEST_PROPOSAL_LINES = 3

export type HootDecideInput = {
  prompt: string
  requestId: string
  conversationId: number | null
  instructions: string
}

export type HootDecideResult = {
  text: string
  conversationId: number
}

// main Discord 会話への inject。bot process が chatHandler 経由で実装する（tool を持つのは main 会話だけ）
export type HootInjectInput = {
  content: string
  notice: string
  requestId: string
  proposalKey: string
  injectKey: string
}

export type HootTickDeps = {
  dataDir: string
  devRoot: string
  decide: (input: HootDecideInput) => Promise<HootDecideResult>
  deliver?: (text: string, nonce: string) => Promise<void>
  dispatchInject?: (input: HootInjectInput) => Promise<void>
  redactor: Redactor
  log: (entry: Record<string, unknown>) => void
  nowMs: () => number
  env?: Readonly<Record<string, string | undefined>>
  pollMs?: number
  runCommand?: ObservationDependencies['runCommand']
  observationTimeoutMs?: number
}

export type HootInjectOutcome =
  | { kind: 'nothing' }
  | { kind: 'injected'; injectKey: string; proposalKey: string; attempts: number }
  | { kind: 'failed'; injectKey: string; proposalKey: string; attempts: number; message: string }
  | { kind: 'unavailable'; injectKey: string; message: string }

export type HootTickOutcome =
  | { kind: 'disabled' }
  | { kind: 'no_active_goal' }
  | { kind: 'failure_cooldown'; cooldownUntil: string }
  | { kind: 'goals_review_paused'; goals: string[] }
  | { kind: 'not_due'; occurrenceKey: string; dueAt: string }
  | { kind: 'occurrence_recorded'; occurrenceKey: string }
  | { kind: 'daily_limit'; runsToday: number; maxRunsPerDay: number }
  | { kind: 'already_running' }
  | {
      kind: 'prechecked_noop'
      occurrenceKey: string
      reason: string
      remindersSent: number
      digestSent: boolean
    }
  | {
      kind: 'ran'
      occurrenceKey: string
      decision: HootDecision
      notified: boolean
      proposalKey: string | null
      injectKey: string | null
      injectSkipped: HootInjectSkip | null
      remindersSent: number
      digestSent: boolean
    }
  | { kind: 'failed'; occurrenceKey: string; consecutiveFailures: number; message: string }

function occurrenceKeyOf(plannedAtMs: number) {
  return `hoot:${isoUtc(plannedAtMs)}`
}

function noticeNonce(occurrenceKey: string) {
  return `hoot-${createHash('sha256').update(occurrenceKey).digest('hex').slice(0, 18)}`
}

export function buildHootNotice(run: HootRun, settings: HootSettings) {
  const dispatchedNote = dispatchNoteOf(run.decision, settings)
  const lines = [
    `HOOT 判断 [${run.decision}] ${run.plannedAt}`,
    `REASON: ${run.reason}`,
    `goals: ${run.goalKeys.length > 0 ? run.goalKeys.join(', ') : '（なし）'}`,
    dispatchedNote,
  ]

  if (run.summary !== '') {
    lines.push(`根拠: ${run.summary.split('\n').slice(0, 4).join(' / ')}`)
  }

  if (run.observationGaps.length > 0) {
    lines.push(`observation gaps: ${run.observationGaps.join(' / ')}`)
  }

  return lines.join('\n').slice(0, HOOT_NOTICE_MAX_CHARS)
}

// dispatch が何を意味するかを通知に書く（mode と autoDispatch で変わる）
function dispatchNoteOf(decision: HootDecision, settings: HootSettings) {
  if (decision !== 'dispatch' && decision !== 'investigate') {
    return `mode: ${settings.mode}`
  }

  if (settings.mode === 'dry_run') {
    return 'mode: dry_run（提案の記録だけ。作業は実行していません）'
  }

  if (decision === 'investigate') {
    return 'mode: active（investigate は提案のまま。HOOT 自身が調査を走ることはありません）'
  }

  return settings.autoDispatch
    ? 'mode: active + autoDispatch（次の poll で main Discord 会話へ inject します）'
    : 'mode: active（araya hoot dispatch --key <proposal key>（CLI）か Discord の `hoot dispatch --key <proposal key>` で承認すると main Discord 会話へ inject します）'
}

function buildReviewPauseNotice(goal: HootGoal) {
  return [
    `HOOT goal review: ${goal.key} を自動 paused にしました（reviewAt ${goal.reviewAt}）`,
    '続けるには araya hoot goal resume --key ' + goal.key + '（Discord なら `hoot goal resume --key ' + goal.key + '`）、終わらせるなら araya hoot goal retire --key ' + goal.key + '（`hoot goal retire --key ' + goal.key + '`）',
  ].join('\n').slice(0, HOOT_NOTICE_MAX_CHARS)
}

function buildReminderNotice(proposal: HootProposal, reminderIndex: number, maxReminders: number) {
  return [
    `HOOT 提案の再提醒 ${reminderIndex}/${maxReminders} [${proposal.decision}] ${proposal.key}`,
    `REASON: ${proposal.reason}`,
    `goals: ${proposal.goalKeys.join(', ') || '（なし）'}`,
    `期限: ${proposal.expiresAt}（応答がなければ期限切れになります）`,
  ].join('\n').slice(0, HOOT_NOTICE_MAX_CHARS)
}

function buildDigestNotice(runs: readonly HootRun[], openProposals: readonly HootProposal[], gaps: number, nowMs: number) {
  const counts = new Map<string, number>()

  for (const run of runs) {
    counts.set(run.decision, (counts.get(run.decision) ?? 0) + 1)
  }

  const decisionLines = [...counts.entries()]
    .sort((left, right) => {
      return right[1] - left[1]
    })
    .slice(0, HOOT_DIGEST_DECISION_LINES)
    .map(([decision, count]) => {
      return `${decision}: ${count}`
    })
  const latestRequest = runs.findLast((run) => {
    return run.decision === 'request_human'
  })
  const lines = [
    `HOOT digest ${utcDayKey(nowMs)}`,
    `runs: ${runs.length}（model 判断 ${runs.filter((run) => {
      return run.source === 'model'
    }).length} / precheck noop ${runs.length - runs.filter((run) => {
      return run.source === 'model'
    }).length}）`,
    decisionLines.length > 0 ? decisionLines.join(' / ') : '判断なし',
  ]

  if (latestRequest !== undefined) {
    lines.push(`最新の request_human: ${latestRequest.reason}`)
  }

  lines.push(`open proposals: ${openProposals.length}`)

  for (const proposal of openProposals.slice(0, HOOT_DIGEST_PROPOSAL_LINES)) {
    // 人間が `araya hoot proposal resolve --key <key>` で応答できるよう key をそのまま出す
    lines.push(`  - [${proposal.decision}] ${proposal.key} ${proposal.reason.slice(0, 120)}`)
  }

  if (openProposals.length > HOOT_DIGEST_PROPOSAL_LINES) {
    lines.push(`  （他 ${openProposals.length - HOOT_DIGEST_PROPOSAL_LINES} 件は araya hoot proposal list）`)
  }

  if (gaps > 0) {
    lines.push(`observation gaps: ${gaps} 件`)
  }

  return lines.join('\n').slice(0, HOOT_NOTICE_MAX_CHARS)
}

// model を呼ばずに 1 日の run を数える。precheck noop は model budget を使わない
function modelRunsOfToday(state: HootState, nowMs: number) {
  const day = utcDayKey(nowMs)

  return state.runs.filter((run) => {
    const decidedAt = parseIso(run.decidedAt)

    return run.source === 'model' && decidedAt !== null && utcDayKey(decidedAt) === day
  }).length
}

export function createHootLoop(deps: HootTickDeps) {
  const pollMs = deps.pollMs ?? HOOT_TICK_POLL_MS
  const controller = new AbortController()
  // 実行中 flag だけ memory。連続失敗・cooldown・fingerprint・proposal は state file（durable）
  let running = false

  async function safeObserve(goals: HootState['goals']) {
    const repos = githubReposOf(goals)

    try {
      return await collectGitHubObservations(repos, {
        cwd: deps.devRoot,
        env: deps.env,
        nowMs: deps.nowMs,
        runCommand: deps.runCommand,
        timeoutMs: deps.observationTimeoutMs,
      })
    } catch (error) {
      deps.log({ type: 'hoot_observation_failed', message: deps.redactor.redact(errorMessage(error)) })

      return { collectedAt: isoUtc(deps.nowMs()), repos: [] } satisfies HootObservation
    }
  }

  async function notify(text: string, nonce: string) {
    if (deps.deliver === undefined) {
      return false
    }

    try {
      await deps.deliver(text, nonce)

      return true
    } catch (error) {
      deps.log({ type: 'hoot_notice_failed', nonce, message: deps.redactor.redact(errorMessage(error)) })

      return false
    }
  }

  // review 期限を過ぎた goal を自動 paused にし、goal ごとに 1 件だけ案内する
  async function pauseExpiredGoalsAndNotify(now: number) {
    const paused = await pauseExpiredGoals(deps.dataDir, now)

    for (const goal of paused) {
      deps.log({ type: 'hoot_goal_review_paused', key: goal.key, reviewAt: goal.reviewAt ?? '' })
      await notify(buildReviewPauseNotice(goal), noticeNonce(`review:${goal.key}:${goal.reviewAt ?? ''}`))
    }

    return paused
  }

  // 未解決 proposal の再提醒を 1 件だけ送る（backoff: tickMinutes * 2^n、上限 maxProposalReminders）
  async function sendOneReminder(now: number, everyMs: number) {
    const taken = await takeProposalReminder(deps.dataDir, { nowMs: now, everyMs })

    if (taken === null) {
      return 0
    }

    const state = await readHootState(deps.dataDir)
    const sent = await notify(
      buildReminderNotice(taken.proposal, taken.reminderIndex, state.settings.maxProposalReminders),
      noticeNonce(`reminder:${taken.proposal.key}:${taken.reminderIndex}`)
    )
    deps.log({
      type: 'hoot_proposal_reminder',
      key: taken.proposal.key,
      decision: taken.proposal.decision,
      reminderIndex: taken.reminderIndex,
      sent,
    })

    return 1
  }

  async function sendDigestIfNeeded(now: number) {
    const state = await readHootState(deps.dataDir)
    const settings = state.settings

    if (settings.digestHourUtc === null || utcHour(now) !== settings.digestHourUtc) {
      return false
    }

    const last = parseIso(state.loop.lastDigestAt)

    if (last !== null && utcDayKey(last) === utcDayKey(now)) {
      return false
    }

    const day = utcDayKey(now)
    const runs = state.runs.filter((run) => {
      const decidedAt = parseIso(run.decidedAt)

      return decidedAt !== null && utcDayKey(decidedAt) === day
    })
    const openProposals = state.proposals.filter((proposal) => {
      return proposal.status === 'open'
    })
    const gaps = runs.reduce((total, run) => {
      return total + run.observationGaps.length
    }, 0)
    const sent = await notify(buildDigestNotice(runs, openProposals, gaps, now), noticeNonce(`digest:${day}`))

    if (sent) {
      await recordHootDigest(deps.dataDir, now)
    }

    deps.log({ type: 'hoot_digest', day, runs: runs.length, openProposals: openProposals.length, sent })

    return sent
  }

  // pending inject request を 1 件 main Discord 会話へ渡す。schedule の occurrence とは独立に動く
  // （人間が承認した案件を次の tick まで待たない）
  async function injectOnce(): Promise<HootInjectOutcome> {
    const state = await readHootState(deps.dataDir)

    if (!state.settings.enabled) {
      return { kind: 'nothing' }
    }

    const now = deps.nowMs()
    const taken = await takePendingInject(deps.dataDir, now)

    if (taken === null) {
      return { kind: 'nothing' }
    }

    if (deps.dispatchInject === undefined) {
      const settled = await finishHootInject(deps.dataDir, taken.key, {
        ok: false,
        nowMs: deps.nowMs(),
        error: 'hoot_inject_unavailable: main 会話を持つ Discord bot process で実行してください',
      })
      deps.log({ type: 'hoot_inject_unavailable', injectKey: taken.key, attempts: settled.attempts })

      if (settled.status === 'failed') {
        await notify(
          [
            `HOOT dispatch の inject をできませんでした（proposal: ${taken.proposalKey} / attempt ${settled.attempts}）。main 会話を持つ Discord bot process で動かしてください`,
            `hoot inject list（CLI か Discord）で状態を確認し、必要なら hoot dispatch --key ${taken.proposalKey} で新しい承認を作り直してください（同じ案件は自動で再実行しません）`,
          ].join('\n'),
          noticeNonce(`inject-unavailable:${taken.key}`)
        )
      }

      return {
        kind: 'unavailable',
        injectKey: taken.key,
        message: settled.lastError ?? 'hoot_inject_unavailable',
      }
    }

    // prompt を作るための proposal・goal を取り出し後に読み直す（tick 本体や CLI の変更を反映する）
    const fresh = await readHootState(deps.dataDir)
    const proposal = fresh.proposals.find((entry) => {
      return entry.key === taken.proposalKey
    })

    if (proposal === undefined) {
      const settled = await finishHootInject(deps.dataDir, taken.key, {
        ok: false,
        nowMs: deps.nowMs(),
        error: `hoot_proposal_not_found: proposal ${taken.proposalKey} が state から消えました`,
      })
      deps.log({ type: 'hoot_inject_proposal_missing', injectKey: taken.key, proposalKey: taken.proposalKey })

      if (settled.status === 'failed') {
        await notify(
          [
            `HOOT dispatch の inject をできませんでした（proposal: ${taken.proposalKey} が state から消えました / attempt ${settled.attempts}）`,
            `araya hoot proposal list / araya hoot inject list で状態を確認してください`,
          ].join('\n'),
          noticeNonce(`inject-proposal-missing:${taken.key}`)
        )
      }

      return {
        kind: 'failed',
        injectKey: taken.key,
        proposalKey: taken.proposalKey,
        attempts: settled.attempts,
        message: settled.lastError ?? 'hoot_proposal_not_found',
      }
    }

    const goals = taken.goalKeys
      .map((key) => {
        return fresh.goals.find((goal) => {
          return goal.key === key
        })
      })
      .filter((goal) => {
        return goal !== undefined
      }) as HootGoal[]
    const { content, notice } = buildInjectPrompt({ goals, proposal, request: taken })

    try {
      await deps.dispatchInject({
        content,
        notice,
        requestId: taken.requestId,
        proposalKey: taken.proposalKey,
        injectKey: taken.key,
      })
    } catch (error) {
      const message = deps.redactor.redact(errorMessage(error)).slice(0, MAX_INJECT_ERROR_CHARS)
      const settled = await finishHootInject(deps.dataDir, taken.key, {
        ok: false,
        nowMs: deps.nowMs(),
        error: message,
      })
      deps.log({
        type: 'hoot_inject_failed',
        injectKey: taken.key,
        proposalKey: taken.proposalKey,
        attempts: settled.attempts,
        status: settled.status,
        message,
      })

      if (settled.status === 'failed') {
        await notify(
          [
            `HOOT dispatch の inject に失敗しました（proposal: ${taken.proposalKey} / attempt ${settled.attempts}）`,
            `error: ${message}`,
            `hoot inject list（CLI か Discord）で状態を確認し、必要なら hoot dispatch --key ${taken.proposalKey} で新しい承認を作り直してください（同じ案件は自動で再実行しません）`,
          ].join('\n'),
          noticeNonce(`inject-failed:${taken.key}`)
        )
      }

      return {
        kind: 'failed',
        injectKey: taken.key,
        proposalKey: taken.proposalKey,
        attempts: settled.attempts,
        message,
      }
    }

    const settled = await finishHootInject(deps.dataDir, taken.key, {
      ok: true,
      nowMs: deps.nowMs(),
    })
    deps.log({
      type: 'hoot_inject',
      injectKey: taken.key,
      proposalKey: taken.proposalKey,
      authorizedBy: taken.authorizedBy,
      attempts: settled.attempts,
      contentChars: content.length,
    })

    return { kind: 'injected', injectKey: taken.key, proposalKey: taken.proposalKey, attempts: settled.attempts }
  }

  async function tickOnce(): Promise<HootTickOutcome> {
    if (running) {
      return { kind: 'already_running' }
    }

    const state = await readHootState(deps.dataDir)

    if (!state.settings.enabled) {
      return { kind: 'disabled' }
    }

    const now = deps.nowMs()
    const cooldownUntil = parseIso(state.loop.failureCooldownUntil)

    if (cooldownUntil !== null && cooldownUntil > now) {
      return { kind: 'failure_cooldown', cooldownUntil: state.loop.failureCooldownUntil ?? '' }
    }

    const settings = state.settings
    const everyMs = tickMinutesOf(settings)
    // state file への write は本当に期限切れの goal があるときだけ（60 秒 poll で毎回書き換えない）
    const expiredGoal = state.goals.find((goal) => {
      return goal.status === 'active' && reviewPassed(goal, now)
    })
    const reviewPaused = expiredGoal === undefined ? [] : await pauseExpiredGoalsAndNotify(now)

    if (reviewPaused.length > 0) {
      return {
        kind: 'goals_review_paused',
        goals: reviewPaused.map((goal) => {
          return goal.key
        }),
      }
    }

    const goals = activeGoalsOf(state)

    if (goals.length === 0) {
      return { kind: 'no_active_goal' }
    }

    // 停止中に過ぎた occurrence は catch-up せず、now 以下の最新の occurrence 1 件で判断する
    const lastOccurrenceAt = parseIso(state.loop.lastOccurrenceAt)
    const elapsed = lastOccurrenceAt === null ? 0 : Math.floor((now - lastOccurrenceAt) / everyMs)
    let plannedAt: number
    let missedOccurrences = 0

    if (lastOccurrenceAt === null) {
      plannedAt = now
    } else if (elapsed < 1) {
      plannedAt = lastOccurrenceAt + everyMs
    } else {
      plannedAt = lastOccurrenceAt + elapsed * everyMs
      missedOccurrences = elapsed - 1
    }

    const occurrenceKey = occurrenceKeyOf(plannedAt)

    if (plannedAt > now) {
      return { kind: 'not_due', occurrenceKey, dueAt: isoUtc(plannedAt) }
    }

    if (state.runs.some((run) => {
      return run.occurrenceKey === occurrenceKey
    })) {
      // crash などで schedule だけ戻っていない状態。同じ occurrence を再び走らせない
      await updateHootState(deps.dataDir, (next) => {
        next.loop.lastOccurrenceAt = isoUtc(plannedAt)
      })

      return { kind: 'occurrence_recorded', occurrenceKey }
    }

    const runsToday = modelRunsOfToday(state, now)

    if (runsToday >= settings.maxRunsPerDay) {
      return { kind: 'daily_limit', runsToday, maxRunsPerDay: settings.maxRunsPerDay }
    }

    running = true
    const startedAt = now

    try {
      const observation = await safeObserve(goals)
      const gaps = observation.repos.flatMap((repo) => {
        // gh の label に repo を含む gap text はそのまま使う（prefix の重複を避ける）
        return repo.gaps.map((gap) => {
          return gap.includes(repo.repo) ? gap : `${repo.repo}: ${gap}`
        })
      })
      const fingerprints = goalFingerprintsOf(goals, observation.repos)
      const fingerprintsChanged = anyGoalChanged(state.loop.goalFingerprints, fingerprints)
      const lastModelRunAt = parseIso(state.loop.lastModelRunAt)
      const watchdogDue =
        settings.watchdogHours > 0 &&
        (lastModelRunAt === null || lastModelRunAt + settings.watchdogHours * 3_600_000 <= now)

      if (gaps.length > 0) {
        deps.log({ type: 'hoot_observation_gaps', occurrenceKey, gaps: gaps.slice(0, 12) })
      }

      // 変化がない occurrence で model を叩かない（#21「変化がない場合は不要な LLM 呼出しを抑制」）。
      // precheck が発動するのは fingerprint 不変・watchdog 前・**gap なし**のときだけ。観測に gap が
      // 1 件でもある occurrence は precheck しない（証拠が欠けている状態で code 側の noop を確定させず、
      // model 側に request_human を出す機会を残す。model 呼び出しは maxRunsPerDay で抑止し、件数は digest に出す）
      const prechecked =
        settings.precheckObservation && !fingerprintsChanged && !watchdogDue && gaps.length === 0

      if (prechecked) {
        const run: HootRun = {
          occurrenceKey,
          plannedAt: isoUtc(plannedAt),
          decidedAt: isoUtc(deps.nowMs()),
          source: 'precheck',
          decision: 'noop',
          reason: '観測 fingerprint が前回と同じため model を呼ばない',
          summary: '',
          goalKeys: goals.map((goal) => {
            return goal.key
          }),
          missedOccurrences: Math.min(1000, missedOccurrences),
          dispatched: false,
          observedRepos: observation.repos.map((repo) => {
            return repo.repo
          }),
          observationGaps: [],
        }
        const recorded = await recordHootRun(deps.dataDir, run)

        if (recorded.run.occurrenceKey !== occurrenceKey) {
          deps.log({ type: 'hoot_run_conflict', occurrenceKey })

          return { kind: 'occurrence_recorded', occurrenceKey }
        }

        await updateHootState(deps.dataDir, (next) => {
          next.loop.goalFingerprints = fingerprints
          next.loop.consecutiveFailures = 0
          next.loop.failureCooldownUntil = null
        })

        deps.log({ type: 'hoot_precheck_noop', occurrenceKey, goals: run.goalKeys })

        const remindersSent = await sendOneReminder(deps.nowMs(), everyMs)
        const digestSent = await sendDigestIfNeeded(deps.nowMs())

        return {
          kind: 'prechecked_noop',
          occurrenceKey,
          reason: 'observation_unchanged',
          remindersSent,
          digestSent,
        }
      }

      const reuseConversation =
        settings.resetConversationAfterRuns === 0 || state.loop.conversationRuns < settings.resetConversationAfterRuns

      if (!reuseConversation) {
        deps.log({ type: 'hoot_conversation_reset', conversationRuns: state.loop.conversationRuns })
      }

      const openProposals = state.proposals.filter((proposal) => {
        return proposal.status === 'open'
      })
      const prompt = buildDecisionPrompt({
        goals,
        settings,
        observation,
        recentRuns: state.runs.slice(-PROMPT_RECENT_RUNS),
        openProposals,
        nowMs: plannedAt,
      })
      const decided = await deps.decide({
        prompt,
        requestId: occurrenceKey,
        conversationId: reuseConversation ? state.loop.conversationId : null,
        instructions: HOOT_CONVERSATION_INSTRUCTIONS,
      })
      const parsed = parseDecision(decided.text)
      const decidedAtMs = deps.nowMs()
      const run: HootRun = {
        occurrenceKey,
        plannedAt: isoUtc(plannedAt),
        decidedAt: isoUtc(decidedAtMs),
        source: 'model',
        decision: parsed.decision,
        reason: deps.redactor.redact(parsed.reason).slice(0, MAX_REASON_CHARS),
        summary: deps.redactor.redact(parsed.summary).slice(0, MAX_SUMMARY_CHARS),
        goalKeys: goals.map((goal) => {
          return goal.key
        }),
        missedOccurrences: Math.min(1000, missedOccurrences),
        // 判断 run には tool が無い。P0 では dispatch・investigate も提案の記録だけ
        dispatched: false,
        observedRepos: observation.repos.map((repo) => {
          return repo.repo
        }),
        observationGaps: gaps.slice(0, 12),
      }
      const recorded = await recordHootRun(deps.dataDir, run)

      if (recorded.run.occurrenceKey !== occurrenceKey) {
        deps.log({ type: 'hoot_run_conflict', occurrenceKey })

        return { kind: 'occurrence_recorded', occurrenceKey }
      }

      await updateHootState(deps.dataDir, (next) => {
        next.loop.goalFingerprints = fingerprints
        // lastModelRunAt は recordHootRun が source: 'model' で更新済み
        next.loop.conversationRuns = reuseConversation ? next.loop.conversationRuns + 1 : 1
        // 判断 text が書けたので連続失敗は戻す（invalid も run として記録したので 0 にする）
        next.loop.consecutiveFailures = 0
        next.loop.failureCooldownUntil = null
      })

      if (decided.conversationId !== state.loop.conversationId) {
        // 会話を新しくしたのは tick 側か host 側か。host 側（resume 失敗）も state に新しい id を覚えさせる
        const reason = reuseConversation ? 'host_recreated' : 'threshold'

        if (reuseConversation) {
          deps.log({
            type: 'hoot_conversation_recreated',
            previousConversationId: state.loop.conversationId,
            conversationId: decided.conversationId,
          })
        }

        await setHootConversationId(deps.dataDir, decided.conversationId)
        deps.log({ type: 'hoot_conversation_id_saved', reason, conversationId: decided.conversationId })
      }

      let proposalKey: string | null = null

      if (PROPOSAL_DECISIONS.includes(parsed.decision)) {
        proposalKey = proposalKeyOf({
          goalKeys: run.goalKeys,
          decision: parsed.decision,
        })
        const upserted = await upsertProposal(deps.dataDir, {
          key: proposalKey,
          decision: parsed.decision,
          goalKeys: run.goalKeys,
          reason: run.reason,
          occurrenceKey,
          nowMs: decidedAtMs,
        })

        if (upserted.proposal === null) {
          deps.log({ type: 'hoot_proposal_limit', occurrenceKey, key: proposalKey })
          proposalKey = null
        } else {
          deps.log({
            type: 'hoot_proposal',
            occurrenceKey,
            key: upserted.proposal.key,
            decision: upserted.proposal.decision,
            created: upserted.created,
          })
        }
      }

      // mode=active + autoDispatch のときだけ、dispatch 判断を inject request にする（Issue #31）。
      // dry_run・autoDispatch=false では人間の CLI 承認が無い限り main 会話に流さない
      let injectKey: string | null = null
      let injectSkipped: HootInjectSkip | null = null

      if (
        settings.mode === 'active' &&
        settings.autoDispatch &&
        INJECTABLE_DECISIONS.includes(parsed.decision) &&
        proposalKey !== null
      ) {
        const enqueued = await enqueueHootInject(deps.dataDir, {
          proposalKey,
          authorizedBy: 'mode_active',
          nowMs: decidedAtMs,
        })
        injectKey = enqueued.request?.key ?? null
        injectSkipped = enqueued.skipped

        deps.log({
          type: enqueued.request === null ? 'hoot_inject_skipped' : 'hoot_inject_queued',
          occurrenceKey,
          proposalKey,
          injectKey: enqueued.request?.key ?? null,
          skipped: injectSkipped,
        })
      }

      const shouldNotify = settings.notifyDecisions.includes(parsed.decision)

      if (shouldNotify) {
        await notify(buildHootNotice(recorded.run, settings), noticeNonce(occurrenceKey))
      }

      deps.log({
        type: 'hoot_run',
        occurrenceKey,
        decision: run.decision,
        parsed: parsed.parsed,
        durationMs: decidedAtMs - startedAt,
        missedOccurrences: run.missedOccurrences,
        notify: shouldNotify,
        watchdog: watchdogDue,
      })

      const remindersSent = hasOpenProposals(state) ? await sendOneReminder(deps.nowMs(), everyMs) : 0
      const digestSent = await sendDigestIfNeeded(deps.nowMs())

      return {
        kind: 'ran',
        occurrenceKey,
        decision: run.decision,
        notified: shouldNotify,
        proposalKey,
        injectKey,
        injectSkipped,
        remindersSent,
        digestSent,
      }
    } catch (error) {
      const consecutiveFailures = state.loop.consecutiveFailures + 1
      const cooldownAt = deps.nowMs() + everyMs

      try {
        await updateHootState(deps.dataDir, (next) => {
          next.loop.consecutiveFailures = consecutiveFailures
          next.loop.failureCooldownUntil = isoUtc(cooldownAt)
        })
      } catch (stateError) {
        deps.log({
          type: 'hoot_state_update_failed',
          message: deps.redactor.redact(errorMessage(stateError)),
        })
      }

      deps.log({
        type: 'hoot_run_failed',
        occurrenceKey,
        consecutiveFailures,
        // model・gh 由来の error text は秘密を含みうるので log に書く前に伏せる
        message: deps.redactor.redact(errorMessage(error)).slice(0, 500),
      })

      // 同じ streak の通知を 1 回にする（durable な連続失敗数の 3 件目で 1 件送る）
      if (consecutiveFailures === HOOT_FAILURE_NOTICE_AFTER) {
        await notify(
          `HOOT 判断 run が ${consecutiveFailures} 回続けて失敗しました。araya hoot status と discord.log を確認してください`,
          noticeNonce(`${occurrenceKey}:failure:${consecutiveFailures}`)
        )
      }

      return {
        kind: 'failed',
        occurrenceKey,
        consecutiveFailures,
        message: deps.redactor.redact(errorMessage(error)).slice(0, 500),
      }
    } finally {
      running = false
    }
  }

  async function run() {
    while (!controller.signal.aborted) {
      // inject は schedule より先に処理する（承認済みの案件を次の occurrence まで待たない）
      try {
        await injectOnce()
      } catch (error) {
        deps.log({ type: 'hoot_inject_poll_failed', message: deps.redactor.redact(errorMessage(error)).slice(0, 500) })
      }

      try {
        await tickOnce()
      } catch (error) {
        deps.log({ type: 'hoot_tick_failed', message: deps.redactor.redact(errorMessage(error)).slice(0, 500) })
      }

      await sleep(pollMs, controller.signal)
    }
  }

  function stop() {
    controller.abort()
  }

  return { tickOnce, injectOnce, run, stop }
}

function hasOpenProposals(state: HootState) {
  return state.proposals.some((proposal) => {
    return proposal.status === 'open'
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function sleep(ms: number, signal: AbortSignal) {
  if (signal.aborted) {
    return
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort() {
      clearTimeout(timer)
      resolve()
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}
