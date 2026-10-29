import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@earendil-works/chord'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  hook,
  ToolTask,
  type ConversationId,
  type DocumentReader,
  type EntryRecord,
  type HookApi,
  type TaskId,
  type ToolExecutionResult,
  type ToolHookCall
} from '@earendil-works/pi-durable'

import {
  agentEvidence,
  buildWorktreeOnlyEvidence,
  collectDevelopmentResult,
  type AgentModelEvidence,
  type AgentOutcome,
  type DevelopmentResult
} from '../development/result.ts'
import type { ThinkingLevel } from '../config/model.ts'
import { readDecision } from '../development/worktrees.ts'
import { createRedactor, type Redactor } from '../infrastructure/redaction.ts'
import {
  buildShikiInstructions,
  buildTaskBody,
  buildTaskPrompt,
  createShikiTools,
  describeModelUnavailable,
  getStateDir,
  SHIKI_TOOL_NAMES
} from '../development/shiki.ts'
import {
  createScopedRunner,
  createScopedVerificationRunner,
  deliveryScopeUnit,
  gitScopeUnit,
  scopePattern,
  verifyScopeUnit,
  type SystemdOps
} from '../infrastructure/systemd.ts'
import type { AttemptResult, AttemptSettings, ClaimedAttempt, TaskLedger, ToolEventType, WorktreeLocation } from './ledger.ts'

// 試行の task（pi-durable の defineTask）、session の document（araya.attempts）、SHIKI の extension（tool と途中経過の hook）。
// runner の loop は知らない。台帳には AttemptLedgerPort の操作だけで触る

export const ATTEMPT_TASK_NAME = 'araya.attempt'
export const SHIKI_EXTENSION_NAME = 'araya-shiki'

const MAX_TASK_BODY_CHARS = 80_000
const MAX_DETAIL_CHARS = 2_000
const MAX_EVENT_TEXT_CHARS = 300
const ATTEMPT_FILE = 'attempt.json'
const EVIDENCE_FILE = 'evidence.json'
// thinking level が設定ファイルにも Pi の設定にも無いときの値。Pi の DEFAULT_THINKING_LEVEL（core/defaults.js。
// package の外に export されていない）に合わせる。pi-durable の既定（off）は使わない
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

// taskKey と試行の task の id、会話の id と taskKey の対応。runner と tool が会話や task から試行を引く
export type AttemptsState = {
  byTaskKey: { [taskKey: string]: { taskId: TaskId<AttemptResult> } }
  byConversation: { [conversationId: string]: { taskKey: string; devRoot: string } }
}

export const AttemptsDoc = defineDoc<AttemptsState>({
  kind: 'araya.attempts',
  version: 1,
  scope: 'session',
  initial: () => {
    return { byTaskKey: {}, byConversation: {} }
  },
  checkpointWhen: () => {
    return false
  }
})

// 試行の task の input。取り込みのときに runner が台帳の値から作る
export type AttemptInput = {
  taskKey: string
  taskId: number
  attempt: number
  title: string
  // 課題の本文（「課題の本文」）
  body: string
  settings: AttemptSettings
  previousAttempt: { attempt: number; worktrees: WorktreeLocation[] } | null
}

type AttemptCheckpoint =
  | { phase: 'start' }
  | { phase: 'agent'; conversationId: ConversationId; model: AgentModelEvidence }
  | { phase: 'evidence'; agent: AgentOutcome }

export type AttemptLedgerPort = Pick<TaskLedger, 'recordStateDir' | 'recordAgentFinished' | 'readStop' | 'appendToolEvent'>

export type ModelLookup = Pick<ModelRuntime, 'getModel' | 'hasConfiguredAuth' | 'getAvailableSnapshot'>

// Pi の設定（SettingsManager）のうち、model の既定を決めるもの
export type PiModelSettings = {
  getDefaultProvider(): string | undefined
  getDefaultModel(): string | undefined
  getDefaultThinkingLevel(): ThinkingLevel | undefined
  getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined
}

// test で順番を固定するための注入点。本物の runner では渡さない
export type AttemptFaults = {
  // agent の phase で、SHIKI の終わりを台帳に記録する前
  beforeRecordAgentFinished?(taskKey: string): void | Promise<void>
  // evidence.json を書いた後、outcome の commit の前
  afterEvidenceFile?(taskKey: string): void | Promise<void>
  // 各 phase の commit の前
  beforePhaseCommit?(phase: AttemptCheckpoint['phase'] | 'abort', taskKey: string): void | Promise<void>
}

export type AttemptDependencies = {
  // dataDir の実 path
  dataDir: string
  // dataDir の実 path の hash（scope の名前に使う）
  hash: string
  ledger: AttemptLedgerPort
  systemd: Pick<SystemdOps, 'launchInScope' | 'bashScopeCommand' | 'stopScopes'>
  // runner の ModelRuntime（Harness の models と同じもの）
  models: ModelLookup
  env: Readonly<Record<string, string | undefined>>
  // Task 作成時に指定された goal に対して、検証後の Draft PR delivery を有効にする
  draftPrDelivery: boolean
  // 秘密とみなす環境変数の値（evidence と evidence.json に書く前に置き換える）
  secretValues: readonly string[]
  log(entry: Record<string, unknown>): void
  // 省略時は Pi の SettingsManager（agentDir と状態 directory で作る）
  createPiSettings?: (stateDir: string, agentDir: string) => PiModelSettings
  now?: () => Date
  faults?: AttemptFaults
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function textOrNull(value: unknown) {
  return typeof value === 'string' ? value : null
}

function joinDetails(...details: (string | null)[]) {
  const present = details.filter((detail) => {
    return detail !== null && detail !== ''
  })

  return present.length === 0 ? null : present.join('; ')
}

// 中止の signal（abortTask・Harness を閉じたとき）まで待ち、その理由で失敗する。
// 失敗した phase は faulted にならず、abort に移るか、開き直したときにやり直される
function waitForAbort(signal: AbortSignal) {
  return new Promise<never>((_resolve, reject) => {
    function rejectWithReason() {
      reject(signal.reason instanceof Error ? signal.reason : new Error('the attempt task was signalled'))
    }

    if (signal.aborted) {
      rejectWithReason()
      return
    }

    signal.addEventListener('abort', rejectWithReason, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('the attempt task was signalled')
  }
}

export async function findAttemptByConversation(reader: DocumentReader, conversationId: number, context: Context) {
  const state = await reader.snapshot(AttemptsDoc, context)

  return state?.byConversation[String(conversationId)]
}

// 取り込んだ試行から、試行の task の input を作る
export function buildAttemptInput(claimed: ClaimedAttempt) {
  const previous = claimed.previous
  const input: AttemptInput = {
    taskKey: claimed.taskKey,
    taskId: claimed.taskId,
    attempt: claimed.attempt,
    title: claimed.title,
    body: buildTaskBody({
      goal: claimed.goal,
      constraints: claimed.constraints,
      targets: claimed.targets,
      permissions: claimed.permissions,
      note: claimed.note,
      previous
    }),
    settings: claimed.settings,
    previousAttempt: previous === null ? null : { attempt: previous.attempt, worktrees: previous.worktrees }
  }

  return input
}

// SHIKI の model を決める。別の model には切り替えない。
// thinking level は、設定ファイルの値、Pi の設定の model ごとの値、Pi の設定の既定、medium の順で決め、model の対応範囲に丸める
export function resolveShikiModel(models: ModelLookup, settings: AttemptSettings, piSettings: PiModelSettings) {
  const configured = settings.model
  const provider = configured === null ? piSettings.getDefaultProvider() : configured.provider
  const id = configured === null ? piSettings.getDefaultModel() : configured.id
  const source: AgentModelEvidence['source'] = configured === null ? 'pi-settings' : 'araya-config'

  if (provider === undefined || id === undefined) {
    return { ok: false as const, message: describeModelUnavailable({ kind: 'no_model' }) }
  }

  const reference = { provider, id }
  const found = models.getModel(provider, id)

  if (found === undefined) {
    return { ok: false as const, message: describeModelUnavailable({ kind: 'not_in_model_list', configured: reference }) }
  }

  const usable = models.hasConfiguredAuth(provider) || models.getAvailableSnapshot().some((candidate) => {
    return candidate.provider === provider && candidate.id === id
  })

  if (!usable) {
    return { ok: false as const, message: describeModelUnavailable({ kind: 'no_authentication', configured: reference }) }
  }

  const requested = configured?.thinkingLevel ??
    piSettings.getModelThinkingLevel(provider, id) ??
    piSettings.getDefaultThinkingLevel() ??
    DEFAULT_THINKING_LEVEL
  const model: AgentModelEvidence = { provider, id, thinkingLevel: clampThinkingLevel(found, requested), source }

  return { ok: true as const, model }
}

function createDefaultPiSettings(stateDir: string, agentDir: string) {
  const settings: PiModelSettings = SettingsManager.create(stateDir, agentDir, { projectTrusted: false })

  return settings
}

// evidence.json を一時 file に書いてから rename する。書いた byte 列の SHA-256 を返す。書けなければ stored: false
export async function writeEvidenceFile(stateDir: string, evidence: Record<string, unknown>) {
  const content = Buffer.from(JSON.stringify(evidence), 'utf8')
  const target = path.join(stateDir, EVIDENCE_FILE)
  const temporary = path.join(stateDir, `.${EVIDENCE_FILE}.${process.pid}.tmp`)

  try {
    await fs.writeFile(temporary, content, { mode: 0o600 })
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, target)

    return { stored: true as const, sha256: createHash('sha256').update(content).digest('hex') }
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {})

    return { stored: false as const }
  }
}

// 台帳に入れる evidence。差分の本文（diff）と検証の出力（stdout・stderr）を除く
function withoutBodies(evidence: Record<string, unknown>) {
  if (!Array.isArray(evidence.worktrees)) {
    return { ...evidence }
  }

  const worktrees = evidence.worktrees.map((worktree: unknown) => {
    if (!isRecord(worktree)) {
      return worktree
    }

    const { diff: _diff, ...rest } = worktree

    if (!Array.isArray(rest.verifications)) {
      return rest
    }

    return {
      ...rest,
      verifications: rest.verifications.map((verification: unknown) => {
        if (!isRecord(verification)) {
          return verification
        }

        const { stdout: _stdout, stderr: _stderr, ...kept } = verification

        return kept
      })
    }
  })

  return { ...evidence, worktrees }
}

// SHIKI の報告と誤りの message を、差分の収集の前に置き換える（切り詰めで秘密の一部が残らないように、置き換えてから切り詰める）
function redactAgent(agent: AgentOutcome, redactor: Redactor) {
  if (agent.status === 'completed') {
    const redacted: AgentOutcome = { ...agent, summary: redactor.redact(agent.summary) }

    return redacted
  }

  if (agent.errorMessage === undefined) {
    return agent
  }

  const redacted: AgentOutcome = { ...agent, errorMessage: redactor.redact(agent.errorMessage).slice(0, MAX_DETAIL_CHARS) }

  return redacted
}

function describeSubmissionDetail(detail: unknown) {
  if (detail === undefined || detail === null) {
    return undefined
  }

  return typeof detail === 'string' ? detail : JSON.stringify(detail)
}

// 回答の entry の最後の assistant の message の text
function lastAssistantText(entry: EntryRecord | undefined) {
  const message = entry?.model?.findLast((candidate) => {
    return candidate.role === 'assistant'
  })

  if (message === undefined || message.role !== 'assistant') {
    return ''
  }

  return message.content.flatMap((block) => {
    return block.type === 'text' ? [block.text] : []
  }).join('')
}

async function readDecisionQuestion(stateDir: string | null) {
  if (stateDir === null) {
    return null
  }

  try {
    return (await readDecision(stateDir))?.question ?? null
  } catch {
    return null
  }
}

async function existingDirectory(target: string) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function writeAttemptFile(stateDir: string, content: { taskKey: string; dataDir: string }) {
  const temporary = path.join(stateDir, `.${ATTEMPT_FILE}.${process.pid}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(content)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, path.join(stateDir, ATTEMPT_FILE))
}

// 状態 directory を用意する。別の試行のものなら ok: false
async function prepareStateDir(dataDir: string, taskKey: string) {
  const stateDir = getStateDir(dataDir, taskKey)
  const content = { taskKey, dataDir }
  await fs.mkdir(path.dirname(stateDir), { recursive: true, mode: 0o700 })

  try {
    await fs.mkdir(stateDir, { mode: 0o700 })
    // umask に左右されないように mode を明示する
    await fs.chmod(stateDir, 0o700)
    await writeAttemptFile(stateDir, content)

    return { ok: true as const, stateDir }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error
    }
  }

  let text: string

  try {
    text = await fs.readFile(path.join(stateDir, ATTEMPT_FILE), 'utf8')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      return { ok: false as const, detail: `${stateDir}/${ATTEMPT_FILE} could not be read: ${describeError(error)}` }
    }

    // 作った直後に落ちた（一時 file だけが残っていてもよい）
    const entries = (await fs.readdir(stateDir)).filter((name) => {
      return !name.startsWith(`.${ATTEMPT_FILE}.`)
    })

    if (entries.length > 0) {
      return { ok: false as const, detail: `${stateDir} already exists without ${ATTEMPT_FILE}` }
    }

    await writeAttemptFile(stateDir, content)

    return { ok: true as const, stateDir }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false as const, detail: `${stateDir}/${ATTEMPT_FILE} is not valid JSON` }
  }

  if (!isRecord(parsed) || parsed.taskKey !== taskKey || parsed.dataDir !== dataDir) {
    return { ok: false as const, detail: `${stateDir} belongs to another attempt` }
  }

  return { ok: true as const, stateDir }
}

// 途中経過の data。決まった key だけを入れ、bash のコマンドと tool の結果は入れない。
// 切り詰めで秘密の一部や URL の @ が境界の外に出ないように、置き換えてから切り詰める
function toolEventData(call: ToolHookCall, result: ToolExecutionResult | undefined, redactor: Redactor) {
  const data: Record<string, unknown> = { tool: call.name }

  function pick(key: string) {
    const value = call.arguments[key]

    if (typeof value === 'string') {
      data[key] = redactor.redact(value).slice(0, MAX_EVENT_TEXT_CHARS)
    }
  }

  switch (call.name) {
    case 'read':
    case 'edit':
    case 'write':
      pick('path')
      break
    case 'araya_create_worktree':
      pick('repository')
      pick('base')
      break
    case 'araya_register_verification':
      pick('repository')
      pick('cwd')
      break
  }

  if (result !== undefined) {
    data.isError = result.isError === true
  }

  return data
}

// 試行の task が試行の結果を持たずに終わったとき（outcome が failed・orphaned・faulted、result が無い、waitForTask の失敗）に、
// runner が記録する結果（attempt_error、worktree だけの evidence）。detail は outcome の status と error の message
export async function buildAttemptErrorResult(input: {
  dataDir: string
  taskKey: string
  settings: AttemptSettings | null
  detail: string
  secretValues: readonly string[]
}) {
  const redactor = createRedactor(input.secretValues)
  const candidate = getStateDir(input.dataDir, input.taskKey)
  const stateDir = await existingDirectory(candidate) ? candidate : null
  const built = await buildWorktreeOnlyEvidence({ taskKey: input.taskKey, devRoot: input.settings?.devRoot ?? '', stateDir, redact: redactor.redact })
  // 切り詰めで秘密の一部が残らないように、置き換えてから切り詰める
  const detail = redactor.redact(joinDetails(input.detail, built.detail) ?? input.detail).slice(0, MAX_DETAIL_CHARS)
  const evidence = redactor.redactRecord({
    ...built.evidence,
    outcome: 'failed',
    failureReason: 'attempt_error',
    failureDetail: detail,
    ...(input.settings === null ? {} : { timeoutMs: input.settings.timeoutMs }),
    tools: [...SHIKI_TOOL_NAMES],
    decisionQuestion: await readDecisionQuestion(stateDir)
  })
  evidence.redactions = redactor.count
  const result: AttemptResult = {
    status: 'failed',
    failureReason: 'attempt_error',
    failureDetail: detail,
    summary: null,
    decisionQuestion: textOrNull(evidence.decisionQuestion),
    model: null,
    evidence
  }

  return result
}

// outcome の result が試行の結果の形をしているか（定義が変わった task の result などを除く）
export function isAttemptResult(value: unknown): value is AttemptResult {
  return isRecord(value) &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'blocked') &&
    isRecord(value.evidence)
}

type ResultBase = {
  input: AttemptInput
  redactor: Redactor
  agent: AgentOutcome | null
  // 使った model（SHIKI の終わりが決まる前に中止したときも、決まっていれば残す）
  model: AgentModelEvidence | null
}

// 試行の task と SHIKI の extension を作る。runner は extension を registry に入れ、attemptTask で試行の task を作る
export function createShikiExtension(deps: AttemptDependencies) {
  const now = deps.now ?? (() => {
    return new Date()
  })
  const tools = createShikiTools({
    dataDir: deps.dataDir,
    hash: deps.hash,
    systemd: deps.systemd,
    env: deps.env,
    now,
    resolveAttempt: async (conversationId, reader, context) => {
      return findAttemptByConversation(reader, conversationId, context)
    }
  })

  function commonEvidence(base: ResultBase) {
    const previous = base.input.previousAttempt

    return {
      timeoutMs: base.input.settings.timeoutMs,
      tools: [...SHIKI_TOOL_NAMES],
      ...(previous === null ? {} : { previousAttempt: previous })
    }
  }

  // 差分の収集と検証を行わずに終わる試行の結果（worktree だけの evidence）
  async function worktreeOnlyResult(base: ResultBase, outcome: {
    status: AttemptResult['status']
    failureReason: string
    stateDir: string | null
    detail?: string | null
  }) {
    const built = await buildWorktreeOnlyEvidence({
      taskKey: base.input.taskKey,
      devRoot: base.input.settings.devRoot,
      stateDir: outcome.stateDir,
      redact: base.redactor.redact
    })
    const detail = joinDetails(outcome.detail ?? null, built.detail)
    const evidence = base.redactor.redactRecord({
      ...built.evidence,
      outcome: outcome.status,
      failureReason: outcome.failureReason,
      ...(detail === null ? {} : { failureDetail: detail }),
      ...(base.agent === null ? {} : agentEvidence(base.agent)),
      ...commonEvidence(base),
      decisionQuestion: await readDecisionQuestion(outcome.stateDir)
    })
    evidence.redactions = base.redactor.count
    const failureDetail = textOrNull(evidence.failureDetail)
    const result: AttemptResult = {
      status: outcome.status,
      failureReason: outcome.failureReason,
      failureDetail: failureDetail === null ? null : failureDetail.slice(0, MAX_DETAIL_CHARS),
      summary: textOrNull(evidence.summary),
      decisionQuestion: textOrNull(evidence.decisionQuestion),
      model: base.model,
      evidence
    }

    return result
  }

  // 差分の収集と検証の結果から、試行の結果を作る。差分を集めた試行は evidence.json に本文を残す
  async function developmentResult(base: ResultBase, stateDir: string, development: DevelopmentResult) {
    const evidence = base.redactor.redactRecord({ ...development.evidence, ...commonEvidence(base) })
    evidence.redactions = base.redactor.count
    let bodies: Record<string, unknown> = { bodiesStored: false }

    if (development.collected) {
      const written = await writeEvidenceFile(stateDir, evidence)

      if (written.stored) {
        bodies = { bodiesStored: true, bodiesSha256: written.sha256 }
      }

      await deps.faults?.afterEvidenceFile?.(base.input.taskKey)
    }

    const failureDetail = textOrNull(evidence.failureDetail)
    const result: AttemptResult = {
      status: development.status,
      failureReason: textOrNull(evidence.failureReason),
      failureDetail: failureDetail === null ? null : failureDetail.slice(0, MAX_DETAIL_CHARS),
      summary: textOrNull(evidence.summary),
      decisionQuestion: textOrNull(evidence.decisionQuestion),
      model: base.model,
      evidence: { ...withoutBodies(evidence), ...bodies }
    }

    return result
  }

  async function collect(input: AttemptInput, stateDir: string, agent: AgentOutcome, redactor: Redactor, signal: AbortSignal) {
    return collectDevelopmentResult({
      taskKey: input.taskKey,
      title: input.title,
      draftPrDelivery: deps.draftPrDelivery,
      devRoot: input.settings.devRoot,
      stateDir,
      agent,
      env: deps.env,
      verificationTimeoutMs: input.settings.verificationTimeoutMs,
      signal,
      redact: redactor.redact,
      redactTruncated: redactor.redactTruncated
    }, {
      runGit: createScopedRunner(deps.systemd, () => {
        return gitScopeUnit(deps.hash, input.taskKey)
      }),
      runDeliveryGit: createScopedRunner(deps.systemd, () => {
        return deliveryScopeUnit(deps.hash, input.taskKey)
      }),
      runGitHub: createScopedRunner(deps.systemd, () => {
        return deliveryScopeUnit(deps.hash, input.taskKey)
      }),
      runVerification: createScopedVerificationRunner(deps.systemd, (index) => {
        return verifyScopeUnit(deps.hash, input.taskKey, index)
      })
    })
  }

  // SHIKI の終わりを台帳に記録する。runner が中止を始めていれば、phase の signal が中止されるまで待つ
  async function recordAgentEnd(taskKey: string, signal: AbortSignal) {
    await deps.faults?.beforeRecordAgentFinished?.(taskKey)
    const recorded = deps.ledger.recordAgentFinished(taskKey)

    if (recorded === 'stopping' || recorded === 'not_running') {
      await waitForAbort(signal)
    }
  }

  // 途中経過の値の置き換え（回数は evidence に数えない）
  const eventRedactor = createRedactor(deps.secretValues)

  async function writeToolEvent(type: ToolEventType, call: ToolHookCall, result: ToolExecutionResult | undefined, api: HookApi, context: Context) {
    let taskKey: string | undefined

    // 台帳に書けなくても tool はそのまま進める
    try {
      taskKey = (await findAttemptByConversation(api, api.conversationId, context))?.taskKey

      if (taskKey === undefined) {
        return
      }

      deps.ledger.appendToolEvent(taskKey, type, toolEventData(call, result, eventRedactor))
    } catch (error) {
      deps.log({ type: 'tool_event_failed', ...(taskKey === undefined ? {} : { taskKey }), message: describeError(error) })
    }
  }

  const progress = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      await writeToolEvent('tool.started', call, undefined, api, context)

      return undefined
    },
    afterTool: async (call, result, api, context) => {
      await writeToolEvent('tool.finished', call, result, api, context)

      return undefined
    }
  })

  const attemptTask = defineTask<AttemptInput, AttemptCheckpoint, AttemptResult>({
    name: ATTEMPT_TASK_NAME,
    version: 1,
    initial: () => {
      return { phase: 'start' }
    },
    phases: {
      start: async (task, runtime, context) => {
        const input = task.input
        const { taskKey, settings } = input
        const redactor = createRedactor(deps.secretValues)
        const base: ResultBase = { input, redactor, agent: null, model: null }

        async function finish(result: AttemptResult) {
          await deps.faults?.beforePhaseCommit?.('start', taskKey)
          await runtime.commit(() => {
            return { status: 'terminal', outcome: { status: 'completed', result } }
          }, context)
        }

        const prepared = await prepareStateDir(deps.dataDir, taskKey)

        if (!prepared.ok) {
          // 別の試行の状態 directory の worktree は、この試行のものとして残さない
          await finish(await worktreeOnlyResult(base, {
            status: 'failed',
            failureReason: 'task_state_already_exists',
            stateDir: null,
            detail: prepared.detail
          }))
          return
        }

        const stateDir = prepared.stateDir
        deps.ledger.recordStateDir(taskKey, stateDir)

        if (!await existingDirectory(settings.devRoot)) {
          await finish(await worktreeOnlyResult(base, {
            status: 'failed',
            failureReason: 'dev_root_missing',
            stateDir,
            detail: `${settings.devRoot} is not a directory`
          }))
          return
        }

        if (input.body.length > MAX_TASK_BODY_CHARS) {
          await finish(await worktreeOnlyResult(base, {
            status: 'failed',
            failureReason: 'invalid_task',
            stateDir,
            detail: `the task body exceeds ${MAX_TASK_BODY_CHARS} characters`
          }))
          return
        }

        const piSettings = (deps.createPiSettings ?? createDefaultPiSettings)(stateDir, settings.agentDir)
        const resolved = resolveShikiModel(deps.models, settings, piSettings)

        if (!resolved.ok) {
          await recordAgentEnd(taskKey, runtime.signal)
          const agent: AgentOutcome = { status: 'failed', error: 'model_unavailable', errorMessage: resolved.message }
          await deps.faults?.beforePhaseCommit?.('start', taskKey)
          await runtime.commit(() => {
            return { status: 'running', checkpoint: { phase: 'evidence', agent } }
          }, context)
          return
        }

        const model = resolved.model
        await deps.faults?.beforePhaseCommit?.('start', taskKey)
        // 会話の作成、設定、document への記録を1つの commit にし、phase をやり直しても会話が2つできないようにする
        await runtime.commit(async (tx) => {
          const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } })
          await configure(tx, conversation.id, {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: model.thinkingLevel,
            extensions: [extension],
            tools,
            instructions: buildShikiInstructions({ devRoot: settings.devRoot, taskKey }),
            cwd: settings.devRoot
          })
          const attempts = await tx.doc(AttemptsDoc)
          attempts.byConversation[String(conversation.id)] = { taskKey, devRoot: settings.devRoot }

          return { status: 'running', checkpoint: { phase: 'agent', conversationId: conversation.id, model } }
        }, context)
      },
      agent: async (task, runtime, context) => {
        const input = task.input
        const { taskKey, settings } = input
        const { conversationId, model } = task.state.checkpoint
        const conversation = await runtime.conversation(conversationId, context)

        if (conversation === undefined) {
          throw new Error(`the conversation of ${taskKey} is missing`)
        }

        const submission = await conversation.submit({
          type: 'input',
          content: buildTaskPrompt({ devRoot: settings.devRoot, taskKey, title: input.title, task: input.body }),
          requestId: taskKey
        }, context)
        const settled = await submission.wait(context)
        await recordAgentEnd(taskKey, runtime.signal)
        await deps.faults?.beforePhaseCommit?.('agent', taskKey)
        await runtime.commit(async (tx) => {
          let agent: AgentOutcome

          if (settled.status === 'done') {
            const page = await tx.scanEntries({ conversationId, minEntryId: settled.answer, maxEntryId: settled.answer }, 1)
            agent = { status: 'completed', summary: lastAssistantText(page.items[0]), model }
          } else {
            const errorMessage = describeSubmissionDetail(settled.detail)
            agent = {
              status: 'failed',
              error: settled.reason,
              ...(errorMessage === undefined ? {} : { errorMessage }),
              model
            }
          }

          return { status: 'running', checkpoint: { phase: 'evidence', agent } }
        }, context)
      },
      evidence: async (task, runtime, context) => {
        const input = task.input
        const redactor = createRedactor(deps.secretValues)
        const agent = redactAgent(task.state.checkpoint.agent, redactor)
        const base: ResultBase = { input, redactor, agent, model: agent.model ?? null }
        const stateDir = getStateDir(deps.dataDir, input.taskKey)
        // SHIKI の bash と git が切り離した process が、差分の収集と検証の間に worktree を変えないようにする
        const stopped = await deps.systemd.stopScopes(scopePattern(deps.hash, input.taskKey))
        let result: AttemptResult

        if (!stopped.ok) {
          result = await worktreeOnlyResult(base, {
            status: 'failed',
            failureReason: 'termination_unconfirmed',
            stateDir,
            detail: stopped.error
          })
        } else {
          const development = await collect(input, stateDir, agent, redactor, runtime.signal)
          // 中止された検証の結果は記録しない（abort に移るか、開き直したときにやり直す）
          throwIfAborted(runtime.signal)
          result = await developmentResult(base, stateDir, development)
        }

        await deps.faults?.beforePhaseCommit?.('evidence', input.taskKey)
        await runtime.commit(() => {
          return { status: 'terminal', outcome: { status: 'completed', result } }
        }, context)
      }
    },
    abort: async (task, runtime, context) => {
      const input = task.input
      const checkpoint = task.state.checkpoint
      const redactor = createRedactor(deps.secretValues)
      const agent = checkpoint.phase === 'evidence' ? redactAgent(checkpoint.agent, redactor) : null
      const model = checkpoint.phase === 'agent' ? checkpoint.model : agent?.model ?? null
      const base: ResultBase = { input, redactor, agent, model }
      const candidate = getStateDir(deps.dataDir, input.taskKey)
      const stateDir = await existingDirectory(candidate) ? candidate : null
      const stopped = await deps.systemd.stopScopes(scopePattern(deps.hash, input.taskKey))
      const stop = deps.ledger.readStop(input.taskKey)
      let result: AttemptResult

      switch (stop.stopReason) {
        case 'agent_timeout': {
          if (!stopped.ok) {
            result = await worktreeOnlyResult(base, { status: 'failed', failureReason: 'termination_unconfirmed', stateDir, detail: stopped.error })
            break
          }

          const timeoutAgent: AgentOutcome = { status: 'timeout', error: 'agent_timeout', ...(model === null ? {} : { model }) }
          const timeoutBase: ResultBase = { ...base, agent: timeoutAgent }

          if (stateDir === null) {
            result = await worktreeOnlyResult(timeoutBase, { status: 'failed', failureReason: 'agent_timeout', stateDir })
            break
          }

          // 差分を集め、登録された検証は実行せずに not_run（agent_timeout）にする
          const development = await collect(input, stateDir, timeoutAgent, redactor, runtime.signal)
          result = await developmentResult(timeoutBase, stateDir, development)
          break
        }
        case 'cancelled':
          result = await worktreeOnlyResult(base, { status: 'failed', failureReason: 'cancelled', stateDir })
          break
        case 'restart_limit':
          result = await worktreeOnlyResult(base, { status: 'blocked', failureReason: 'restart_limit', stateDir })
          break
        default:
          result = await worktreeOnlyResult(base, { status: 'failed', failureReason: 'attempt_error', stateDir, detail: stop.stopDetail })
      }

      await deps.faults?.beforePhaseCommit?.('abort', input.taskKey)
      await runtime.commit(() => {
        return { status: 'terminal', outcome: { status: 'aborted', result } }
      }, context)
    }
  })

  const extension = defineExtension({ name: SHIKI_EXTENSION_NAME, tools, hooks: [progress], tasks: [attemptTask] })

  return { extension, attemptTask, tools }
}
