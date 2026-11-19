// HOOT（Human Out of the Loop）の goal・settings・判断 run の形、検証、decision の解析。
// 仕様は docs/spec/hoot-minimal.md。Issue #10（Discovery / Policy）と #21（Wakeup の判断 loop）の
// dry-run 範囲だけを実装する。ここには model 呼び出し・schedule・通知の送信を入れない。

export const HOOT_STATE_VERSION = 1

export const HOOT_GOAL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
export const HOOT_GOAL_KEY_RULE = 'lowercase alphanumeric with `-` separators, 1-64 characters'
export const GITHUB_SCOPE_PATTERN = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u

export const MAX_GOALS = 20
export const MAX_RUNS_KEPT = 200
export const MAX_OBJECTIVE_CHARS = 1500
export const MAX_SCOPE_ENTRIES = 12
export const MAX_SCOPE_CHARS = 200
export const MAX_CONSTRAINT_ENTRIES = 12
export const MAX_CONSTRAINT_CHARS = 300
export const MAX_REASON_CHARS = 300
export const MAX_SUMMARY_CHARS = 700
export const TICK_MINUTES_MIN = 5
export const TICK_MINUTES_MAX = 1440
export const MAX_RUNS_PER_DAY_MIN = 1
export const MAX_RUNS_PER_DAY_MAX = 48

export const DEFAULT_TICK_MINUTES = 60
export const DEFAULT_MAX_RUNS_PER_DAY = 8

export type HootMode = 'dry_run' | 'active'
export type HootGoalStatus = 'active' | 'paused' | 'retired'

// `invalid` は model が決められない形式で答えたことを表す Araya 側の値。Issue #21 の decision には含まれない
export const HOOT_DECISIONS = ['noop', 'wait', 'investigate', 'dispatch', 'request_human', 'invalid'] as const
export type HootDecision = (typeof HOOT_DECISIONS)[number]

// dispatch・investigate を実行してよいかは mode が決める。dry_run では判断の記録だけ
export const AUTO_DISPATCH_DECISIONS: readonly HootDecision[] = ['investigate', 'dispatch']

export type HootGoal = {
  key: string
  objective: string
  scope: string[]
  constraints: string[]
  status: HootGoalStatus
  createdAt: string
  updatedAt: string
}

export type HootSettings = {
  enabled: boolean
  mode: HootMode
  tickMinutes: number
  maxRunsPerDay: number
  // noop も Discord に送るか。既定は false（無変化の通知で channel を埋めない）
  notifyNoop: boolean
}

export type HootRun = {
  // schedule occurrence そのもの。同じ occurrence の判断 run は 1 件
  occurrenceKey: string
  plannedAt: string
  decidedAt: string
  decision: HootDecision
  reason: string
  // model の answer から DECISION / REASON を除いた要約（redaction 済み）
  summary: string
  goalKeys: string[]
  // 停止中に過ぎた occurrence の数（catch-up せず skip した分）
  missedOccurrences: number
  // dry_run では dispatch・investigate も提案だけ。実行したかどうか
  dispatched: boolean
  observedRepos: string[]
  observationGaps: string[]
}

export type HootLoopState = {
  lastOccurrenceAt: string | null
  lastRunAt: string | null
  // HOOT 判断用の conversation（tool 無し）。pi-durable の conversation id（number）。
  // 再起動後に同じ会話を続ける
  conversationId: number | null
  // 判断 run の連続失敗数と cooldown の終了時刻。restart しても壊れた model を叩き続けられないための durable な歯止め
  consecutiveFailures: number
  failureCooldownUntil: string | null
}

export type HootState = {
  version: number
  settings: HootSettings
  goals: HootGoal[]
  loop: HootLoopState
  runs: HootRun[]
}

export type HootGoalInput = {
  key: string
  objective: string
  scope?: readonly string[]
  constraints?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown, limit: number, maxChars: number) {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((entry) => {
      return typeof entry === 'string' && entry.trim() !== '' && entry.length <= maxChars
    })
  )
}

export function hootError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

export function isoUtc(epochMs: number) {
  return new Date(epochMs).toISOString()
}

export function parseIso(value: string | null) {
  if (value === null) {
    return null
  }

  const parsed = Date.parse(value)

  return Number.isNaN(parsed) ? null : parsed
}

// UTC 日のキー（maxRunsPerDay の数えの単位）
export function utcDayKey(epochMs: number) {
  return isoUtc(epochMs).slice(0, 10)
}

export function defaultSettings(): HootSettings {
  return {
    enabled: false,
    mode: 'dry_run',
    tickMinutes: DEFAULT_TICK_MINUTES,
    maxRunsPerDay: DEFAULT_MAX_RUNS_PER_DAY,
    notifyNoop: false,
  }
}

export function defaultState(): HootState {
  return {
    version: HOOT_STATE_VERSION,
    settings: defaultSettings(),
    goals: [],
    loop: {
      lastOccurrenceAt: null,
      lastRunAt: null,
      conversationId: null,
      consecutiveFailures: 0,
      failureCooldownUntil: null,
    },
    runs: [],
  }
}

export function normalizeGoalInput(input: HootGoalInput): HootGoal {
  const key = input.key.trim()
  const objective = input.objective.trim()

  if (!HOOT_GOAL_KEY_PATTERN.test(key)) {
    throw hootError('hoot_goal_invalid', `goal key は ${HOOT_GOAL_KEY_RULE} にしてください（${key}）`)
  }

  if (objective === '') {
    throw hootError('hoot_goal_invalid', 'objective は空にできません')
  }

  if (objective.length > MAX_OBJECTIVE_CHARS) {
    throw hootError('hoot_goal_invalid', `objective は ${MAX_OBJECTIVE_CHARS} 文字までにしてください`)
  }

  const scope = normalizeEntries(input.scope ?? [], MAX_SCOPE_ENTRIES, MAX_SCOPE_CHARS)
  const constraints = normalizeEntries(input.constraints ?? [], MAX_CONSTRAINT_ENTRIES, MAX_CONSTRAINT_CHARS)
  const now = isoUtc(Date.now())

  return {
    key,
    objective,
    scope,
    constraints,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeEntries(values: readonly string[], limit: number, maxChars: number) {
  const trimmed = values
    .map((value) => {
      return value.trim()
    })
    .filter((value) => {
      return value !== ''
    })

  if (trimmed.length > limit) {
    throw hootError('hoot_goal_invalid', `entry は最大 ${limit} 件にしてください`)
  }

  for (const entry of trimmed) {
    if (entry.length > maxChars) {
      throw hootError('hoot_goal_invalid', `entry は最大 ${maxChars} 文字にしてください`)
    }
  }

  return [...new Set(trimmed)]
}

// goal の scope から観測対象の GitHub repository を決める（github:<owner>/<repo>）
export function githubReposOf(goals: readonly HootGoal[]) {
  const repos = new Set<string>()

  for (const goal of goals) {
    for (const scope of goal.scope) {
      const matched = GITHUB_SCOPE_PATTERN.exec(scope)

      if (matched?.[1] !== undefined) {
        repos.add(matched[1])
      }
    }
  }

  return [...repos].sort()
}

export function activeGoalsOf(state: HootState) {
  return state.goals.filter((goal) => {
    return goal.status === 'active'
  })
}

export function tickMinutesOf(settings: HootSettings) {
  return settings.tickMinutes * 60_000
}

function isGoalShape(value: unknown): value is HootGoal {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.key === 'string' &&
    HOOT_GOAL_KEY_PATTERN.test(value.key) &&
    typeof value.objective === 'string' &&
    value.objective !== '' &&
    isStringArray(value.scope, MAX_SCOPE_ENTRIES, MAX_SCOPE_CHARS) &&
    isStringArray(value.constraints, MAX_CONSTRAINT_ENTRIES, MAX_CONSTRAINT_CHARS) &&
    (value.status === 'active' || value.status === 'paused' || value.status === 'retired') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isSettingsShape(value: unknown): value is HootSettings {
  if (!isRecord(value)) {
    return false
  }

  const tickMinutes = value.tickMinutes
  const maxRunsPerDay = value.maxRunsPerDay

  return (
    typeof value.enabled === 'boolean' &&
    (value.mode === 'dry_run' || value.mode === 'active') &&
    typeof tickMinutes === 'number' &&
    Number.isInteger(tickMinutes) &&
    tickMinutes >= TICK_MINUTES_MIN &&
    tickMinutes <= TICK_MINUTES_MAX &&
    typeof maxRunsPerDay === 'number' &&
    Number.isInteger(maxRunsPerDay) &&
    maxRunsPerDay >= MAX_RUNS_PER_DAY_MIN &&
    maxRunsPerDay <= MAX_RUNS_PER_DAY_MAX &&
    typeof value.notifyNoop === 'boolean'
  )
}

function isRunShape(value: unknown): value is HootRun {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.occurrenceKey === 'string' &&
    value.occurrenceKey !== '' &&
    typeof value.plannedAt === 'string' &&
    typeof value.decidedAt === 'string' &&
    HOOT_DECISIONS.includes(value.decision as HootDecision) &&
    typeof value.reason === 'string' &&
    typeof value.summary === 'string' &&
    isStringArray(value.goalKeys, MAX_GOALS, 64) &&
    typeof value.missedOccurrences === 'number' &&
    Number.isInteger(value.missedOccurrences) &&
    value.missedOccurrences >= 0 &&
    typeof value.dispatched === 'boolean' &&
    isStringArray(value.observedRepos, MAX_SCOPE_ENTRIES, MAX_SCOPE_CHARS) &&
    isStringArray(value.observationGaps, MAX_CONSTRAINT_ENTRIES, MAX_CONSTRAINT_CHARS)
  )
}

export function isHootStateShape(value: unknown): value is HootState {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION) {
    return false
  }

  const loop = value.loop

  return (
    isSettingsShape(value.settings) &&
    Array.isArray(value.goals) &&
    value.goals.length <= MAX_GOALS &&
    value.goals.every(isGoalShape) &&
    isRecord(loop) &&
    (loop.lastOccurrenceAt === null || typeof loop.lastOccurrenceAt === 'string') &&
    (loop.lastRunAt === null || typeof loop.lastRunAt === 'string') &&
    (
      loop.conversationId === null ||
      (typeof loop.conversationId === 'number' &&
        Number.isInteger(loop.conversationId) &&
        loop.conversationId >= 1)
    ) &&
    typeof loop.consecutiveFailures === 'number' &&
    Number.isInteger(loop.consecutiveFailures) &&
    loop.consecutiveFailures >= 0 &&
    (loop.failureCooldownUntil === null || typeof loop.failureCooldownUntil === 'string') &&
    Array.isArray(value.runs) &&
    value.runs.every(isRunShape)
  )
}

export type DecisionParse = {
  decision: HootDecision
  reason: string
  summary: string
  parsed: boolean
}

const DECISION_LINE_PATTERN = /^DECISION:\s*([A-Za-z_]+)\s*$/imu
const REASON_LINE_PATTERN = /^REASON:\s*(.*)$/u

// model の answer から DECISION / REASON を読む。形式が無ければ decision = 'invalid'
export function parseDecision(text: string): DecisionParse {
  const lines = text.split(/\r?\n/u)
  let decisionIndex = -1
  let token = ''

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const matched = DECISION_LINE_PATTERN.exec(lines[index] ?? '')

    if (matched?.[1] !== undefined) {
      decisionIndex = index
      token = matched[1].toLowerCase()

      break
    }
  }

  const summaryLines = lines
    .filter((line, index) => {
      return index !== decisionIndex && !REASON_LINE_PATTERN.test(line)
    })
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })
  const summary = summaryLines.join('\n').slice(0, MAX_SUMMARY_CHARS)

  if (decisionIndex < 0) {
    return { decision: 'invalid', reason: 'DECISION 行がありません', summary, parsed: false }
  }

  const decision = (HOOT_DECISIONS as readonly string[]).includes(token)
    ? (token as HootDecision)
    : undefined

  if (decision === undefined) {
    return {
      decision: 'invalid',
      reason: `unknown decision: ${token.slice(0, 40)}`,
      summary,
      parsed: false,
    }
  }

  const reasonLine = lines.slice(decisionIndex + 1).find((line) => {
    return REASON_LINE_PATTERN.test(line)
  })
  const reason = (reasonLine === undefined ? '' : (REASON_LINE_PATTERN.exec(reasonLine)?.[1] ?? '')).trim()

  return {
    decision,
    reason: reason === '' ? 'REASON 行がありません' : reason.slice(0, MAX_REASON_CHARS),
    summary,
    parsed: true,
  }
}
