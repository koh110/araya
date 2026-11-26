// HOOT（Human Out of the Loop）の goal・settings・判断 run・inject request の形、検証、decision の解析。
// 仕様は docs/spec/hoot-minimal.md。Issue #10（Discovery / Policy）・#21（Wakeup の判断 loop）の dry-run 範囲と、
// Issue #31（dispatch を main Discord 会話への inject として行う 1A）の state 形を扱う。
// ここには model 呼び出し・schedule・通知の送信・main 会話への submit を入れない。

import { createHash } from 'node:crypto'

export const HOOT_STATE_VERSION = 5
// v1（goal review・precheck・proposal 以前）の file を読み替えるための migration 用 version
export const HOOT_STATE_VERSION_PRECHECK = 1
// v2（inject request 以前）の file を読み替えるための migration 用 version
export const HOOT_STATE_VERSION_INJECT = 2
// v3（main 会話を読む tool の settings と run の参照記録以前）の file を読み替えるための migration 用 version
export const HOOT_STATE_VERSION_PRE_CONVERSATION_READ = 3
// v4（delivery 後の effect を確かめる observation snapshot・inject の evidence key 以前）の migration 用 version
export const HOOT_STATE_VERSION_PRE_OBSERVATION_EVIDENCE = 4

export const HOOT_GOAL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
export const HOOT_GOAL_KEY_RULE = 'lowercase alphanumeric with `-` separators, 1-64 characters'
export const GITHUB_SCOPE_PATTERN = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u
// snapshot の repo 名と number 文字列の bound（observe.ts の REPO_PATTERN と同じ形）
const GITHUB_SCOPE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const SNAPSHOT_NUMBER_PATTERN = /^\d{1,12}$/u
// occurrence snapshot の key は生成側（tick の occurrenceKeyOf = `hoot:${isoUtc(...)}`）の形式だけ受理する。
// 識別子ではない text（改行入りの external text など）を state file 経由で evidence の表示・prompt に入れないため
export const OCCURRENCE_KEY_PATTERN = /^hoot:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

export function isOccurrenceKey(value: unknown) {
  return typeof value === 'string' && OCCURRENCE_KEY_PATTERN.test(value)
}

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
// delivery 後の effect を open list の変化で確かめる observation snapshot の bound。
// observe.ts の OBSERVATION_REPOS_MAX / OBSERVATION_ITEM_LIMIT と揃える（test で一致を固定する）
export const OBSERVATION_SNAPSHOT_REPOS_MAX = 6
export const OBSERVATION_SNAPSHOT_ITEMS_MAX = 30
export const OBSERVATION_SNAPSHOTS_KEPT = 8
// delivery 時点の evidence（inject request の deliveredEvidenceKey）が指す snapshot は window から落とさない。
// pinned になれるのは inject request の数までなので、合計はこの bound を超えない
export const OBSERVATION_SNAPSHOTS_MAX = OBSERVATION_SNAPSHOTS_KEPT + MAX_INJECTS_KEPT
// goal に出す evidence delivery の上限（直近 3 件）
export const MAX_GOAL_EVIDENCE_DELIVERIES = 3
// 1 件の inject request で submit を試行する回数。crash で pending に戻っても無限に再試行しない
export const MAX_INJECT_ATTEMPTS = 2
export const MAX_INJECTS_PER_DAY_MIN = 0
export const MAX_INJECTS_PER_DAY_MAX = 10
export const DEFAULT_MAX_INJECTS_PER_DAY = 2
export const INJECT_COOLDOWN_MINUTES_MIN = 0
export const INJECT_COOLDOWN_MINUTES_MAX = 1440
export const DEFAULT_INJECT_COOLDOWN_MINUTES = 60
export const MAX_INJECT_ERROR_CHARS = 300

// 判断 run が main Discord 会話の transcript を読む tool（read_conversation）の settings gate
export const DEFAULT_CONVERSATION_READ = false

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

// main 会話への inject を認める decision。HOOT の判断 run には tool が無いので、調査も dispatch も
// 実行するのは main 会話。investigate は承認（人間の dispatch か autoDispatch）で read-only 調査案件になる
export const INJECTABLE_DECISIONS: readonly HootDecision[] = ['investigate', 'dispatch']
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
  // delivery（main 会話への inject）が届いた時点で届いていた観測 occurrence key。失敗した request は null
  deliveredEvidenceKey: string | null
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
  // 判断 run に main 会話 transcript を読む read-only tool（read_conversation）を渡すか。既定 false
  conversationRead: boolean
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
  // read_conversation で main 会話 transcript を参照した量（tool を使わなかった run は 0）
  conversationReads: HootConversationReads
}

// 判断 run 1 回の tool 参照の実績（監査用。hoot runs と /hoot runs に出す）
export type HootConversationReads = {
  calls: number
  entries: number
  chars: number
}

export const EMPTY_CONVERSATION_READS: HootConversationReads = { calls: 0, entries: 0, chars: 0 }

export function conversationReadsOf(calls: number, entries: number, chars: number): HootConversationReads {
  return {
    calls: Math.max(0, Math.trunc(calls)),
    entries: Math.max(0, Math.trunc(entries)),
    chars: Math.max(0, Math.trunc(chars)),
  }
}

// ---- delivery 後の effect を確かめる observation snapshot（Issue #10 acceptance 5）----
// title など external text は入れない。open 件数・number list・fingerprint・時刻だけ保持する
export type HootRepoSnapshot = {
  repo: string
  openIssues: number | null
  openPrs: number | null
  draftPrs: number | null
  // open list の number だけ（title は入れない。PR draft も number だけで表す）
  issueNumbers: string[]
  prNumbers: string[]
  // 観測に gap がある repo は null（比較の side として使わない）
  fingerprint: string | null
}

export type HootObservationSnapshot = {
  // model を呼んだ occurrence にも precheck noop の occurrence にも付く（hoot:<ISO>）
  occurrenceKey: string
  observedAt: string
  repos: HootRepoSnapshot[]
}

// delivery 以前の snapshot と delivery 以降の snapshot の比較。open list の membership 変化だけで
// closed / merged の区別は観測していない（消えた reason を推測しない）
export type HootGoalEvidenceDelta = {
  repo: string
  // before の open list にあって after に無い number
  closedIssues: string[]
  closedPrs: string[]
  // after の open list にあって before に無い number
  openedIssues: string[]
  openedPrs: string[]
  // 比較に使った snapshot の occurrence key（観測 gap などで比較できない場合は空 string）
  beforeKey: string
  afterKey: string
}

export type HootGoalEvidenceDelivery = {
  injectKey: string
  proposalKey: string
  decision: HootDecision
  injectedAt: string
  // delivery 時点までに届いていた snapshot の occurrence key。無ければ null（evidence 未取得）
  deliveredEvidenceKey: string | null
  delta: HootGoalEvidenceDelta[]
}

export type HootGoalEvidence = {
  goalKey: string
  deliveries: HootGoalEvidenceDelivery[]
}

// 表示用の number list は long-lived な prompt を伸ばさない bound
export const MAX_EVIDENCE_NUMBERS_SHOWN = 8

function evidenceNumbersText(label: string, kind: string, numbers: readonly string[]) {
  const shown = numbers.slice(0, MAX_EVIDENCE_NUMBERS_SHOWN)
  const rest = numbers.length - shown.length
  const listed = shown.map((entry) => {
    return `#${entry}`
  }).join(' ')

  return `${label} ${kind} ${listed}${rest > 0 ? ` (+${rest})` : ''}`
}

// 「closed / opened」は open list の membership 変化のことで、merged や人間による close だと断定しない
export function goalEvidenceDeltaText(delta: HootGoalEvidenceDelta) {
  const parts: string[] = []

  if (delta.closedIssues.length > 0) {
    parts.push(evidenceNumbersText('closed', 'issue', delta.closedIssues))
  }

  if (delta.openedIssues.length > 0) {
    parts.push(evidenceNumbersText('opened', 'issue', delta.openedIssues))
  }

  if (delta.closedPrs.length > 0) {
    parts.push(evidenceNumbersText('closed', 'PR', delta.closedPrs))
  }

  if (delta.openedPrs.length > 0) {
    parts.push(evidenceNumbersText('opened', 'PR', delta.openedPrs))
  }

  if (parts.length === 0) {
    return 'open list の変化なし'
  }

  return parts.join(' / ')
}

// 参照されている evidence key（delivery 済み request が指す occurrence key）。これらの snapshot は window から落とさない
export function pinnedEvidenceKeysOf(state: HootState): Set<string> {
  const keys = new Set<string>()

  for (const request of state.injectRequests) {
    if (request.deliveredEvidenceKey !== null && request.deliveredEvidenceKey !== '') {
      keys.add(request.deliveredEvidenceKey)
    }
  }

  return keys
}

// snapshot を古い順に保持する（同じ occurrenceKey の書き直しは 1 件に揃える）。
// 直近 OBSERVATION_SNAPSHOTS_KEPT 件 + delivery の evidence が参照している snapshot だけ残す。
// evidence を window から落とすと、goal への効果を確かめる前に before 側が消える（delivery 数時間後に評価できない）
export function appendObservationSnapshot(
  observations: readonly HootObservationSnapshot[],
  snapshot: HootObservationSnapshot,
  pinnedKeys: ReadonlySet<string> = new Set()
): HootObservationSnapshot[] {
  const kept = observations.filter((entry) => {
    return entry.occurrenceKey !== snapshot.occurrenceKey
  })
  kept.push(snapshot)

  const windowStart = Math.max(0, kept.length - OBSERVATION_SNAPSHOTS_KEPT)
  const pruned = kept.filter((entry, index) => {
    return index >= windowStart || pinnedKeys.has(entry.occurrenceKey)
  })

  // pinned になれる数は inject request の数以下なので、ここでは pinned は落ちない
  return pruned.slice(-OBSERVATION_SNAPSHOTS_MAX)
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
  // 直近 OBSERVATION_SNAPSHOTS_KEPT occurrence の観測 snapshot（古い順。number list だけで title は入れない）
  observations: HootObservationSnapshot[]
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

// snapshot には生成側が書く field だけ許可する（未知の field 経由で external text が state file から
// evidence 表示・判断 prompt へ入る経路を作らない）
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => {
    return allowed.includes(key)
  })
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
    conversationRead: DEFAULT_CONVERSATION_READ,
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
      observations: [],
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
    (value.conversationRead === undefined || typeof value.conversationRead === 'boolean') &&
    (value.maxInjectsPerDay === undefined ||
      isBoundedInt(value.maxInjectsPerDay, MAX_INJECTS_PER_DAY_MIN, MAX_INJECTS_PER_DAY_MAX)) &&
    (value.injectCooldownMinutes === undefined ||
      isBoundedInt(value.injectCooldownMinutes, INJECT_COOLDOWN_MINUTES_MIN, INJECT_COOLDOWN_MINUTES_MAX))
  )
}

export function isSettingsShapeV2(value: unknown): value is HootSettingsV2 {
  return isSettingsShapeBase(value)
}

// version 3 の settings（inject 用 field は必須、conversationRead は無い）
export function isSettingsShapeV3(value: unknown): value is HootSettingsV3 {
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

export function isSettingsShape(value: unknown): value is HootSettings {
  if (!isSettingsShapeV3(value)) {
    return false
  }

  return typeof (value as Record<string, unknown>).conversationRead === 'boolean'
}

// version 3・4 の inject request の形（deliveredEvidenceKey を要求しない）。migration 入力に使う
function isInjectShapeBase(value: unknown) {
  if (!isRecord(value)) {
    return false
  }

  // version 4 の file に deliveredEvidenceKey が混んでいる case もここで弾く。正規の occurrence key か null だけ受理する
  if (
    'deliveredEvidenceKey' in value &&
    !(value.deliveredEvidenceKey === null || isOccurrenceKey(value.deliveredEvidenceKey))
  ) {
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

// version 5 の inject request。deliveredEvidenceKey を要求する（無い file は migration で埋めるが、
// 値が壊れているものは黙って直さない）
function isInjectShape(value: unknown): value is HootInjectRequest {
  if (!isInjectShapeBase(value)) {
    return false
  }

  const evidenceKey = (value as Record<string, unknown>).deliveredEvidenceKey

  return evidenceKey === null || isOccurrenceKey(evidenceKey)
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
  if (!isRunShapeV3(value)) {
    return false
  }

  return isConversationReads((value as Record<string, unknown>).conversationReads)
}

// version 2・3 の run（conversationReads が無い）
function isRunShapeV3(value: unknown): value is Omit<HootRun, 'conversationReads'> {
  if (!isRunShapeBase(value)) {
    return false
  }

  return value.source === 'model' || value.source === 'precheck'
}

function isConversationReads(value: unknown): value is HootConversationReads {
  if (!isRecord(value)) {
    return false
  }

  const reads = value as Record<string, unknown>

  return (
    Number.isInteger(reads.calls) &&
    (reads.calls as number) >= 0 &&
    Number.isInteger(reads.entries) &&
    (reads.entries as number) >= 0 &&
    Number.isInteger(reads.chars) &&
    (reads.chars as number) >= 0
  )
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
  loop: Omit<HootLoopStateV4, 'lastModelRunAt' | 'lastDigestAt' | 'conversationRuns' | 'goalFingerprints'>
  runs: Omit<HootRun, 'source'>[]
}

// version 2（precheck・proposal・goal review あり、inject request なし）。v4 への migration 入力
export type HootSettingsV2 = Omit<HootSettings, 'autoDispatch' | 'maxInjectsPerDay' | 'injectCooldownMinutes' | 'conversationRead'>

export type HootStateV2 = {
  version: number
  settings: HootSettingsV2
  goals: HootGoal[]
  loop: HootLoopStateV4
  runs: HootRun[]
  proposals: HootProposal[]
}

// version 3（inject request あり、conversationRead と run の conversationReads が無い）
export type HootSettingsV3 = Omit<HootSettings, 'conversationRead'>

export type HootStateV3 = {
  version: number
  settings: HootSettingsV3
  goals: HootGoal[]
  loop: HootLoopStateV4
  runs: Omit<HootRun, 'conversationReads'>[]
  proposals: HootProposal[]
  injectRequests: HootInjectRequestV4[]
}

// version 4（observation snapshot・deliveredEvidenceKey のない形）。v5 migration の入力
export type HootLoopStateV4 = Omit<HootLoopState, 'observations'>
export type HootInjectRequestV4 = Omit<HootInjectRequest, 'deliveredEvidenceKey'>

export type HootStateV4 = {
  version: number
  settings: HootSettings
  goals: HootGoal[]
  loop: HootLoopStateV4
  runs: HootRun[]
  proposals: HootProposal[]
  injectRequests: HootInjectRequestV4[]
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

// goals・loop・runs・proposals の形は version ごとに異なるので settings と runs の検査を受け取る
function isStateBodyShape(
  value: Record<string, unknown>,
  settingsOk: (candidate: unknown) => boolean,
  runsOk: (candidate: unknown) => boolean
) {
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
    value.runs.every(runsOk) &&
    Array.isArray(value.proposals) &&
    value.proposals.length <= MAX_PROPOSALS_KEPT &&
    value.proposals.every(isProposalShape)
  )
}

function isNullableCount(value: unknown) {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

// snapshot の number list は number 文字列だけ（title・`(draft)` などの飾りは入れない）
function isNumberStrings(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length <= OBSERVATION_SNAPSHOT_ITEMS_MAX &&
    value.every((entry) => {
      return typeof entry === 'string' && SNAPSHOT_NUMBER_PATTERN.test(entry)
    })
  )
}

const REPO_SNAPSHOT_KEYS = ['repo', 'openIssues', 'openPrs', 'draftPrs', 'issueNumbers', 'prNumbers', 'fingerprint'] as const

function isRepoSnapshotShape(value: unknown): value is HootRepoSnapshot {
  if (!isRecord(value)) {
    return false
  }

  if (!hasOnlyKeys(value, REPO_SNAPSHOT_KEYS)) {
    return false
  }

  return (
    typeof value.repo === 'string' &&
    GITHUB_SCOPE_REPO_PATTERN.test(value.repo) &&
    isNullableCount(value.openIssues) &&
    isNullableCount(value.openPrs) &&
    isNullableCount(value.draftPrs) &&
    isNumberStrings(value.issueNumbers) &&
    isNumberStrings(value.prNumbers) &&
    (value.fingerprint === null || (typeof value.fingerprint === 'string' && value.fingerprint.length <= 64))
  )
}

// 壊れた snapshot は hoot_state_invalid にする（migration で黙って捨てない）
export function isObservationsShape(value: unknown): value is HootObservationSnapshot[] {
  if (!Array.isArray(value) || value.length > OBSERVATION_SNAPSHOTS_MAX) {
    return false
  }

  return value.every((entry) => {
    if (!isRecord(entry)) {
      return false
    }

    if (!hasOnlyKeys(entry, ['occurrenceKey', 'observedAt', 'repos'])) {
      return false
    }

    return (
      isOccurrenceKey(entry.occurrenceKey) &&
      typeof entry.observedAt === 'string' &&
      parseIso(entry.observedAt) !== null &&
      Array.isArray(entry.repos) &&
      entry.repos.length <= OBSERVATION_SNAPSHOT_REPOS_MAX &&
      entry.repos.every(isRepoSnapshotShape)
    )
  })
}

// inject request の list 検査。version で required field が違うので entry の検査を受け取る
function isInjectRequestsShape(value: unknown, entryOk: (candidate: unknown) => boolean) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INJECTS_KEPT &&
    value.every(entryOk)
  )
}

// version 2（inject request のない state file）。migration 入力に使う
export function isHootStateShapeV2(value: unknown): value is HootStateV2 {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION_INJECT) {
    return false
  }

  return isStateBodyShape(value, isSettingsShapeV2, isRunShapeV3)
}

// version 3（inject request あり、conversationRead 以前）
export function isHootStateShapeV3(value: unknown): value is HootStateV3 {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION_PRE_CONVERSATION_READ) {
    return false
  }

  if (!isStateBodyShape(value, isSettingsShapeV3, isRunShapeV3)) {
    return false
  }

  return isInjectRequestsShape(value.injectRequests, isInjectShapeBase)
}

// version 4（observation snapshot・deliveredEvidenceKey のない state file）。migration 入力に使う
export function isHootStateShapeV4(value: unknown): value is HootStateV4 {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION_PRE_OBSERVATION_EVIDENCE) {
    return false
  }

  if (!isStateBodyShape(value, isSettingsShape, isRunShape)) {
    return false
  }

  return isInjectRequestsShape(value.injectRequests, isInjectShapeBase)
}

export function isHootStateShape(value: unknown): value is HootState {
  if (!isRecord(value) || value.version !== HOOT_STATE_VERSION) {
    return false
  }

  if (!isStateBodyShape(value, isSettingsShape, isRunShape)) {
    return false
  }

  if (!isObservationsShape((value.loop as Record<string, unknown>).observations)) {
    return false
  }

  return isInjectRequestsShape(value.injectRequests, isInjectShape)
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
