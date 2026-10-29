import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { TextDecoder } from 'node:util'

import { isThinkingLevel, type DevelopmentModel } from './development-model.ts'
import { createRedactor } from './redaction.ts'

// Task の台帳（<dataDir>/tasks.sqlite）。CLI と runner の両方が開く。pi-durable と systemd は import しない
// 書き込みはすべて同期の BEGIN IMMEDIATE の transaction で行い、transaction の中で待機や process の起動をしない

// 同時に running にできる試行の数。runner の取り込みと CLI の queue.limit がこの値を使う
export const MAX_CONCURRENT_ATTEMPTS = 1
export const LEDGER_SCHEMA_VERSION = 1
export const LEDGER_FILE_NAME = 'tasks.sqlite'

export const TASK_STATUSES = ['queued', 'running', 'completed', 'failed', 'blocked'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const STOP_REASONS = ['agent_timeout', 'cancelled', 'restart_limit', 'attempt_error'] as const
export type StopReason = (typeof STOP_REASONS)[number]

export const MAX_TASK_INPUT_BYTES = 256 * 1024
export const MAX_NOTE_CHARS = 10_000
const MAX_TITLE_CHARS = 200
const MAX_GOAL_CHARS = 20_000
const MAX_CONSTRAINTS = 32
const MAX_CONSTRAINTS_TOTAL_CHARS = 10_000
const MAX_TARGETS = 16
const MAX_TARGET_CHARS = 200
const MAX_PERMISSIONS = 16
const MAX_PERMISSIONS_TOTAL_CHARS = 5_000
const MAX_IDEMPOTENCY_KEY_CHARS = 200
const TASK_INPUT_KEYS = ['title', 'goal', 'constraints', 'targets', 'permissions', 'idempotencyKey'] as const

const MAX_SUMMARY_CHARS = 4_000
const MAX_STOP_DETAIL_CHARS = 2_000
const MAX_TOOL_EVENTS_PER_ATTEMPT = 2_000
const MAX_EVENT_DATA_BYTES = 2 * 1024
const RUNNER_NOT_RESPONDING_MS = 60_000

const TASK_KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const TASK_KEY_SUFFIX_CHARS = 6

// 途中で止まった試行の失敗の理由（再実行に --confirm-side-effects が要る）
const INTERRUPTED_FAILURE_REASONS = [
  'cancelled',
  'restart_limit',
  'attempt_error',
  'termination_unconfirmed',
  'agent_timeout',
  'agent_failed'
]

const SCHEMA_V1 = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind = 'development'),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
  current_attempt INTEGER NOT NULL CHECK (current_attempt >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  task_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked')),
  note TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  agent_finished_at TEXT,
  finished_at TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  cancel_requested_at TEXT,
  stop_reason TEXT CHECK (stop_reason IN ('agent_timeout', 'cancelled', 'restart_limit', 'attempt_error')),
  stop_detail TEXT,
  settings_json TEXT,
  state_dir TEXT,
  model_json TEXT,
  summary TEXT,
  decision_question TEXT,
  failure_reason TEXT,
  failure_detail TEXT,
  evidence_json TEXT,
  PRIMARY KEY (task_id, attempt)
);

CREATE INDEX idx_runs_status ON runs (status, queued_at);

CREATE TABLE task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  attempt INTEGER,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX idx_task_events_task ON task_events (task_id, seq);

CREATE TABLE runner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  unit TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped')),
  invocation_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  stopped_at TEXT
);
`

export type LedgerErrorCode =
  | 'invalid_task_input'
  | 'invalid_note'
  | 'task_not_found'
  | 'idempotency_conflict'
  | 'task_not_cancellable'
  | 'task_not_retryable'
  | 'side_effects_unconfirmed'
  | 'ledger_unsupported_version'

const LEDGER_ERROR_CODES: readonly LedgerErrorCode[] = [
  'invalid_task_input',
  'invalid_note',
  'task_not_found',
  'idempotency_conflict',
  'task_not_cancellable',
  'task_not_retryable',
  'side_effects_unconfirmed',
  'ledger_unsupported_version'
]

export type WorktreeLocation = { worktreePath: string; branch: string }

export type LedgerError = Error & { code: LedgerErrorCode; previousWorktrees?: WorktreeLocation[] }

export function ledgerError(code: LedgerErrorCode, message: string, extra: { previousWorktrees?: WorktreeLocation[] } = {}) {
  const error: LedgerError = Object.assign(new Error(`${code}: ${message}`), { code }, extra)

  return error
}

export function isLedgerError(error: unknown): error is LedgerError {
  return error instanceof Error &&
    'code' in error &&
    LEDGER_ERROR_CODES.some((code) => {
      return code === error.code
    })
}

export type TaskInput = {
  title: string
  goal: string
  constraints: string[]
  targets: string[]
  permissions: string[]
  idempotencyKey: string | null
}

// 取り込みのときに決める試行の設定（runs.settings_json）
export type AttemptSettings = {
  devRoot: string
  agentDir: string
  model: DevelopmentModel | null
  timeoutMs: number
  verificationTimeoutMs: number
}

// 試行の task が返し、runner が台帳に記録する試行の結果。evidence は本文を除いたもの
export type AttemptResult = {
  status: 'completed' | 'failed' | 'blocked'
  failureReason: string | null
  failureDetail: string | null
  summary: string | null
  decisionQuestion: string | null
  model: Record<string, unknown> | null
  evidence: Record<string, unknown>
}

// runner がその試行を動かしていた時間のうち、まだ active_ms に足していない分
export type Settlement = { taskKey: string; addMs: number }

export type TaskSummary = {
  id: number
  title: string
  status: TaskStatus
  attempt: number
  failureReason: string | null
  decisionQuestion: string | null
  createdAt: string
  updatedAt: string
}

export type TaskView = TaskSummary & {
  goal: string
  constraints: string[]
  targets: string[]
  permissions: string[]
  summary: string | null
  cancelRequested: boolean
}

export type AttemptView = {
  attempt: number
  status: TaskStatus
  taskKey: string
  note: string | null
  queuedAt: string
  startedAt: string | null
  agentFinishedAt: string | null
  finishedAt: string | null
  activeMs: number
  cancelRequestedAt: string | null
  stopReason: StopReason | null
  model: Record<string, unknown> | null
  summary: string | null
  decisionQuestion: string | null
  failureReason: string | null
  failureDetail: string | null
  stateDir: string | null
  evidence: Record<string, unknown> | null
}

export type EventView = {
  seq: number
  attempt: number | null
  at: string
  type: string
  data: Record<string, unknown>
}

export type RunnerState = 'running' | 'stopped' | 'not_responding' | 'not_started'

export type RunnerView = {
  unit: string
  state: RunnerState
  pid: number | null
  startedAt: string | null
  heartbeatAt: string | null
  stoppedAt: string | null
}

export type QueueView = { limit: number; running: number; queued: number }

export type RunningAttempt = {
  taskId: number
  attempt: number
  taskKey: string
  settings: AttemptSettings | null
  activeMs: number
  startedAt: string | null
  agentFinishedAt: string | null
  cancelRequestedAt: string | null
  stopReason: StopReason | null
  stopDetail: string | null
}

export type PreviousAttempt = {
  attempt: number
  status: TaskStatus
  failureReason: string | null
  summary: string | null
  decisionQuestion: string | null
  worktrees: WorktreeLocation[]
  // 途中で止まった試行（再実行の注意の1行を課題の本文に入れる）
  interrupted: boolean
}

export type ClaimedAttempt = {
  taskId: number
  attempt: number
  taskKey: string
  title: string
  goal: string
  constraints: string[]
  targets: string[]
  permissions: string[]
  note: string | null
  settings: AttemptSettings
  previous: PreviousAttempt | null
}

export type ToolEventType = 'tool.started' | 'tool.finished'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNonWhitespace(text: string) {
  return /\S/u.test(text)
}

function invalidInput(message: string) {
  return ledgerError('invalid_task_input', message)
}

function parseRequiredText(value: unknown, key: string, maxChars: number) {
  if (typeof value !== 'string') {
    throw invalidInput(`${key} must be a string`)
  }

  if (!hasNonWhitespace(value)) {
    throw invalidInput(`${key} must contain a non-whitespace character`)
  }

  if (value.length > maxChars) {
    throw invalidInput(`${key} must be at most ${maxChars} characters`)
  }

  if (value.includes('\0')) {
    throw invalidInput(`${key} must not contain NUL`)
  }

  return value
}

function parseTextList(
  value: unknown,
  key: string,
  limits: { maxItems: number; maxItemChars?: number; maxTotalChars?: number }
) {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    throw invalidInput(`${key} must be an array of strings`)
  }

  if (value.length > limits.maxItems) {
    throw invalidInput(`${key} must have at most ${limits.maxItems} items`)
  }

  const items = value.map((item: unknown, index) => {
    return parseRequiredText(item, `${key}[${index}]`, limits.maxItemChars ?? Number.MAX_SAFE_INTEGER)
  })
  const totalChars = items.reduce((sum, item) => {
    return sum + item.length
  }, 0)

  if (limits.maxTotalChars !== undefined && totalChars > limits.maxTotalChars) {
    throw invalidInput(`${key} must be at most ${limits.maxTotalChars} characters in total`)
  }

  return items
}

// araya task create の入力（UTF-8 の JSON 1件）を検証する
export function parseTaskInput(raw: Uint8Array) {
  if (raw.byteLength > MAX_TASK_INPUT_BYTES) {
    throw invalidInput(`the input exceeds ${MAX_TASK_INPUT_BYTES} bytes`)
  }

  let text: string

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw invalidInput('the input is not valid UTF-8')
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidInput('the input is not valid JSON')
  }

  if (!isRecord(parsed)) {
    throw invalidInput('the input must be a JSON object')
  }

  const unknownKeys = Object.keys(parsed).filter((key) => {
    return !TASK_INPUT_KEYS.some((allowed) => {
      return allowed === key
    })
  })

  if (unknownKeys.length > 0) {
    throw invalidInput(`unknown key(s): ${unknownKeys.join(', ')}`)
  }

  const title = parseRequiredText(parsed.title, 'title', MAX_TITLE_CHARS)

  if (/[\n\r]/u.test(title)) {
    throw invalidInput('title must not contain a line break')
  }

  const idempotencyKey = parsed.idempotencyKey
  let parsedKey: string | null = null

  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      throw invalidInput(`idempotencyKey must be a string of 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters`)
    }

    if (idempotencyKey.includes('\0')) {
      throw invalidInput('idempotencyKey must not contain NUL')
    }

    parsedKey = idempotencyKey
  }

  const input: TaskInput = {
    title,
    goal: parseRequiredText(parsed.goal, 'goal', MAX_GOAL_CHARS),
    constraints: parseTextList(parsed.constraints, 'constraints', {
      maxItems: MAX_CONSTRAINTS,
      maxTotalChars: MAX_CONSTRAINTS_TOTAL_CHARS
    }),
    targets: parseTextList(parsed.targets, 'targets', { maxItems: MAX_TARGETS, maxItemChars: MAX_TARGET_CHARS }),
    permissions: parseTextList(parsed.permissions, 'permissions', {
      maxItems: MAX_PERMISSIONS,
      maxTotalChars: MAX_PERMISSIONS_TOTAL_CHARS
    }),
    idempotencyKey: parsedKey
  }

  return input
}

// araya task retry の追加の指示。空なら指示なしとして扱う
export function parseRetryNote(note: string) {
  if (note.length > MAX_NOTE_CHARS) {
    throw ledgerError('invalid_note', `the note must be at most ${MAX_NOTE_CHARS} characters`)
  }

  if (note.includes('\0')) {
    throw ledgerError('invalid_note', 'the note must not contain NUL')
  }

  return note === '' ? null : note
}

// task-<Task ID>-<試行番号>-<a-z2-7 の6文字>。台帳を作り直しても worktree・branch・scope の名前が重ならないように乱数を付ける
export function createTaskKey(taskId: number, attempt: number, randomBytes: (size: number) => Uint8Array = cryptoRandomBytes) {
  const bytes = randomBytes(TASK_KEY_SUFFIX_CHARS)
  let suffix = ''

  for (const byte of bytes) {
    // 256 は 32 で割り切れるので偏らない
    suffix += TASK_KEY_ALPHABET[byte % TASK_KEY_ALPHABET.length] ?? ''
  }

  return `task-${taskId}-${attempt}-${suffix}`
}

// 途中で止まった試行、または外部 repository の更新が済んだ可能性がある試行は、再実行前に確認を求める。
// agent_failed のうち model が決まらなかった（SHIKI が動く前の）ものは含めない
function hasDraftPrSideEffects(evidence: Record<string, unknown> | null) {
  const delivery = evidence?.draftPrDelivery

  if (!isRecord(delivery) || !Array.isArray(delivery.worktrees)) {
    return false
  }

  return delivery.worktrees.some((worktree) => {
    if (!isRecord(worktree)) {
      return false
    }

    return worktree.remoteSideEffectsUnconfirmed === true ||
      worktree.draftPrStatus === 'pushed' ||
      worktree.draftPrStatus === 'created' ||
      worktree.draftPrStatus === 'reused'
  })
}

export function isInterruptedAttempt(row: { startedAt: string | null; failureReason: string | null; evidence: Record<string, unknown> | null }) {
  if (row.startedAt === null || row.failureReason === null) {
    return false
  }

  if (hasDraftPrSideEffects(row.evidence)) {
    return true
  }

  if (!INTERRUPTED_FAILURE_REASONS.includes(row.failureReason)) {
    return false
  }

  if (row.failureReason === 'agent_failed') {
    const agent = row.evidence?.agent

    return !(isRecord(agent) && agent.error === 'model_unavailable')
  }

  return true
}

export function worktreesFromEvidence(evidence: Record<string, unknown> | null) {
  const worktrees = evidence?.worktrees

  if (!Array.isArray(worktrees)) {
    return []
  }

  const locations: WorktreeLocation[] = []

  for (const worktree of worktrees) {
    if (isRecord(worktree) && typeof worktree.worktreePath === 'string' && typeof worktree.branch === 'string') {
      locations.push({ worktreePath: worktree.worktreePath, branch: worktree.branch })
    }
  }

  return locations
}

function asText(value: unknown) {
  if (typeof value !== 'string') {
    throw new Error('string expected in the task ledger')
  }

  return value
}

function asNullableText(value: unknown) {
  return value === null || value === undefined ? null : asText(value)
}

function asNumber(value: unknown) {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'bigint') {
    return Number(value)
  }

  throw new Error('number expected in the task ledger')
}

function asNullableNumber(value: unknown) {
  return value === null || value === undefined ? null : asNumber(value)
}

function asStatus(value: unknown) {
  const text = asText(value)
  const status = TASK_STATUSES.find((candidate) => {
    return candidate === text
  })

  if (status === undefined) {
    throw new Error(`invalid status in the task ledger: ${text}`)
  }

  return status
}

function asStopReason(value: unknown) {
  const text = asNullableText(value)

  if (text === null) {
    return null
  }

  const reason = STOP_REASONS.find((candidate) => {
    return candidate === text
  })

  if (reason === undefined) {
    throw new Error(`invalid stop reason in the task ledger: ${text}`)
  }

  return reason
}

function parseStringArray(value: unknown) {
  const parsed: unknown = JSON.parse(asText(value))

  if (!Array.isArray(parsed)) {
    throw new Error('JSON array expected in the task ledger')
  }

  return parsed.map((item: unknown) => {
    return asText(item)
  })
}

function parseNullableObject(value: unknown) {
  const text = asNullableText(value)

  if (text === null) {
    return null
  }

  const parsed: unknown = JSON.parse(text)

  if (!isRecord(parsed)) {
    throw new Error('JSON object expected in the task ledger')
  }

  return parsed
}

function parseSettings(value: unknown) {
  const parsed = parseNullableObject(value)

  if (parsed === null) {
    return null
  }

  const model = parsed.model
  let settingsModel: DevelopmentModel | null = null

  if (isRecord(model)) {
    const thinkingLevel = model.thinkingLevel
    settingsModel = {
      provider: asText(model.provider),
      id: asText(model.id),
      thinkingLevel: thinkingLevel === null || thinkingLevel === undefined
        ? null
        : parseThinkingLevel(thinkingLevel)
    }
  }

  const settings: AttemptSettings = {
    devRoot: asText(parsed.devRoot),
    agentDir: asText(parsed.agentDir),
    model: settingsModel,
    timeoutMs: asNumber(parsed.timeoutMs),
    verificationTimeoutMs: asNumber(parsed.verificationTimeoutMs)
  }

  return settings
}

function parseThinkingLevel(value: unknown) {
  if (!isThinkingLevel(value)) {
    throw new Error('invalid thinking level in the task ledger')
  }

  return value
}

function truncateChars(text: string, maxChars: number) {
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

function byteLength(text: string) {
  return Buffer.byteLength(text, 'utf8')
}

// data_json を UTF-8 で上限に収める。収まるまで最も長い文字列の値を半分にする
function fitEventData(data: Record<string, unknown>) {
  const fitted = { ...data }

  while (byteLength(JSON.stringify(fitted)) > MAX_EVENT_DATA_BYTES) {
    let longestKey: string | undefined
    let longestLength = 0

    for (const [key, value] of Object.entries(fitted)) {
      if (typeof value === 'string' && value.length > longestLength) {
        longestKey = key
        longestLength = value.length
      }
    }

    if (longestKey === undefined) {
      return { tool: fitted.tool }
    }

    fitted[longestKey] = String(fitted[longestKey]).slice(0, Math.floor(longestLength / 2))
  }

  return fitted
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')

  try {
    const result = fn()
    db.exec('COMMIT')

    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

// <dataDir> と <dataDir>/logs を mode 0700 で、台帳の file を mode 0600 の空の file として用意する。既にあるものの mode は変えない
function prepareLedgerFiles(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true, mode: 0o700 })
  const ledgerPath = path.join(dataDir, LEDGER_FILE_NAME)

  try {
    fs.closeSync(fs.openSync(ledgerPath, 'wx', 0o600))
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error
    }
  }

  return ledgerPath
}

// user_version と table の有無を確かめ、空の台帳なら version 1 の schema を作る。未知の台帳は変更せずに失敗する
function ensureSchema(db: DatabaseSync) {
  transaction(db, () => {
    const version = asNumber(db.prepare('PRAGMA user_version').get()?.user_version)
    const tableCount = asNumber(
      db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.count
    )

    if (version === LEDGER_SCHEMA_VERSION) {
      return
    }

    if (version === 0 && tableCount === 0) {
      db.exec(SCHEMA_V1)
      db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`)

      return
    }

    throw ledgerError(
      'ledger_unsupported_version',
      version === 0
        ? 'the task ledger has tables but no schema version'
        : `the task ledger has an unsupported schema version ${version}`
    )
  })
}

export type TaskLedger = ReturnType<typeof openTaskLedger>

export type TaskLedgerOptions = {
  // 台帳に書く時刻。test で固定する
  now?: () => Date
  // 秘密とみなす環境変数の値。summary・質問・失敗の詳細・中止の詳細・evidence・途中経過を書く前に置き換える
  secretValues?: readonly string[]
  // taskKey の乱数。test で固定する
  randomBytes?: (size: number) => Uint8Array
}

type RunRow = {
  taskId: number
  attempt: number
  taskKey: string
  status: TaskStatus
  note: string | null
  queuedAt: string
  startedAt: string | null
  agentFinishedAt: string | null
  finishedAt: string | null
  activeMs: number
  cancelRequestedAt: string | null
  stopReason: StopReason | null
  stopDetail: string | null
  settings: AttemptSettings | null
  stateDir: string | null
  model: Record<string, unknown> | null
  summary: string | null
  decisionQuestion: string | null
  failureReason: string | null
  failureDetail: string | null
  evidence: Record<string, unknown> | null
}

function toRunRow(row: Record<string, unknown>) {
  const run: RunRow = {
    taskId: asNumber(row.task_id),
    attempt: asNumber(row.attempt),
    taskKey: asText(row.task_key),
    status: asStatus(row.status),
    note: asNullableText(row.note),
    queuedAt: asText(row.queued_at),
    startedAt: asNullableText(row.started_at),
    agentFinishedAt: asNullableText(row.agent_finished_at),
    finishedAt: asNullableText(row.finished_at),
    activeMs: asNumber(row.active_ms),
    cancelRequestedAt: asNullableText(row.cancel_requested_at),
    stopReason: asStopReason(row.stop_reason),
    stopDetail: asNullableText(row.stop_detail),
    settings: parseSettings(row.settings_json),
    stateDir: asNullableText(row.state_dir),
    model: parseNullableObject(row.model_json),
    summary: asNullableText(row.summary),
    decisionQuestion: asNullableText(row.decision_question),
    failureReason: asNullableText(row.failure_reason),
    failureDetail: asNullableText(row.failure_detail),
    evidence: parseNullableObject(row.evidence_json)
  }

  return run
}

function toAttemptView(run: RunRow) {
  const view: AttemptView = {
    attempt: run.attempt,
    status: run.status,
    taskKey: run.taskKey,
    note: run.note,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    agentFinishedAt: run.agentFinishedAt,
    finishedAt: run.finishedAt,
    activeMs: run.activeMs,
    cancelRequestedAt: run.cancelRequestedAt,
    stopReason: run.stopReason,
    model: run.model,
    summary: run.summary,
    decisionQuestion: run.decisionQuestion,
    failureReason: run.failureReason,
    failureDetail: run.failureDetail,
    stateDir: run.stateDir,
    evidence: run.evidence
  }

  return view
}

// tasks の行と、その最新の試行の行（r_ で始まる列）から TaskView を作る
function toTaskView(row: Record<string, unknown>) {
  const status = asStatus(row.status)
  const view: TaskView = {
    id: asNumber(row.id),
    title: asText(row.title),
    status,
    attempt: asNumber(row.current_attempt),
    failureReason: asNullableText(row.r_failure_reason),
    decisionQuestion: asNullableText(row.r_decision_question),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
    goal: asText(row.goal),
    constraints: parseStringArray(row.constraints_json),
    targets: parseStringArray(row.targets_json),
    permissions: parseStringArray(row.permissions_json),
    summary: asNullableText(row.r_summary),
    cancelRequested: status === 'running' && asNullableText(row.r_cancel_requested_at) !== null
  }

  return view
}

function toTaskSummary(view: TaskView) {
  const summary: TaskSummary = {
    id: view.id,
    title: view.title,
    status: view.status,
    attempt: view.attempt,
    failureReason: view.failureReason,
    decisionQuestion: view.decisionQuestion,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt
  }

  return summary
}

const TASK_WITH_LATEST_RUN = `
  SELECT t.*, r.failure_reason AS r_failure_reason, r.decision_question AS r_decision_question,
    r.summary AS r_summary, r.cancel_requested_at AS r_cancel_requested_at
  FROM tasks t JOIN runs r ON r.task_id = t.id AND r.attempt = t.current_attempt
`

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'errcode' in error
    && typeof error.errcode === 'number'
    && (error.errcode & 0xff) === 5
}

function enableWalMode(db: DatabaseSync) {
  const timeoutMs = 5000
  const deadline = performance.now() + timeoutMs
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  let lastBusyError: unknown

  while (true) {
    const remainingMs = deadline - performance.now()

    if (remainingMs <= 0) {
      if (lastBusyError !== undefined) {
        throw lastBusyError
      }

      throw new Error('SQLite WAL initialization timed out')
    }

    // Keep each SQLite busy wait short; the JS deadline is checked before every attempt.
    db.exec(`PRAGMA busy_timeout = ${Math.min(25, Math.max(0, Math.floor(remainingMs - 1)))}`)

    if (deadline - performance.now() <= 0) {
      if (lastBusyError !== undefined) {
        throw lastBusyError
      }

      throw new Error('SQLite WAL initialization timed out')
    }

    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec(`PRAGMA busy_timeout = ${timeoutMs}`)
      return
    } catch (error) {
      if (!isSqliteBusy(error)) {
        throw error
      }

      lastBusyError = error
      const retryMs = deadline - performance.now()

      if (retryMs <= 0) {
        throw error
      }

      Atomics.wait(waitCell, 0, 0, Math.min(25, retryMs))
    }
  }
}

export function openTaskLedger(dataDir: string, options: TaskLedgerOptions = {}) {
  const now = options.now ?? (() => new Date())
  const randomBytes = options.randomBytes ?? cryptoRandomBytes
  const redactor = createRedactor(options.secretValues ?? [])
  const ledgerPath = prepareLedgerFiles(dataDir)
  const db = new DatabaseSync(ledgerPath)

  try {
    // busy_timeout を先にして、ほかの process が書き込んでいる間に WAL への切り替えが SQLITE_BUSY で失敗しないようにする
    db.exec('PRAGMA busy_timeout = 5000')
    enableWalMode(db)
    db.exec('PRAGMA foreign_keys = ON')
    ensureSchema(db)
  } catch (error) {
    db.close()
    throw error
  }

  function nowIso() {
    return now().toISOString()
  }

  function redactNullable(text: string | null, maxChars?: number) {
    if (text === null) {
      return null
    }

    const redacted = redactor.redact(text)

    return maxChars === undefined ? redacted : truncateChars(redacted, maxChars)
  }

  function appendEvent(taskId: number, attempt: number | null, type: string, data: Record<string, unknown>, at = nowIso()) {
    db.prepare('INSERT INTO task_events (task_id, attempt, at, type, data_json) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, attempt, at, type, JSON.stringify(data))
  }

  function readTaskView(taskId: number) {
    const row = db.prepare(`${TASK_WITH_LATEST_RUN} WHERE t.id = ?`).get(taskId)

    if (row === undefined) {
      throw ledgerError('task_not_found', `Task ${taskId} does not exist`)
    }

    return toTaskView(row)
  }

  function readRun(taskId: number, attempt: number) {
    const row = db.prepare('SELECT * FROM runs WHERE task_id = ? AND attempt = ?').get(taskId, attempt)

    return row === undefined ? undefined : toRunRow(row)
  }

  function readRunByKey(taskKey: string) {
    const row = db.prepare('SELECT * FROM runs WHERE task_key = ?').get(taskKey)

    return row === undefined ? undefined : toRunRow(row)
  }

  function insertRun(taskId: number, attempt: number, note: string | null, at: string) {
    const taskKey = createTaskKey(taskId, attempt, randomBytes)
    db.prepare('INSERT INTO runs (task_id, attempt, task_key, status, note, queued_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, attempt, taskKey, 'queued', note, at)

    return taskKey
  }

  function settle(settlements: readonly Settlement[]) {
    const statement = db.prepare("UPDATE runs SET active_ms = active_ms + ? WHERE task_key = ? AND status = 'running'")

    for (const settlement of settlements) {
      if (settlement.addMs > 0) {
        statement.run(Math.floor(settlement.addMs), settlement.taskKey)
      }
    }
  }

  function countRuns(status: TaskStatus) {
    return asNumber(db.prepare('SELECT COUNT(*) AS count FROM runs WHERE status = ?').get(status)?.count)
  }

  function toPreviousAttempt(run: RunRow) {
    const previous: PreviousAttempt = {
      attempt: run.attempt,
      status: run.status,
      failureReason: run.failureReason,
      summary: run.summary,
      decisionQuestion: run.decisionQuestion,
      worktrees: worktreesFromEvidence(run.evidence),
      interrupted: isInterruptedAttempt(run)
    }

    return previous
  }

  function toClaimedAttempt(run: RunRow, settings: AttemptSettings) {
    const task = readTaskView(run.taskId)
    const previousRun = run.attempt > 1 ? readRun(run.taskId, run.attempt - 1) : undefined
    const claimed: ClaimedAttempt = {
      taskId: run.taskId,
      attempt: run.attempt,
      taskKey: run.taskKey,
      title: task.title,
      goal: task.goal,
      constraints: task.constraints,
      targets: task.targets,
      permissions: task.permissions,
      note: run.note,
      settings,
      previous: previousRun === undefined ? null : toPreviousAttempt(previousRun)
    }

    return claimed
  }

  return {
    path: ledgerPath,

    close() {
      db.close()
    },

    // 接続の設定を返す（test 用）
    pragmas() {
      return {
        busyTimeout: asNumber(db.prepare('PRAGMA busy_timeout').get()?.timeout),
        journalMode: asText(db.prepare('PRAGMA journal_mode').get()?.journal_mode),
        foreignKeys: asNumber(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)
      }
    },

    // --- CLI ---

    createTask(input: TaskInput) {
      return transaction(db, () => {
        const constraintsJson = JSON.stringify(input.constraints)
        const targetsJson = JSON.stringify(input.targets)
        const permissionsJson = JSON.stringify(input.permissions)

        if (input.idempotencyKey !== null) {
          const existing = db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(input.idempotencyKey)

          if (existing !== undefined) {
            const same = existing.title === input.title &&
              existing.goal === input.goal &&
              existing.constraints_json === constraintsJson &&
              existing.targets_json === targetsJson &&
              existing.permissions_json === permissionsJson

            if (!same) {
              throw ledgerError('idempotency_conflict', 'a Task with the same idempotencyKey has different values')
            }

            return { created: false, task: readTaskView(asNumber(existing.id)) }
          }
        }

        const at = nowIso()
        const inserted = db.prepare(`
          INSERT INTO tasks (kind, title, goal, constraints_json, targets_json, permissions_json, idempotency_key,
            status, current_attempt, created_at, updated_at)
          VALUES ('development', ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)
        `).run(input.title, input.goal, constraintsJson, targetsJson, permissionsJson, input.idempotencyKey, at, at)
        const taskId = asNumber(inserted.lastInsertRowid)
        insertRun(taskId, 1, null, at)
        appendEvent(taskId, 1, 'task.created', {}, at)

        return { created: true, task: readTaskView(taskId) }
      })
    },

    listTasks(filter: { status?: TaskStatus; limit: number }) {
      const rows = filter.status === undefined
        ? db.prepare(`${TASK_WITH_LATEST_RUN} ORDER BY t.id DESC LIMIT ?`).all(filter.limit)
        : db.prepare(`${TASK_WITH_LATEST_RUN} WHERE t.status = ? ORDER BY t.id DESC LIMIT ?`).all(filter.status, filter.limit)

      return rows.map((row) => {
        return toTaskSummary(toTaskView(row))
      })
    },

    getTask(taskId: number) {
      return readTaskView(taskId)
    },

    showTask(taskId: number, options: { events: number }) {
      const task = readTaskView(taskId)
      const attempts = db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC').all(taskId).map((row) => {
        return toAttemptView(toRunRow(row))
      })
      const events = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT ?')
        .all(taskId, options.events)
        .map((row) => {
          const event: EventView = {
            seq: asNumber(row.seq),
            attempt: asNullableNumber(row.attempt),
            at: asText(row.at),
            type: asText(row.type),
            data: parseNullableObject(row.data_json) ?? {}
          }

          return event
        })
        .reverse()

      return { task, attempts, events }
    },

    retryTask(taskId: number, options: { note: string | null; confirmSideEffects: boolean }) {
      return transaction(db, () => {
        const task = readTaskView(taskId)

        if (task.status !== 'failed' && task.status !== 'blocked') {
          throw ledgerError('task_not_retryable', `Task ${taskId} is ${task.status}; only failed and blocked Tasks can be retried`)
        }

        const latest = readRun(taskId, task.attempt)

        if (latest === undefined) {
          throw new Error(`the latest attempt of Task ${taskId} is missing from the task ledger`)
        }

        if (isInterruptedAttempt(latest) && !options.confirmSideEffects) {
          throw ledgerError(
            'side_effects_unconfirmed',
            `the previous attempt may have changed an external branch or pull request; confirm the previous worktree and remote state before retrying`,
            { previousWorktrees: worktreesFromEvidence(latest.evidence) }
          )
        }

        const at = nowIso()
        const attempt = task.attempt + 1
        insertRun(taskId, attempt, options.note, at)
        db.prepare("UPDATE tasks SET current_attempt = ?, status = 'queued', updated_at = ? WHERE id = ?").run(attempt, at, taskId)
        appendEvent(taskId, attempt, 'task.retried', {
          hasNote: options.note !== null,
          confirmedSideEffects: options.confirmSideEffects
        }, at)

        return readTaskView(taskId)
      })
    },

    cancelTask(taskId: number) {
      return transaction(db, () => {
        const task = readTaskView(taskId)
        const latest = readRun(taskId, task.attempt)

        if (latest === undefined) {
          throw new Error(`the latest attempt of Task ${taskId} is missing from the task ledger`)
        }

        const at = nowIso()

        if (latest.status === 'queued') {
          db.prepare(`
            UPDATE runs SET status = 'failed', failure_reason = 'cancelled', cancel_requested_at = ?, finished_at = ?
            WHERE task_id = ? AND attempt = ?
          `).run(at, at, taskId, latest.attempt)
          db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?").run(at, taskId)
          appendEvent(taskId, latest.attempt, 'task.cancel_requested', { while: 'queued' }, at)
          appendEvent(taskId, latest.attempt, 'run.finished', { status: 'failed', failureReason: 'cancelled' }, at)

          return { cancel: 'cancelled' as const, task: readTaskView(taskId) }
        }

        if (latest.status === 'running') {
          if (latest.cancelRequestedAt !== null) {
            return { cancel: 'already_requested' as const, task }
          }

          db.prepare('UPDATE runs SET cancel_requested_at = ? WHERE task_id = ? AND attempt = ?').run(at, taskId, latest.attempt)
          appendEvent(taskId, latest.attempt, 'task.cancel_requested', { while: 'running' }, at)

          return { cancel: 'requested' as const, task: readTaskView(taskId) }
        }

        throw ledgerError('task_not_cancellable', `Task ${taskId} is ${latest.status}; only queued and running Tasks can be cancelled`)
      })
    },

    // runner の行が無ければ not_started。running で heartbeat が 60 秒より前なら not_responding
    readRunner(unit: string, nowMs: number) {
      const row = db.prepare('SELECT * FROM runner WHERE id = 1').get()

      if (row === undefined) {
        const view: RunnerView = { unit, state: 'not_started', pid: null, startedAt: null, heartbeatAt: null, stoppedAt: null }

        return view
      }

      const heartbeatAt = asText(row.heartbeat_at)
      let state: RunnerState = asText(row.state) === 'stopped' ? 'stopped' : 'running'

      if (state === 'running' && nowMs - Date.parse(heartbeatAt) > RUNNER_NOT_RESPONDING_MS) {
        state = 'not_responding'
      }

      const view: RunnerView = {
        unit: asText(row.unit),
        state,
        pid: asNumber(row.pid),
        startedAt: asText(row.started_at),
        heartbeatAt,
        stoppedAt: asNullableText(row.stopped_at)
      }

      return view
    },

    // runner の行の invocation_id。行が無ければ null。araya runner install が新しい invocation の起動を待つのに使う
    readRunnerInvocationId() {
      const row = db.prepare('SELECT invocation_id FROM runner WHERE id = 1').get()

      return row === undefined ? null : asText(row.invocation_id)
    },

    queueView(limit: number) {
      const view: QueueView = { limit, running: countRuns('running'), queued: countRuns('queued') }

      return view
    },

    // --- runner ---

    markRunnerStarted(runner: { unit: string; invocationId: string; pid: number }) {
      transaction(db, () => {
        const at = nowIso()
        db.prepare(`
          INSERT INTO runner (id, unit, state, invocation_id, pid, started_at, heartbeat_at, stopped_at)
          VALUES (1, ?, 'running', ?, ?, ?, ?, NULL)
          ON CONFLICT (id) DO UPDATE SET unit = excluded.unit, state = 'running', invocation_id = excluded.invocation_id,
            pid = excluded.pid, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at, stopped_at = NULL
        `).run(runner.unit, runner.invocationId, runner.pid, at, at)
      })
    },

    // heartbeat_at を今の時刻にし、動かしている試行の稼働時間を精算する
    heartbeat(invocationId: string, settlements: readonly Settlement[]) {
      transaction(db, () => {
        db.prepare('UPDATE runner SET heartbeat_at = ? WHERE id = 1 AND invocation_id = ?').run(nowIso(), invocationId)
        settle(settlements)
      })
    },

    // runner の行を変えずに稼働時間を精算する（Harness が失敗で閉じたとき、abortTask が失敗したとき）
    settleActiveTime(settlements: readonly Settlement[]) {
      transaction(db, () => {
        settle(settlements)
      })
    },

    // 稼働時間を精算し、runner の行が自分の invocation のものなら stopped にする
    markRunnerStopped(invocationId: string, settlements: readonly Settlement[]) {
      transaction(db, () => {
        settle(settlements)
        db.prepare("UPDATE runner SET state = 'stopped', stopped_at = ? WHERE id = 1 AND invocation_id = ?").run(nowIso(), invocationId)
      })
    },

    listRunningAttempts() {
      return db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at ASC, task_id ASC, attempt ASC")
        .all()
        .map((row) => {
          const run = toRunRow(row)
          const attempt: RunningAttempt = {
            taskId: run.taskId,
            attempt: run.attempt,
            taskKey: run.taskKey,
            settings: run.settings,
            activeMs: run.activeMs,
            startedAt: run.startedAt,
            agentFinishedAt: run.agentFinishedAt,
            cancelRequestedAt: run.cancelRequestedAt,
            stopReason: run.stopReason,
            stopDetail: run.stopDetail
          }

          return attempt
        })
    },

    // 取り込みの前の、読むだけの確認。取り込み自体は claimNextAttempt の transaction で改めて確かめる
    hasClaimableAttempt(limit: number) {
      return countRuns('running') < limit && countRuns('queued') > 0
    },

    // 空きがあれば最も古い queued の試行を running にし、試行の task の input に入れる値を返す
    claimNextAttempt(limit: number, settings: AttemptSettings) {
      return transaction(db, () => {
        if (countRuns('running') >= limit) {
          return null
        }

        const row = db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY queued_at ASC, task_id ASC, attempt ASC LIMIT 1").get()

        if (row === undefined) {
          return null
        }

        const run = toRunRow(row)
        const at = nowIso()
        db.prepare("UPDATE runs SET status = 'running', started_at = ?, settings_json = ? WHERE task_id = ? AND attempt = ?")
          .run(at, JSON.stringify(settings), run.taskId, run.attempt)
        db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?").run(at, run.taskId)
        appendEvent(run.taskId, run.attempt, 'run.started', { taskKey: run.taskKey }, at)

        return toClaimedAttempt(run, settings)
      })
    },

    // 取り込んだ（running の）試行の、試行の task の input に入れる値を読む。取り込んだ後、task を作る前に落ちたときに使う
    readClaimedAttempt(taskKey: string) {
      const run = readRunByKey(taskKey)

      if (run === undefined || run.status !== 'running' || run.settings === null) {
        return null
      }

      return toClaimedAttempt(run, run.settings)
    },

    appendRunResumed(taskKey: string) {
      transaction(db, () => {
        const run = readRunByKey(taskKey)

        if (run !== undefined) {
          appendEvent(run.taskId, run.attempt, 'run.resumed', {})
        }
      })
    },

    // 試行がまだ running で stop_reason が空のとき（agent_timeout は SHIKI の終わりが未記録のときも）だけ中止を始める
    beginStop(taskKey: string, reason: StopReason, detail: string | null) {
      return transaction(db, () => {
        const result = db.prepare(`
          UPDATE runs SET stop_reason = ?, stop_detail = ?
          WHERE task_key = ? AND status = 'running' AND stop_reason IS NULL
            AND (? <> 'agent_timeout' OR agent_finished_at IS NULL)
        `).run(reason, redactNullable(detail, MAX_STOP_DETAIL_CHARS), taskKey, reason)

        if (asNumber(result.changes) === 0) {
          return false
        }

        const run = readRunByKey(taskKey)

        if (run !== undefined) {
          appendEvent(run.taskId, run.attempt, 'run.stopping', { reason })
        }

        return true
      })
    },

    // --- 試行の task ---

    // 状態 directory の path を、まだ記録されていなければ記録する
    recordStateDir(taskKey: string, stateDir: string) {
      transaction(db, () => {
        db.prepare('UPDATE runs SET state_dir = ? WHERE task_key = ? AND state_dir IS NULL').run(stateDir, taskKey)
      })
    },

    // SHIKI の終わりを記録する。中止が先に始まっていれば記録しない
    recordAgentFinished(taskKey: string) {
      return transaction(db, () => {
        const run = readRunByKey(taskKey)

        if (run === undefined || run.status !== 'running') {
          return 'not_running' as const
        }

        if (run.stopReason !== null) {
          return 'stopping' as const
        }

        if (run.agentFinishedAt !== null) {
          return 'already_recorded' as const
        }

        db.prepare('UPDATE runs SET agent_finished_at = ? WHERE task_key = ?').run(nowIso(), taskKey)

        return 'recorded' as const
      })
    },

    readStop(taskKey: string) {
      const run = readRunByKey(taskKey)

      return { stopReason: run?.stopReason ?? null, stopDetail: run?.stopDetail ?? null }
    },

    // 途中経過を書く。1試行の tool.started・tool.finished が上限に達したら events.truncated を1件だけ書く
    appendToolEvent(taskKey: string, type: ToolEventType, data: Record<string, unknown>) {
      return transaction(db, () => {
        const run = readRunByKey(taskKey)

        if (run === undefined) {
          return 'dropped' as const
        }

        const count = asNumber(db.prepare(`
          SELECT COUNT(*) AS count FROM task_events
          WHERE task_id = ? AND attempt = ? AND type IN ('tool.started', 'tool.finished')
        `).get(run.taskId, run.attempt)?.count)

        if (count >= MAX_TOOL_EVENTS_PER_ATTEMPT) {
          const truncated = db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND attempt = ? AND type = 'events.truncated'")
            .get(run.taskId, run.attempt)

          if (truncated !== undefined) {
            return 'dropped' as const
          }

          appendEvent(run.taskId, run.attempt, 'events.truncated', {})

          return 'truncated' as const
        }

        appendEvent(run.taskId, run.attempt, type, fitEventData(redactor.redactRecord(data)))

        return 'written' as const
      })
    },

    // --- 結果の記録 ---

    // 試行がまだ running のときだけ、稼働時間を精算して結果を記録する。中止が求められていれば failed（cancelled）にする
    recordResult(taskKey: string, result: AttemptResult, settlement: Settlement) {
      return transaction(db, () => {
        const run = readRunByKey(taskKey)

        if (run === undefined || run.status !== 'running') {
          return { recorded: false as const }
        }

        settle([settlement])
        const activeMs = asNumber(db.prepare('SELECT active_ms FROM runs WHERE task_key = ?').get(taskKey)?.active_ms)
        const resumes = asNumber(db.prepare(`
          SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND attempt = ? AND type = 'run.resumed'
        `).get(run.taskId, run.attempt)?.count)
        const cancelOverrides = run.cancelRequestedAt !== null &&
          !(result.status === 'failed' && result.failureReason === 'cancelled')
        const status = cancelOverrides ? 'failed' : result.status
        const failureReason = cancelOverrides ? 'cancelled' : result.failureReason
        const failureDetail = cancelOverrides ? null : redactNullable(result.failureDetail)
        const evidence: Record<string, unknown> = {
          ...redactor.redactRecord(result.evidence),
          resumes,
          activeMs
        }

        if (cancelOverrides) {
          evidence.outcome = 'failed'
          evidence.failureReason = 'cancelled'
          evidence.resultBeforeCancel = {
            status: result.status,
            failureReason: result.failureReason,
            failureDetail: redactNullable(result.failureDetail)
          }
        }

        const at = nowIso()
        db.prepare(`
          UPDATE runs SET status = ?, finished_at = ?, summary = ?, model_json = ?, decision_question = ?,
            failure_reason = ?, failure_detail = ?, evidence_json = ?
          WHERE task_key = ?
        `).run(
          status,
          at,
          redactNullable(result.summary, MAX_SUMMARY_CHARS),
          result.model === null ? null : JSON.stringify(result.model),
          redactNullable(result.decisionQuestion),
          failureReason,
          failureDetail,
          JSON.stringify(evidence),
          taskKey
        )
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, at, run.taskId)
        appendEvent(run.taskId, run.attempt, 'run.finished', { status, failureReason }, at)

        return { recorded: true as const, status, failureReason }
      })
    }
  }
}
