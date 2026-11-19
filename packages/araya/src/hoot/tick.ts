// HOOT の Wakeup loop（Issue #21）の最小形。interval だけの schedule occurrence を deterministic に決め、
// 判断 run を 1 回走らせて record し、必要なら Discord へ 1 件送る。
// 実行前の gate（enabled・active goal の有無・daily limit・ occurrence の重複）を model を呼ばずに通過させる。

import { createHash } from 'node:crypto'

import type { Redactor } from '../infrastructure/redaction.ts'
import { collectGitHubObservations, type HootObservation, type ObservationDependencies } from './observe.ts'
import { HOOT_CONVERSATION_INSTRUCTIONS, PROMPT_RECENT_RUNS, buildDecisionPrompt } from './prompt.ts'
import {
  AUTO_DISPATCH_DECISIONS,
  MAX_REASON_CHARS,
  MAX_SUMMARY_CHARS,
  activeGoalsOf,
  githubReposOf,
  isoUtc,
  parseDecision,
  parseIso,
  tickMinutesOf,
  utcDayKey,
  type HootDecision,
  type HootRun,
  type HootState,
} from './model.ts'
import { readHootState, recordHootRun, setHootConversationId, updateHootState } from './store.ts'

export const HOOT_TICK_POLL_MS = 60_000
export const HOOT_NOTICE_MAX_CHARS = 1800
export const HOOT_FAILURE_NOTICE_AFTER = 3

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

export type HootTickDeps = {
  dataDir: string
  devRoot: string
  decide: (input: HootDecideInput) => Promise<HootDecideResult>
  deliver?: (text: string, nonce: string) => Promise<void>
  redactor: Redactor
  log: (entry: Record<string, unknown>) => void
  nowMs: () => number
  env?: Readonly<Record<string, string | undefined>>
  pollMs?: number
  runCommand?: ObservationDependencies['runCommand']
  observationTimeoutMs?: number
}

export type HootTickOutcome =
  | { kind: 'disabled' }
  | { kind: 'no_active_goal' }
  | { kind: 'failure_cooldown'; cooldownUntil: string }
  | { kind: 'not_due'; occurrenceKey: string; dueAt: string }
  | { kind: 'occurrence_recorded'; occurrenceKey: string }
  | { kind: 'daily_limit'; runsToday: number; maxRunsPerDay: number }
  | { kind: 'already_running' }
  | { kind: 'ran'; occurrenceKey: string; decision: HootDecision; notified: boolean }
  | { kind: 'failed'; occurrenceKey: string; consecutiveFailures: number; message: string }

function occurrenceKeyOf(plannedAtMs: number) {
  return `hoot:${isoUtc(plannedAtMs)}`
}

function noticeNonce(occurrenceKey: string) {
  return `hoot-${createHash('sha256').update(occurrenceKey).digest('hex').slice(0, 18)}`
}

export function buildHootNotice(run: HootRun, mode: string) {
  const dispatchedNote =
    AUTO_DISPATCH_DECISIONS.includes(run.decision) && !run.dispatched
      ? `mode: ${mode}（提案の記録だけ。作業は実行していません）`
      : `mode: ${mode}`
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

function runsOfToday(state: HootState, nowMs: number) {
  const day = utcDayKey(nowMs)

  return state.runs.filter((run) => {
    const decidedAt = parseIso(run.decidedAt)

    return decidedAt !== null && utcDayKey(decidedAt) === day
  }).length
}

export function createHootLoop(deps: HootTickDeps) {
  const pollMs = deps.pollMs ?? HOOT_TICK_POLL_MS
  const controller = new AbortController()
  // 実行中 flag だけ memory。連続失敗と cooldown は state file（durable）を追う
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
      return
    }

    try {
      await deps.deliver(text, nonce)
    } catch (error) {
      deps.log({ type: 'hoot_notice_failed', nonce, message: errorMessage(error) })
    }
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

    const goals = activeGoalsOf(state)

    if (goals.length === 0) {
      return { kind: 'no_active_goal' }
    }

    const everyMs = tickMinutesOf(state.settings)
    const lastOccurrenceAt = parseIso(state.loop.lastOccurrenceAt)
    // 停止中に過ぎた occurrence は catch-up せず、now 以下の最新の occurrence 1 件で判断する
    //（restart のたびに古い予定を順に走らせて model を叩かない）
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

    const runsToday = runsOfToday(state, now)

    if (runsToday >= state.settings.maxRunsPerDay) {
      return { kind: 'daily_limit', runsToday, maxRunsPerDay: state.settings.maxRunsPerDay }
    }

    running = true
    const startedAt = now

    try {
      const observation = await safeObserve(goals)
      const prompt = buildDecisionPrompt({
        goals,
        settings: state.settings,
        observation,
        recentRuns: state.runs.slice(-PROMPT_RECENT_RUNS),
        nowMs: plannedAt,
      })
      const decided = await deps.decide({
        prompt,
        requestId: occurrenceKey,
        conversationId: state.loop.conversationId,
        instructions: HOOT_CONVERSATION_INSTRUCTIONS,
      })
      const parsed = parseDecision(decided.text)
      const decidedAtMs = deps.nowMs()
      const gaps = observation.repos.flatMap((repo) => {
        // gh の label に repo を含む gap text はそのまま使う（prefix の重複を避ける）
        return repo.gaps.map((gap) => {
          return gap.includes(repo.repo) ? gap : `${repo.repo}: ${gap}`
        })
      })
      const run: HootRun = {
        occurrenceKey,
        plannedAt: isoUtc(plannedAt),
        decidedAt: isoUtc(decidedAtMs),
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
      if (run.observationGaps.length > 0) {
        deps.log({
          type: 'hoot_observation_gaps',
          occurrenceKey,
          gaps: run.observationGaps,
        })
      }

      const recorded = await recordHootRun(deps.dataDir, run)

      if (recorded.run.occurrenceKey !== occurrenceKey) {
        deps.log({ type: 'hoot_run_conflict', occurrenceKey })

        return { kind: 'occurrence_recorded', occurrenceKey }
      }

      const shouldNotify = parsed.parsed ? parsed.decision !== 'noop' || state.settings.notifyNoop : true

      if (decided.conversationId !== state.loop.conversationId) {
        await setHootConversationId(deps.dataDir, decided.conversationId)
      }

      // 判断が書けたので連続失敗は戻す（invalid も run として記録したので 0 にする）
      await updateHootState(deps.dataDir, (next) => {
        next.loop.consecutiveFailures = 0
        next.loop.failureCooldownUntil = null
      })

      if (shouldNotify) {
        await notify(buildHootNotice(recorded.run, state.settings.mode), noticeNonce(occurrenceKey))
      }

      deps.log({
        type: 'hoot_run',
        occurrenceKey,
        decision: run.decision,
        parsed: parsed.parsed,
        durationMs: decidedAtMs - startedAt,
        missedOccurrences: run.missedOccurrences,
        notify: shouldNotify,
      })

      return { kind: 'ran', occurrenceKey, decision: run.decision, notified: shouldNotify }
    } catch (error) {
      const consecutiveFailures = state.loop.consecutiveFailures + 1
      const cooldownAt = deps.nowMs() + tickMinutesOf(state.settings)

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

  return { tickOnce, run, stop }
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
