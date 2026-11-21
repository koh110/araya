// `araya hoot` CLI。HOOT の goal・settings・判断 run を人間が確認・変更する入口。
// bot process と同時に動かす（state の read-modify-write は store.ts の lock で直列化する）。

import {
  DEFAULT_MAX_RUNS_PER_DAY,
  DEFAULT_TICK_MINUTES,
  HOOT_DECISIONS,
  INJECT_COOLDOWN_MINUTES_MAX,
  INJECT_COOLDOWN_MINUTES_MIN,
  MAX_GOALS,
  MAX_INJECTS_KEPT,
  MAX_INJECTS_PER_DAY_MAX,
  MAX_INJECTS_PER_DAY_MIN,
  MAX_INJECT_ATTEMPTS,
  MAX_RUNS_KEPT,
  TICK_MINUTES_MAX,
  TICK_MINUTES_MIN,
  isoUtc,
  parseIso,
  type HootDecision,
  type HootGoal,
  type HootGoalStatus,
  type HootInjectRequest,
  type HootProposal,
  type HootSettings,
  type HootState,
} from '../hoot/model.ts'
import {
  enqueueHootInject,
  readHootState,
  resolveProposal,
  resetSchedule,
  setGoal,
  setGoalStatus,
  updateSettings,
  hootStateFilePath,
} from '../hoot/store.ts'

export type HootCommandDependencies = {
  dataDir: string
  stdout: (text: string) => void
  nowMs: () => number
}

export type ParsedHootArguments = {
  positionals: string[]
  options: Record<string, string>
}

export function parseHootArguments(args: readonly string[]): ParsedHootArguments {
  const positionals: string[] = []
  const options: Record<string, string> = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === undefined) {
      continue
    }

    if (!arg.startsWith('--')) {
      positionals.push(arg)

      continue
    }

    const name = arg.slice(2)
    const value = args[index + 1]

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`hoot_invalid_argument: --${name} は値が必要です`)
    }

    options[name] = value
    index += 1
  }

  return { positionals, options }
}

function booleanOf(name: string, value: string | undefined) {
  if (value === undefined) {
    return undefined
  }

  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  throw new Error(`hoot_invalid_argument: --${name} は true か false で指定してください`)
}

function listOf(value: string | undefined) {
  if (value === undefined) {
    return undefined
  }

  return value
    .split(',')
    .map((entry) => {
      return entry.trim()
    })
    .filter((entry) => {
      return entry !== ''
    })
}

function decisionsOf(value: string | undefined) {
  const entries = listOf(value)

  if (entries === undefined) {
    return undefined
  }

  const invalid = entries.filter((entry) => {
    return !HOOT_DECISIONS.includes(entry as HootDecision)
  })

  if (invalid.length > 0) {
    throw new Error(`hoot_invalid_argument: --notify-decisions は ${HOOT_DECISIONS.join(' / ')} の組合せにしてください（${invalid.join(', ')}）`)
  }

  return entries as HootDecision[]
}

function integerOf(name: string, value: string | undefined) {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed)) {
    throw new Error(`hoot_invalid_argument: --${name} は integer にしてください`)
  }

  return parsed
}

function goalLine(goal: HootGoal) {
  const lines = [
    `- ${goal.key} [${goal.status}] (updated ${goal.updatedAt})`,
    `  objective: ${goal.objective}`,
  ]

  if (goal.scope.length > 0) {
    lines.push(`  scope: ${goal.scope.join(', ')}`)
  }

  if (goal.constraints.length > 0) {
    lines.push(`  constraints: ${goal.constraints.join(' / ')}`)
  }

  lines.push(`  reviewAt: ${goal.reviewAt ?? 'none'}（過ぎていれば自動 paused）`)

  return lines.join('\n')
}

function proposalLine(proposal: HootProposal) {
  return [
    `- ${proposal.key} [${proposal.status}] ${proposal.decision} goals=${proposal.goalKeys.join(', ') || '（なし）'}`,
    `  reason: ${proposal.reason}`,
    `  created: ${proposal.createdAt} / confirmed: ${proposal.updatedAt} / expires: ${proposal.expiresAt} / reminders: ${proposal.reminders}`,
  ].join('\n')
}

function injectLine(request: HootInjectRequest) {
  const error = request.lastError === null ? '' : ` / lastError: ${request.lastError}`

  return [
    `- ${request.key} [${request.status}] ${request.decision} proposal=${request.proposalKey} goals=${request.goalKeys.join(', ') || '（なし）'}`,
    `  authorized: ${request.authorizedBy} @ ${request.authorizedAt} / attempts: ${request.attempts}/${MAX_INJECT_ATTEMPTS}`,
    `  injectedAt: ${request.injectedAt ?? '（まだ）'}${error}`,
  ].join('\n')
}

function nextOccurrenceOf(state: HootState, nowMs: number) {
  const lastOccurrenceAt = parseIso(state.loop.lastOccurrenceAt)
  const plannedAt = lastOccurrenceAt === null ? nowMs : lastOccurrenceAt + state.settings.tickMinutes * 60_000

  return {
    at: isoUtc(plannedAt),
    due: plannedAt <= nowMs,
    pendingSinceLastRun: lastOccurrenceAt === null,
  }
}

export function formatHootStatus(state: HootState, nowMs: number, dataDir: string) {
  const settings = state.settings
  const active = state.goals.filter((goal) => {
    return goal.status === 'active'
  })
  const next = nextOccurrenceOf(state, nowMs)
  const lastRun = state.runs.at(-1)
  const lines = [
    `state file: ${hootStateFilePath(dataDir)}`,
    `enabled: ${settings.enabled}`,
    `mode: ${settings.mode}（${
      settings.mode === 'dry_run'
        ? '判断の記録だけ。main 会話への inject は作りません'
        : settings.autoDispatch
          ? 'autoDispatch=true: dispatch 判断を inject request にします'
          : 'dispatch は `araya hoot dispatch --key <proposal key>` の承認後に inject します'
    }）`,
    `tickMinutes: ${settings.tickMinutes} / maxRunsPerDay: ${settings.maxRunsPerDay}`,
    `notifyDecisions: ${settings.notifyDecisions.join(', ')} / precheck: ${settings.precheckObservation} / watchdogHours: ${settings.watchdogHours}`,
    `digestHourUtc: ${settings.digestHourUtc ?? 'none'} / resetConversationAfterRuns: ${settings.resetConversationAfterRuns} / goalReviewDays: ${settings.goalReviewDays}`,
    `inject: autoDispatch=${settings.autoDispatch} / maxInjectsPerDay=${settings.maxInjectsPerDay} / cooldown=${settings.injectCooldownMinutes}分`,
    `active goals: ${active.length}/${state.goals.length}（max ${MAX_GOALS}）`,
    ...state.goals.map(goalLine),
    `lastOccurrenceAt: ${state.loop.lastOccurrenceAt ?? '（なし）'}`,
    `next occurrence: ${next.at}${next.due ? '（now 以降は即実行）' : ''}`,
    `lastRunAt: ${state.loop.lastRunAt ?? '（なし）'}`,
    `hoot conversationId: ${state.loop.conversationId ?? '（まだ作っていません）'} / conversationRuns: ${state.loop.conversationRuns}`,
    `lastModelRunAt: ${state.loop.lastModelRunAt ?? '（なし）'} / lastDigestAt: ${state.loop.lastDigestAt ?? '（なし）'}`,
  ]

  const openProposals = state.proposals.filter((proposal) => {
    return proposal.status === 'open'
  })

  if (openProposals.length > 0) {
    lines.push(`open proposals: ${openProposals.length}`)
    lines.push(...openProposals.map(proposalLine))
  }

  if (state.injectRequests.length > 0) {
    const pending = state.injectRequests.filter((request) => {
      return request.status === 'pending'
    }).length
    const injected = state.injectRequests.filter((request) => {
      return request.status === 'injected'
    }).length

    lines.push(
      `inject requests: pending ${pending} / injected ${injected} / failed ${state.injectRequests.length - pending - injected}（保持 ${MAX_INJECTS_KEPT} 件）`
    )
    lines.push(...state.injectRequests.slice(-3).map(injectLine))
  }

  if (lastRun !== undefined) {
    lines.push(
      `last run: ${lastRun.decidedAt} ${lastRun.decision} — ${lastRun.reason}`,
      `  observed: ${lastRun.observedRepos.join(', ') || '（なし）'}`,
      `  gaps: ${lastRun.observationGaps.join(' / ') || '（なし）'}`
    )
  }

  return lines.join('\n')
}

function settingsSummary(settings: HootSettings) {
  return [
    `enabled: ${settings.enabled}`,
    `mode: ${settings.mode}`,
    `tickMinutes: ${settings.tickMinutes}（既定 ${DEFAULT_TICK_MINUTES}、${TICK_MINUTES_MIN}〜${TICK_MINUTES_MAX}）`,
    `maxRunsPerDay: ${settings.maxRunsPerDay}（既定 ${DEFAULT_MAX_RUNS_PER_DAY}。model を呼んだ run だけを数える）`,
    `notifyDecisions: ${settings.notifyDecisions.join(', ')}（即時 Discord に送る decision。他は digest）`,
    `precheckObservation: ${settings.precheckObservation}（観測 fingerprint が同じなら model を呼ばない）`,
    `watchdogHours: ${settings.watchdogHours}（precheck で飛ばしていてもこの時間以内に 1 回は model で見る）`,
    `digestHourUtc: ${settings.digestHourUtc ?? 'none'}（UTC 1 日 1 回の digest。none で無効）`,
    `resetConversationAfterRuns: ${settings.resetConversationAfterRuns}（この model run 数で HOOT 会話を新しくする）`,
    `goalReviewDays: ${settings.goalReviewDays}（新しい goal の review 期限。0 で無期限）`,
    `proposalTtlHours: ${settings.proposalTtlHours} / maxProposalReminders: ${settings.maxProposalReminders}`,
    `autoDispatch: ${settings.autoDispatch}（mode=active のとき dispatch 判断を自動で inject するか。既定 false）`,
    `maxInjectsPerDay: ${settings.maxInjectsPerDay}（1 UTC 日の inject 上限、人間の承認も数える。0 で止め、${MAX_INJECTS_PER_DAY_MIN}〜${MAX_INJECTS_PER_DAY_MAX}）`,
    `injectCooldownMinutes: ${settings.injectCooldownMinutes}（前の inject からの cooldown。0 で無効、${INJECT_COOLDOWN_MINUTES_MIN}〜${INJECT_COOLDOWN_MINUTES_MAX}）`,
  ].join('\n')
}

export async function runHootCommand(args: readonly string[], deps: HootCommandDependencies) {
  const { positionals, options } = parseHootArguments(args)
  // --data-dir を明示指定しない限り ARAYA_DATA_DIR / config の resolution を使う（bot process と同じ file）
  const dataDir = options['data-dir'] ?? deps.dataDir
  const command = positionals[0] ?? 'status'
  const subcommand = positionals[1]
  // subcommand 名を key と取り違えない（--key 必須）。positionals[1] は subcommand なので key にしない
  const key = options.key

  if (command === 'status') {
    const state = await readHootState(dataDir)
    deps.stdout(formatHootStatus(state, deps.nowMs(), dataDir))

    return
  }

  if (command === 'goal') {
    if (subcommand === 'list') {
      const state = await readHootState(dataDir)
      deps.stdout(
        state.goals.length === 0
          ? 'goal はありません。araya hoot goal add --key <key> --objective "<目的>" [--scope github:owner/repo] で追加してください'
          : state.goals.map(goalLine).join('\n')
      )

      return
    }

    if (subcommand === 'add' || subcommand === 'update') {
      if (key === undefined || key === '') {
        throw new Error('hoot_invalid_argument: --key が必要です')
      }

      const objective = options.objective ?? positionals[2]

      if (objective === undefined || objective.trim() === '') {
        throw new Error('hoot_invalid_argument: --objective が必要です')
      }

      const state = await readHootState(dataDir)
      const exists = state.goals.some((goal) => {
        return goal.key === key
      })

      if (subcommand === 'add' && exists) {
        throw new Error(`hoot_goal_exists: goal key ${key} は既にあります（update を使ってください）`)
      }

      if (subcommand === 'update' && !exists) {
        throw new Error(`hoot_goal_not_found: goal key ${key} がありません（add を使ってください）`)
      }

      const existingGoal = state.goals.find((goal) => {
        return goal.key === key
      })
      const scope = listOf(options.scope) ?? existingGoal?.scope
      const constraints = listOf(options.constraint) ?? existingGoal?.constraints
      // --review-at を渡さない限り現在の期限を保つ（goal 編集で review 期限を伸ばさない）。
      // 新しい goal で未指定なら store の settings.goalReviewDays 既定に委ねる（ここで 'none' を強いない）
      const reviewAt =
        options['review-at'] ?? (existingGoal !== undefined ? (existingGoal.reviewAt ?? 'none') : undefined)
      const result = await setGoal(dataDir, { key, objective, scope, constraints, reviewAt }, { replace: true })

      deps.stdout(`${subcommand === 'add' ? '追加' : '更新'}しました:\n${goalLine(result.goal)}`)

      return
    }

    if (subcommand === 'pause' || subcommand === 'resume' || subcommand === 'retire') {
      if (key === undefined || key === '') {
        throw new Error(`hoot_invalid_argument: --key が必要です（araya hoot goal ${subcommand} --key <key>）`)
      }

      const status: HootGoalStatus =
        subcommand === 'pause' ? 'paused' : subcommand === 'resume' ? 'active' : 'retired'
      const goal = await setGoalStatus(dataDir, key, status)
      deps.stdout(`goal ${key} の status を ${goal.status} にしました`)

      return
    }

    throw new Error('hoot_invalid_argument: goal の subcommand は list / add / update / pause / resume / retire')
  }

  if (command === 'settings') {
    if (subcommand === undefined || subcommand === 'show') {
      const state = await readHootState(dataDir)
      deps.stdout(settingsSummary(state.settings))

      return
    }

    if (subcommand === 'set') {
      const mode = options.mode

      if (mode !== undefined && mode !== 'dry_run' && mode !== 'active') {
        throw new Error("hoot_invalid_argument: --mode は dry_run または active")
      }

      const settings = await updateSettings(dataDir, {
        enabled: booleanOf('enabled', options.enabled),
        mode,
        tickMinutes: integerOf('tick-minutes', options['tick-minutes']),
        maxRunsPerDay: integerOf('max-runs-per-day', options['max-runs-per-day']),
        notifyDecisions: decisionsOf(options['notify-decisions']),
        precheckObservation: booleanOf('precheck', options.precheck),
        watchdogHours: integerOf('watchdog-hours', options['watchdog-hours']),
        digestHourUtc:
          options['digest-hour-utc'] === undefined
            ? undefined
            : options['digest-hour-utc'].trim().toLowerCase() === 'none'
              ? null
              : integerOf('digest-hour-utc', options['digest-hour-utc']),
        resetConversationAfterRuns: integerOf(
          'reset-conversation-after-runs',
          options['reset-conversation-after-runs']
        ),
        goalReviewDays: integerOf('goal-review-days', options['goal-review-days']),
        proposalTtlHours: integerOf('proposal-ttl-hours', options['proposal-ttl-hours']),
        maxProposalReminders: integerOf('max-proposal-reminders', options['max-proposal-reminders']),
        autoDispatch: booleanOf('auto-dispatch', options['auto-dispatch']),
        maxInjectsPerDay: integerOf('max-injects-per-day', options['max-injects-per-day']),
        injectCooldownMinutes: integerOf('inject-cooldown-minutes', options['inject-cooldown-minutes']),
      })
      deps.stdout(`settings を更新しました:\n${settingsSummary(settings)}`)

      return
    }

    throw new Error('hoot_invalid_argument: settings の subcommand は show / set')
  }

  if (command === 'proposal') {
    if (subcommand === undefined || subcommand === 'list') {
      const state = await readHootState(dataDir)
      const open = state.proposals.filter((proposal) => {
        return proposal.status === 'open'
      })
      const closed = state.proposals.filter((proposal) => {
        return proposal.status !== 'open'
      })

      if (open.length === 0 && closed.length === 0) {
        deps.stdout('proposal の記録はありません')

        return
      }

      deps.stdout(
        [
          `open ${open.length} / closed ${closed.length}`,
          ...open.map(proposalLine),
          ...closed.slice(-5).map(proposalLine),
        ].join('\n')
      )

      return
    }

    if (subcommand === 'resolve') {
      if (key === undefined || key === '') {
        throw new Error('hoot_invalid_argument: araya hoot proposal resolve --key <key>')
      }

      const proposal = await resolveProposal(dataDir, key)
      deps.stdout(`proposal ${proposal.key} を resolved にしました（[${proposal.decision}]）`)

      return
    }

    throw new Error('hoot_invalid_argument: proposal の subcommand は list / resolve')
  }

  if (command === 'dispatch') {
    if (key === undefined || key === '') {
      throw new Error('hoot_invalid_argument: araya hoot dispatch --key <proposal key>')
    }

    const enqueued = await enqueueHootInject(dataDir, {
      proposalKey: key,
      authorizedBy: 'human',
      nowMs: deps.nowMs(),
    })

    if (enqueued.request === null) {
      const reason = enqueued.skipped ?? 'unknown'
      const guidance: Record<string, string> = {
        cooldown: '前の inject からの cooldown 中です（araya hoot settings set --inject-cooldown-minutes <分> / Discord の /hoot settings set inject-cooldown-minutes:<分>）',
        daily_limit: '1 UTC 日の inject 上限です（araya hoot settings set --max-injects-per-day <件数> / Discord の /hoot settings set max-injects-per-day:<件数>）',
        already_pending: '同じ proposal への inject がまだ未完了です（araya hoot inject list）',
        auto_dispatch_off: 'autoDispatch=false では人間の dispatch だけが inject されます',
      }

      deps.stdout(`inject request を作りませんでした（${reason}）\n  ${guidance[reason] ?? ''}`.trimEnd())

      return
    }

    deps.stdout(
      [
        `inject request を作りました: ${enqueued.request.key}`,
        `  proposal: ${enqueued.request.proposalKey} [${enqueued.request.decision}] goals=${enqueued.request.goalKeys.join(', ') || '（なし）'}`,
        '  Discord bot process が次の poll で main 会話に渡します（bot が動いていないと pending のままです）',
      ].join('\n')
    )

    return
  }

  if (command === 'inject') {
    if (subcommand !== undefined && subcommand !== 'list') {
      throw new Error('hoot_invalid_argument: inject の subcommand は list')
    }

    const state = await readHootState(dataDir)

    if (state.injectRequests.length === 0) {
      deps.stdout(
        `inject request の記録はありません（araya hoot dispatch --key <proposal key> / Discord の /hoot dispatch key:<proposal key> で作ります。保持は直近 ${MAX_INJECTS_KEPT} 件）`
      )

      return
    }

    deps.stdout(
      state.injectRequests
        .slice(-20)
        .reverse()
        .map(injectLine)
        .join('\n')
    )

    return
  }

  if (command === 'runs') {
    const state = await readHootState(dataDir)
    const limit = integerOf('limit', options.limit) ?? 10

    if (state.runs.length === 0) {
      deps.stdout('判断 run の記録はありません')

      return
    }

    const shown = state.runs.slice(-Math.max(1, Math.min(100, limit))).reverse()

    deps.stdout(
      shown
        .map((run) => {
          const gaps = run.observationGaps.length > 0 ? ` gaps: ${run.observationGaps.join(' / ')}` : ''

          return `${run.decidedAt} ${run.decision} [${run.occurrenceKey}]\n  reason: ${run.reason}${gaps}`
        })
        .join('\n')
    )

    return
  }

  if (command === 'reset-schedule') {
    await resetSchedule(dataDir)
    deps.stdout('schedule をリセットしました（次の tick が occurrence になります）')

    return
  }

  throw new Error(
    `hoot_invalid_argument: 不明な command: ${command}（status / goal / settings / proposal / dispatch / inject / runs / reset-schedule、記録の保持は直近 ${MAX_RUNS_KEPT} 件）`
  )
}
