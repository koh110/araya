// HOOT（Human Out of the Loop）の goal・settings・判断 run・inject request の形、検証、decision の解析。
// 仕様は docs/spec/hoot-minimal.md。Issue #10（Discovery / Policy）・#21（Wakeup の判断 loop）の dry-run 範囲と、
// Issue #31（dispatch を main Discord 会話への inject として行う 1A）の state 形を扱う。
// ここには model 呼び出し・schedule・通知の送信・main 会話への submit を入れない。

import { createHash } from 'node:crypto'

export const HOOT_STATE_VERSION = 3
// v1（goal review・precheck・proposal 以前）の file を読み替えるための migration 用 version
export const HOOT_STATE_VERSION_PRECHECK = 1
// v2（inject request 以前）の file を読み替えるための migration 用 version
export const HOOT_STATE_VERSION_INJECT = 2

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

export const WATCHDOG_HOURS_MIN = 1
export const WATCHDOG_HOURS_MAX = 168
export const DEFAULT_WATCHDOG_HOURS = 24
export const DEFAULT_RESET_CONVERSATION_AFTER_RUNS = 24
export const GOAL_REVIEW_DAYS_MIN = 0
export const GOAL_REVIEW_DAYS_MAX = 365
export const DEFAULT_GOAL_REVIEW_DAYS = 30
export const PROPOSAL_TTL_HOURS_MIN = 1
export const PROPOSAL_TTL_HOURS_MAX = 720
export const DEFAULT_PROPOSAL_TTL_HOURS = 72
export const MAX_PROPOSAL_REMINDERS_MIN = 0
export const MAX_PROPOSAL_REMINDERS_MAX = 10
export const DEFAULT_MAX_PROPOSAL_REMINDERS = 3
export const MAX_OPEN_PROPOSALS = 10
export const MAX_PROPOSALS_KEPT = 50
export const MAX_PROPOSAL_EVIDENCE_KEYS = 10
export const DIGEST_HOUR_UTC_MIN = 0
export const DIGEST_HOUR_UTC_MAX = 23
export const DEFAULT_DIGEST_HOUR_UTC = 21
// inject request（main 会話へ流す承認済みの案件）。pending を溜め続けられないための保持上限
export const MAX_INJECTS_KEPT = 20
// 1 件の inject request で submit を試行する回数。crash で pending に戻っても無限に再試行しない
export const MAX_INJECT_ATTEMPTS = 2
export const MAX_INJECTS_PER_DAY_MIN = 0
export const MAX_INJECTS_PER_DAY_MAX = 10
export const DEFAULT_MAX_INJECTS_PER_DAY = 2
export const INJECT_COOLDOWN_MINUTES_MIN = 0
export const INJECT_COOLDOWN_MINUTES_MAX = 1440
export const DEFAULT_INJECT_COOLDOWN_MINUTES = 60
export const MAX_INJECT_ERROR_CHARS = 300

export type HootMode = 'dry_run' | 'active'
export type HootGoalStatus = 'active' | 'paused' | 'retired'

// `invalid` は model が決められない形式で答えたことを表す Araya 側の値。Issue #21 の decision には含まれない
export const HOOT_DECISIONS = ['noop', 'wait', 'investigate', 'dispatch', 'request_human', 'invalid'] as const
export type HootDecision = (typeof HOOT_DECISIONS)[number]

// dispatch・investigate を実行してよいかは mode が決める。dry_run では判断の記録だけ
export const AUTO_DISPATCH_DECISIONS: readonly HootDecision[] = ['investigate', 'dispatch']
// 人間の応答を待つ「未解決の提案」として state に残す decision
export const PROPOSAL_DECISIONS: readonly HootDecision[] = ['investigate', 'dispatch', 'request_human']
// 人間が CLI で resolve / expire できる status
export const HOOT_PROPOSAL_STATUSES = ['open', 'resolved', 'expired'] as const

// 即時に Discord へ送る decision の既定。noop / wait 等は digest で返す
export const DEFAULT_NOTIFY_DECISIONS: readonly HootDecision[] = ['request_human', 'invalid']

// main 会話への inject を認める decision。investigate は proposal のまま（HOOT 自身の調査行為は増やさない）
export const INJECTABLE_DECISIONS: readonly HootDecision[] = ['dispatch']
export const HOOT_INJECT_STATUSES = ['pending', 'injected', 'failed'] as const
export const HOOT_INJECT_AUTHORIZERS = ['human', 'mode_active'] as const

export type HootGoal = {
  key: string
  objective: string
  scope: string[]
  constraints: string[]
  status: HootGoalStatus
  createdAt: string
  updatedAt: string
  // この時刻までに人間が review しないと自動 paused になる（HOOT が空腹を繰り返さないための歯止め）。null で無期限
  reviewAt: string | null
}

export type HootProposalStatus = (typeof HOOT_PROPOSAL_STATUSES)[number]
export type HootInjectStatus = (typeof HOOT_INJECT_STATUSES)[number]
export type HootInjectAuthorizer = (typeof HOOT_INJECT_AUTHORIZERS)[number]

// 人間（または mode=active + autoDispatch）が承認した「main Discord 会話へ流す案件」。
// ここに tool は無い。実行するのは main 会話だけで、HOOT 判断 run は tool を持たないままにする（Issue #31 の 1A）
export type HootInjectRequest = {
  // `hoot-inject:<proposalKey>:<n>`。同じ proposal を人間が再度承認すれば n が上がって新しい key になる
  key: string
  proposalKey: string
  goalKeys: string[]
  decision: HootDecision
  // 'human' は `araya hoot dispatch --key`、'mode_active' は mode=active + autoDispatch の自動承認
  authorizedBy: HootInjectAuthorizer
  authorizedAt: string
  status: HootInjectStatus
  // main 会話の submit の dedupe key（`key` と同じ。attempt を含まない。同じ dispatch を 2 度走らせない）
  requestId: string
  createdAt: string
  updatedAt: string
  attempts: number
  injectedAt: string | null
  // 失敗時の error text（redaction 済み）
  lastError: string | null
}

// 判断 run が出した「人間が応答すべき pending」。dry_run では作業は始めず、提案として保持する
export type HootProposal = {
  // 同じ状況（goal keys + decision + 観測 fingerprint）から作った提案は同じ key に寄せる
  key: string
  decision: HootDecision
  goalKeys: string[]
  reason: string
  createdAt: string
  // 最後にこの状況を確認した時刻
  updatedAt: string
  lastReminderAt: string | null
  reminders: number
  expiresAt: string
  status: HootProposalStatus
  // 根拠になった occurrence key（#22 の evidence 参照の public ID）
  evidenceOccurrenceKeys: string[]
}

export type HootSettings = {
  enabled: boolean
  mode: HootMode
  tickMinutes: number
  maxRunsPerDay: number
  // 即時に Discord へ送る decision。noop / wait 等は digest に出す
  notifyDecisions: HootDecision[]
  // 観測 fingerprint が前回と同じ occurrence では model を呼ばない（#21「変化がなければ呼ばない」）
  precheckObservation: boolean
  // precheck で skip していても、この時間以内に 1 回は model に全体を見させる
  watchdogHours: number
  // digest を送る UTC hour（0〜23）。null で digest 無効
  digestHourUtc: number | null
  // N 回の model run ごとに HOOT 判断会話を新しくする。0 で無効（無限 continuation）
  resetConversationAfterRuns: number
  // 新しい goal に自動で入れる review 期限（日）。0 で無期限
  goalReviewDays: number
  proposalTtlHours: number
  maxProposalReminders: number
  // mode=active のとき、dispatch 判断を自動で inject request にするか。既定 false（人間の承認が要る）
  autoDispatch: boolean
  // 1 UTC 日に main 会話へ inject してよい件数。0 で自動 inject を止める（人間の承認も数える）
  maxInjectsPerDay: number
  // 前の inject request からの cooldown（分）。0 で無効
  injectCooldownMinutes: number
}

export type HootRun = {
  // schedule occurrence そのもの。同じ occurrence の判断 run は 1 件
  occurrenceKey: string
  // 'model' は判断 run を走らせた。'precheck' は観測変化なしで code 側 noop を記録し model を呼ばない
  source: 'model' | 'precheck'
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
  // 実際に model を呼んだ最後の時刻（watchdog の基準）
  lastModelRunAt: string | null
  // digest を送った最後の時刻（1 UTC 日 1 回の抑止）
  lastDigestAt: string | null
  // 現在の HOOT 会話で走らせた model run の数（resetConversationAfterRuns の基準）
  conversationRuns: number
  // goal key -> 最後に観測した fingerprint。precheck はこれと比較する
  goalFingerprints: Record<string, string>
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
  proposals: HootProposal[]
  injectRequests: HootInjectRequest[]
}

export type HootGoalInput = {
  key: string
  objective: string
  scope?: readonly string[]
  constraints?: readonly string[]
  // ISO date（2026-12-01）・ISO datetime・'none'（無期限）。未指定なら settings.goalReviewDays から決める
  reviewAt?: string | null
}

export function parseReviewAt(value: string | undefined | null, nowMs: number, defaultDays: number) {
  if (value === undefined) {
    return defaultDays === 0 ? null : isoUtc(nowMs + defaultDays * 86_400_000)
  }

  if (value === null || value.trim().toLowerCase() === 'none' || value.trim() === '') {
    return null
  }

  const trimmed = value.trim()
  const asDate = /^\d{4}-\d{2}-\d{2}$/u.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed
  const parsed = Date.parse(asDate)

  if (Number.isNaN(parsed)) {
    throw hootError('hoot_goal_invalid', `reviewAt は YYYY-MM-DD または ISO datetime、または 'none' にしてください（${trimmed}）`)
  }

  return isoUtc(parsed)
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
    notifyDecisions: [...DEFAULT_NOTIFY_DECISIONS],
    precheckObservation: true,
    watchdogHours: DEFAULT_WATCHDOG_HOURS,
    digestHourUtc: DEFAULT_DIGEST_HOUR_UTC,
    resetConversationAfterRuns: DEFAULT_RESET_CONVERSATION_AFTER_RUNS,
    goalReviewDays: DEFAULT_GOAL_REVIEW_DAYS,
    proposalTtlHours: DEFAULT_PROPOSAL_TTL_HOURS,
    maxProposalReminders: DEFAULT_MAX_PROPOSAL_REMINDERS,
    autoDispatch: false,
    maxInjectsPerDay: DEFAULT_MAX_INJECTS_PER_DAY,
    injectCooldownMinutes: DEFAULT_INJECT_COOLDOWN_MINUTES,
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
      lastModelRunAt: null,
      lastDigestAt: null,
      conversationRuns: 0,
      goalFingerprints: {},
      conversationId: null,
      consecutiveFailures: 0,
      failureCooldownUntil: null,
    },
    runs: [],
    proposals: [],
    injectRequests: [],
  }
}

export function normalizeGoalInput(
  input: HootGoalInput,
  nowMs = Date.now(),
  defaultReviewDays = DEFAULT_GOAL_REVIEW_DAYS
): HootGoal {
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
    // reviewAt: undefined なら defaultReviewDays（settings.goalReviewDays）から決める。
    // null と 'none' は「無期限」で、既定日数を足し直さない
    reviewAt: parseReviewAt(input.reviewAt, nowMs, defaultReviewDays),
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

export function githubReposOfGoal(goal: HootGoal) {
  const repos = new Set<string>()

  for (const scope of goal.scope) {
    const matched = GITHUB_SCOPE_PATTERN.exec(scope)

    if (matched?.[1] !== undefined) {
      repos.add(matched[1])
    }
  }

  return [...repos].sort()
}

// observe.ts が repo 単位で決める fingerprint（title は noise になるので入れない）。
// 観測に失敗した repo は null → 常に「変化あり」として model を呼ぶ側に倒す
export type RepoFingerprint = {
  repo: string
  fingerprint: string | null
}

export function goalFingerprintOf(goal: HootGoal, repos: readonly RepoFingerprint[]) {
  const parts = githubReposOfGoal(goal).map((repo) => {
    const found = repos.find((entry) => {
      return entry.repo === repo
    })

    return found === undefined || found.fingerprint === null ? `${repo}:unknown` : `${repo}:${found.fingerprint}`
  })
  const goalText = createHash('sha256').update(`${goal.objective}\n${goal.constraints.join('\n')}`).digest('hex').slice(0, 16)

  return createHash('sha256').update(`${goal.updatedAt}|${goalText}|${parts.join(';')}`).digest('hex').slice(0, 16)
}

export function goalFingerprintsOf(goals: readonly HootGoal[], repos: readonly RepoFingerprint[]) {
  const fingerprints: Record<string, string> = {}

  for (const goal of goals) {
    fingerprints[goal.key] = goalFingerprintOf(goal, repos)
  }

  return fingerprints
}

// 前回 fingerprint と比較して、model を呼ぶ必要がある goal が 1 つでもあるか（複数 goal を同時に扱う前提）
export function anyGoalChanged(previous: Record<string, string>, current: Record<string, string>) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])

  for (const key of keys) {
    if ((previous[key] ?? '') !== (current[key] ?? '')) {
      return true
    }
  }

  return false
}

// 同じ goal に対する同じ種類の提案は 1 件に寄せる（人間が応答していない間、観測が変わるたびに積み上がらない）。
// 根拠の occurrence key と観測 fingerprint は evidence として proposal に残す
export function proposalKeyOf(input: {
  goalKeys: readonly string[]
  decision: HootDecision
}) {
  const goalKeys = [...new Set(input.goalKeys)].sort()

  return createHash('sha256').update(`${input.decision}|${goalKeys.join(',')}`).digest('hex').slice(0, 16)
}

// 同じ proposal に対する inject request。人間が再度承認すれば index が上がって新しい key になる
export function injectKeyOf(proposalKey: string, index: number) {
  return `hoot-inject:${proposalKey}:${index}`
}

// 同じ attempt を繰り返さないための requestId。attempt を含まない（上の key そのまま）。
// 同じ key で 2 回 submit しても Pi durable は 1 回だけ実行し、記録済みの answer を返す。失敗 retry
// の回数は attempts 側で数える
export function pendingInjectsOf(state: HootState) {
  return state.injectRequests.filter((request) => {
    return request.status === 'pending' && request.attempts < MAX_INJECT_ATTEMPTS
  })
}

export function reviewPassed(goal: HootGoal, nowMs: number) {
  const reviewAt = parseIso(goal.reviewAt)

  return reviewAt !== null && reviewAt <= nowMs
}

export function utcHour(epochMs: number) {
  return new Date(epochMs).getUTCHours()
}

export function activeGoalsOf(state: HootState) {
  return state.goals.filter((goal) => {
    return goal.status === 'active'
  })
}

export function tickMinutesOf(settings: HootSettings) {
  return settings.tickMinutes * 60_000
}

function isGoalShapeBase(value: unknown): value is HootGoal {
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

function isGoalShape(value: unknown): value is HootGoal {
  if (!isGoalShapeBase(value)) {
    return false
  }

  return value.reviewAt === null || typeof value.reviewAt === 'string'
}

function isBoundedInt(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

// v2 までの settings 形（inject 用の 3 field は任意）。無いものは migration で既定を埋める
function isSettingsShapeBase(value: unknown) {
  if (!isRecord(value)) {
    return false
  }

  const tickMinutes = value.tickMinutes
  const maxRunsPerDay = value.maxRunsPerDay
  const digestHourUtc = value.digestHourUtc

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
    Array.isArray(value.notifyDecisions) &&
    value.notifyDecisions.length <= HOOT_DECISIONS.length &&
    value.notifyDecisions.every((entry) => {
      return HOOT_DECISIONS.includes(entry as HootDecision)
    }) &&
    typeof value.precheckObservation === 'boolean' &&
    isBoundedInt(value.watchdogHours, WATCHDOG_HOURS_MIN, WATCHDOG_HOURS_MAX) &&
    (digestHourUtc === null || isBoundedInt(digestHourUtc, DIGEST_HOUR_UTC_MIN, DIGEST_HOUR_UTC_MAX)) &&
    isBoundedInt(value.resetConversationAfterRuns, 0, 1000) &&
    isBoundedInt(value.goalReviewDays, GOAL_REVIEW_DAYS_MIN, GOAL_REVIEW_DAYS_MAX) &&
    isBoundedInt(value.proposalTtlHours, PROPOSAL_TTL_HOURS_MIN, PROPOSAL_TTL_HOURS_MAX) &&
    isBoundedInt(value.maxProposalReminders, MAX_PROPOSAL_REMINDERS_MIN, MAX_PROPOSAL_REMINDERS_MAX) &&
    (value.autoDispatch === undefined || typeof value.autoDispatch === 'boolean') &&
    (value.maxInjectsPerDay === undefined ||
      isBoundedInt(value.maxInjectsPerDay, MAX_INJECTS_PER_DAY_MIN, MAX_INJECTS_PER_DAY_MAX)) &&
    (value.injectCooldownMinutes === undefined ||
      isBoundedInt(value.injectCooldownMinutes, INJECT_COOLDOWN_MINUTES_MIN, INJECT_COOLDOWN_MINUTES_MAX))
  )
}

export function isSettingsShapeV2(value: unknown): value is HootSettingsV2 {
  return isSettingsShapeBase(value)
}

export function isSettingsShape(value: unknown): value is HootSettings {
  if (!isSettingsShapeBase(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.autoDispatch === 'boolean' &&
    isBoundedInt(candidate.maxInjectsPerDay, MAX_INJECTS_PER_DAY_MIN, MAX_INJECTS_PER_DAY_MAX) &&
    isBoundedInt(candidate.injectCooldownMinutes, INJECT_COOLDOWN_MINUTES_MIN, INJECT_COOLDOWN_MINUTES_MAX)
  )
}

function isInjectShape(value: unknown): value is HootInjectRequest {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.key === 'string' &&
    value.key !== '' &&
    typeof value.proposalKey === 'string' &&
    value.proposalKey !== '' &&
    isStringArray(value.goalKeys, MAX_GOALS, 64) &&
    HOOT_DECISIONS.includes(value.decision as HootDecision) &&
    HOOT_INJECT_AUTHORIZERS.includes(value.authorizedBy as HootInjectAuthorizer) &&
    typeof value.authorizedAt === 'string' &&
    HOOT_INJECT_STATUSES.includes(value.status as HootInjectStatus) &&
    typeof value.requestId === 'string' &&
    value.requestId !== '' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.attempts === 'number' &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    (value.injectedAt === null || typeof value.injectedAt === 'string') &&
    (value.lastError === null || (typeof value.lastError === 'string' && value.lastError.length <= MAX_INJECT_ERROR_CHARS))
  )
}

function isRunShapeBase(value: unknown): value is HootRun {
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

function isRunShape(value: unknown): value is HootRun {
  if (!isRunShapeBase(value)) {
    return false
  }

  return value.source === 'model' || value.source === 'precheck'
}

function isProposalShape(value: unknown): value is HootProposal {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.key === 'string' &&
    value.key !== '' &&
    HOOT_DECISIONS.includes(value.decision as HootDecision) &&
    isStringArray(value.goalKeys, MAX_GOALS, 64) &&
    typeof value.reason === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.lastReminderAt === null || typeof value.lastReminderAt === 'string') &&
    typeof value.reminders === 'number' &&
    Number.isInteger(value.reminders) &&
    value.reminders >= 0 &&
    typeof value.expiresAt === 'string' &&
    HOOT_PROPOSAL_STATUSES.includes(value.status as HootProposalStatus) &&
    isStringArray(value.evidenceOccurrenceKeys, MAX_PROPOSAL_EVIDENCE_KEYS, 64)
  )
}

function isGoalFingerprints(value: unknown) {
  if (!isRecord(value)) {
    return false
  }

  return Object.entries(value).every(([key, fingerprint]) => {
    return HOOT_GOAL_KEY_PATTERN.test(key) && typeof fingerprint === 'string' && fingerprint.length <= 64
  })
}

// loop の共通形（version 1 / 2 で追加フィールドが違う）
function isLoopBase(loop: Record<string, unknown>) {
  return (
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
    (loop.failureCooldownUntil === null || typeof loop.failureCooldownUntil === 'string')
  )
}

// version 1（precheck・proposal・goal review のない state file）
export type HootSettingsV1 = {
  enabled: boolean
  mode: HootMode
  tickMinutes: number
  maxRunsPerDay: number
  // version 1 の flag。手で直した file などでは無いこともあり、無い場合は notifyDecisions の既定を使う
  notifyNoop?: boolean
}

export type HootStateV1 = {
  version: number
  settings: HootSettingsV1
  goals: Omit<HootGoal, 'reviewAt'>[]
  loop: Omit<HootLoopState, 'lastModelRunAt' | 'lastDigestAt' | 'conversationRuns' | 'goalFingerprints'>
  runs: Omit<HootRun, 'source'>[]
}

// version 2（precheck・proposal・goal review あり、inject request なし）。v3 への migration 入力
export type HootSettingsV2 = Omit<HootSettings, 'autoDispatch' | 'maxInjectsPerDay' | 'injectCooldownMinutes'>

export type HootStateV2 = {
  version: number
  settings: HootSettingsV2
  goals: HootGoal[]
  loop: HootLoopState
  runs: HootRun[]
  proposals: HootProposal[]
}

export function isHootStateShapeV1(value: unknown): value is HootStateV1 {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION_PRECHECK) {
    return false
  }

  const loop = value.loop

  return (
    isRecord(loop) &&
    isLoopBase(loop) &&
    Array.isArray(value.goals) &&
    value.goals.length <= MAX_GOALS &&
    value.goals.every(isGoalShapeBase) &&
    Array.isArray(value.runs) &&
    value.runs.every(isRunShapeBase)
  )
}

// goals・loop・runs・proposals の形は v2 と同じ。settings の検証だけ version で変える
function isStateBodyShape(value: Record<string, unknown>, settingsOk: (candidate: unknown) => boolean) {
  const loop = value.loop

  return (
    settingsOk(value.settings) &&
    Array.isArray(value.goals) &&
    value.goals.length <= MAX_GOALS &&
    value.goals.every(isGoalShape) &&
    isRecord(loop) &&
    isLoopBase(loop) &&
    (loop.lastModelRunAt === null || typeof loop.lastModelRunAt === 'string') &&
    (loop.lastDigestAt === null || typeof loop.lastDigestAt === 'string') &&
    isBoundedInt(loop.conversationRuns, 0, 100000) &&
    isGoalFingerprints(loop.goalFingerprints) &&
    Array.isArray(value.runs) &&
    value.runs.every(isRunShape) &&
    Array.isArray(value.proposals) &&
    value.proposals.length <= MAX_PROPOSALS_KEPT &&
    value.proposals.every(isProposalShape)
  )
}

// version 2（inject request のない state file）。version 3 の migration 入力に使う
export function isHootStateShapeV2(value: unknown): value is HootStateV2 {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION_INJECT) {
    return false
  }

  return isStateBodyShape(value, isSettingsShapeV2)
}

export function isHootStateShape(value: unknown): value is HootState {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION) {
    return false
  }

  if (!isStateBodyShape(value, isSettingsShape)) {
    return false
  }

  return (
    Array.isArray(value.injectRequests) &&
    value.injectRequests.length <= MAX_INJECTS_KEPT &&
    value.injectRequests.every(isInjectShape)
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
// v1 settings（notifyNoop のみ）を読むための検査。値は migration で v2 に寄せる
export function isSettingsShapeV1(value: unknown): value is HootSettingsV1 {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.enabled === 'boolean' &&
    (value.mode === 'dry_run' || value.mode === 'active') &&
    isBoundedInt(value.tickMinutes, TICK_MINUTES_MIN, TICK_MINUTES_MAX) &&
    isBoundedInt(value.maxRunsPerDay, MAX_RUNS_PER_DAY_MIN, MAX_RUNS_PER_DAY_MAX) &&
    (value.notifyNoop === undefined || typeof value.notifyNoop === 'boolean')
  )
}

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
