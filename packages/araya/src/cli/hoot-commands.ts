// `araya hoot` CLI。HOOT の goal・settings・判断 run を人間が確認・変更する入口。
// bot process と同時に動かす（state の read-modify-write は store.ts の lock で直列化する）。

import {
  DEFAULT_MAX_RUNS_PER_DAY,
  DEFAULT_TICK_MINUTES,
  MAX_GOALS,
  MAX_RUNS_KEPT,
  TICK_MINUTES_MAX,
  TICK_MINUTES_MIN,
  isoUtc,
  parseIso,
  type HootGoal,
  type HootGoalStatus,
  type HootSettings,
  type HootState,
} from '../hoot/model.ts'
import {
  readHootState,
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

  return lines.join('\n')
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
    `mode: ${settings.mode}（dry_run では判断の記録だけ。作業は実行しません）`,
    `tickMinutes: ${settings.tickMinutes} / maxRunsPerDay: ${settings.maxRunsPerDay} / notifyNoop: ${settings.notifyNoop}`,
    `active goals: ${active.length}/${state.goals.length}（max ${MAX_GOALS}）`,
    ...state.goals.map(goalLine),
    `lastOccurrenceAt: ${state.loop.lastOccurrenceAt ?? '（なし）'}`,
    `next occurrence: ${next.at}${next.due ? '（now 以降は即実行）' : ''}`,
    `lastRunAt: ${state.loop.lastRunAt ?? '（なし）'}`,
    `hoot conversationId: ${state.loop.conversationId ?? '（まだ作っていません）'}`,
  ]

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
    `maxRunsPerDay: ${settings.maxRunsPerDay}（既定 ${DEFAULT_MAX_RUNS_PER_DAY}）`,
    `notifyNoop: ${settings.notifyNoop}`,
  ].join('\n')
}

export async function runHootCommand(args: readonly string[], deps: HootCommandDependencies) {
  const { positionals, options } = parseHootArguments(args)
  const command = positionals[0] ?? 'status'
  const subcommand = positionals[1]
  const key = options.key ?? positionals[1]

  if (command === 'status') {
    const state = await readHootState(deps.dataDir)
    deps.stdout(formatHootStatus(state, deps.nowMs(), deps.dataDir))

    return
  }

  if (command === 'goal') {
    if (subcommand === 'list') {
      const state = await readHootState(deps.dataDir)
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

      const state = await readHootState(deps.dataDir)
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
      const result = await setGoal(
        deps.dataDir,
        { key, objective, scope, constraints },
        { replace: true }
      )

      deps.stdout(`${subcommand === 'add' ? '追加' : '更新'}しました:\n${goalLine(result.goal)}`)

      return
    }

    if (subcommand === 'pause' || subcommand === 'resume' || subcommand === 'retire') {
      if (key === undefined || key === '') {
        throw new Error(`hoot_invalid_argument: --key が必要です（araya hoot goal ${subcommand} --key <key>）`)
      }

      const status: HootGoalStatus =
        subcommand === 'pause' ? 'paused' : subcommand === 'resume' ? 'active' : 'retired'
      const goal = await setGoalStatus(deps.dataDir, key, status)
      deps.stdout(`goal ${key} の status を ${goal.status} にしました`)

      return
    }

    throw new Error('hoot_invalid_argument: goal の subcommand は list / add / update / pause / resume / retire')
  }

  if (command === 'settings') {
    if (subcommand === undefined || subcommand === 'show') {
      const state = await readHootState(deps.dataDir)
      deps.stdout(settingsSummary(state.settings))

      return
    }

    if (subcommand === 'set') {
      const mode = options.mode

      if (mode !== undefined && mode !== 'dry_run' && mode !== 'active') {
        throw new Error("hoot_invalid_argument: --mode は dry_run または active")
      }

      const settings = await updateSettings(deps.dataDir, {
        enabled: booleanOf('enabled', options.enabled),
        mode,
        tickMinutes: integerOf('tick-minutes', options['tick-minutes']),
        maxRunsPerDay: integerOf('max-runs-per-day', options['max-runs-per-day']),
        notifyNoop: booleanOf('notify-noop', options['notify-noop']),
      })
      deps.stdout(`settings を更新しました:\n${settingsSummary(settings)}`)

      return
    }

    throw new Error('hoot_invalid_argument: settings の subcommand は show / set')
  }

  if (command === 'runs') {
    const state = await readHootState(deps.dataDir)
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
    await resetSchedule(deps.dataDir)
    deps.stdout('schedule をリセットしました（次の tick が occurrence になります）')

    return
  }

  throw new Error(
    `hoot_invalid_argument: 不明な command: ${command}（status / goal / settings / runs / reset-schedule、記録の保持は直近 ${MAX_RUNS_KEPT} 件）`
  )
}
