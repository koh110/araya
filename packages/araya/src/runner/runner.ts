import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import {
  createRegistry,
  Harness,
  type SettledTask,
  type Storage,
  type TaskId,
  type TaskOutcome
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { loadConfig } from '../config/environment.ts'
import { loadConfigFile } from '../config/file.ts'
import { collectSecretValues, createRedactor } from '../infrastructure/redaction.ts'
import {
  createSystemdOps,
  dataDirHash,
  runnerUnitName,
  scopePattern,
  type SystemdOps
} from '../infrastructure/systemd.ts'
import {
  AttemptsDoc,
  buildAttemptErrorResult,
  buildAttemptInput,
  createShikiExtension,
  isAttemptResult,
  type AttemptFaults,
  type PiModelSettings
} from './attempt.ts'
import {
  MAX_CONCURRENT_ATTEMPTS,
  openTaskLedger,
  type AttemptResult,
  type AttemptSettings,
  type ClaimedAttempt,
  type RunningAttempt,
  type Settlement,
  type StopReason,
  type TaskLedger
} from './ledger.ts'

// runner の本体（起動、開き直したときの確認、loop、取り込み、中止、結果の記録、止めるとき、Harness が失敗で閉じたとき、log）。
// systemd の user service の中で1つだけ動き、pi-durable の storage を1つ持つ。試行は Task ごとの試行の task として動かす

const ctx = BACKGROUND_CONTEXT
const POLL_MS = 2_000
const HEARTBEAT_MS = 10_000
const CLOSE_TIMEOUT_MS = 30_000
const MAX_LOG_DETAIL_CHARS = 2_000
const STORAGE_DIR = 'runner'
const STORAGE_FILE = 'durable.sqlite'
const LOG_FILE = 'runner.log'

type Env = Readonly<Record<string, string | undefined>>

// test で順番を固定するための注入点。本物の runner では渡さない
export type RunnerFaults = {
  // 取り込みの transaction の commit の後、試行の task を作る前
  afterClaimCommit?(taskKey: string): void | Promise<void>
  // loop の中止の求めの確認（手順 3）の後
  afterCancelCheck?(taskKey: string): void | Promise<void>
  // 試行の task が終わった後、その試行の scope を止めて結果を記録する前
  beforeRecordResult?(taskKey: string): void | Promise<void>
  // abortTask を呼ぶ直前。throw すると abortTask の失敗として扱う（中止を始めるの手順 2 の失敗の経路を test するため）
  beforeAbortTask?(taskKey: string): void | Promise<void>
}

export type RunnerDependencies = {
  // --data-dir（実 path に解決してから使う）
  dataDir: string
  // runner の環境変数（unit file に書いた値と user manager の環境）
  env: Env
  platform: NodeJS.Platform
  // SIGTERM・SIGINT で中止される。中止されたら試行を中止せずに止まる（一時停止）
  stopSignal: AbortSignal
  // INVOCATION_ID と cgroup の unit 名を確かめるか。process をまたぐ test 用の entrypoint だけが false にする
  verifyUnit?: boolean
  readCgroup?: () => Promise<string>
  pid?: number
  // monotonic な時計（ms）。稼働時間と heartbeat の間隔に使う
  monotonicNow?: () => number
  // 台帳と log に書く時刻
  now?: () => Date
  openStorage?: (storagePath: string) => Promise<Storage>
  createModels?: (input: { agentDir: string; dataDir: string }) => Promise<ModelRuntime>
  createSystemdOps?: (env: Env) => Promise<SystemdOps>
  createPiSettings?: (stateDir: string, agentDir: string) => PiModelSettings
  // test が runner 全体を検証するときに delivery を無効化できる。製品 runner の既定は有効
  draftPrDelivery?: boolean
  // 実行枠の上限。既定は MAX_CONCURRENT_ATTEMPTS
  maxConcurrent?: number
  // pi-durable の restartLimit。省略すると pi-durable の既定（5）
  restartLimit?: number
  pollMs?: number
  heartbeatMs?: number
  closeTimeoutMs?: number
  faults?: RunnerFaults & AttemptFaults
}

type SettledItem = { taskKey: string; settled: SettledTask<AttemptResult> } | { taskKey: string; error: unknown }

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function defaultMonotonicNow() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

async function readProcCgroup() {
  return fs.readFile('/proc/self/cgroup', 'utf8')
}

async function realpathOr(target: string) {
  try {
    return await fs.realpath(target)
  } catch {
    return target
  }
}

// promise が timeoutMs までに決まれば done、決まらなければ timeout、失敗すれば failed
async function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      promise.then(
        (value) => {
          return { kind: 'done' as const, value }
        },
        (error: unknown) => {
          return { kind: 'failed' as const, error }
        }
      ),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

function describeOutcome(outcome: TaskOutcome<AttemptResult>) {
  switch (outcome.status) {
    case 'failed':
    case 'faulted':
      return `${outcome.status}: ${outcome.error.message}`
    case 'orphaned':
      return `${outcome.status}: ${outcome.reason}`
    case 'aborted':
      return outcome.reason === undefined ? `${outcome.status}: the attempt task has no result` : `${outcome.status}: ${outcome.reason}`
    default:
      return `${outcome.status}: the attempt task has no result`
  }
}

// <dataDir>/logs/runner.log に1行1件の JSON で追記する。秘密を置き換える。書けなくても runner は止めない
export function createRunnerLog(dataDir: string, secretValues: readonly string[], now: () => Date = () => new Date()) {
  const redactor = createRedactor(secretValues)
  const logPath = path.join(dataDir, 'logs', LOG_FILE)

  return (entry: Record<string, unknown>) => {
    try {
      const line = JSON.stringify(redactor.redactRecord({ at: now().toISOString(), ...entry }))
      appendFileSync(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // log を書けないことで runner を止めない
    }
  }
}

// runner の ModelRuntime（既存の SHIKI と同じ options）。auth は Pi の auth.json から読み、network は使わない
export async function createRunnerModelRuntime(input: { agentDir: string; dataDir: string }) {
  const runtime = await ModelRuntime.create({
    authPath: path.join(input.agentDir, 'auth.json'),
    modelsPath: path.join(input.agentDir, 'models.json'),
    modelsStorePath: path.join(input.dataDir, STORAGE_DIR, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  await runtime.refresh({ allowNetwork: false })

  return runtime
}

// bin の entrypoint が process に付ける handler。SIGTERM・SIGINT で止まるように求め、予期しない例外は log に書いて終了 code 1 で終わる
export function installRunnerProcessHandlers(controller: AbortController, log: (entry: Record<string, unknown>) => void) {
  function requestStop() {
    controller.abort()
  }

  function fail(type: string, error: unknown) {
    log({
      type,
      message: describeError(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
    })
    process.exit(1)
  }

  process.on('SIGTERM', requestStop)
  process.on('SIGINT', requestStop)
  process.on('uncaughtException', (error) => {
    fail('uncaught_exception', error)
  })
  process.on('unhandledRejection', (reason) => {
    fail('unhandled_rejection', reason)
  })
}

// 起動の手順 1: Linux、INVOCATION_ID、cgroup v2 の path の最後の要素が unit 名と同じこと
async function checkRunnerUnit(deps: RunnerDependencies, unit: string) {
  if (deps.platform !== 'linux') {
    return `the runner runs only on Linux (${deps.platform})`
  }

  if (deps.verifyUnit === false) {
    return null
  }

  if (deps.env.INVOCATION_ID === undefined || deps.env.INVOCATION_ID === '') {
    return 'INVOCATION_ID is not set; the runner must run as its systemd unit'
  }

  let cgroup: string

  try {
    cgroup = await (deps.readCgroup ?? readProcCgroup)()
  } catch (error) {
    return `the cgroup could not be read: ${describeError(error)}`
  }

  const line = cgroup.split('\n').find((candidate) => {
    return candidate.startsWith('0::')
  })

  if (line === undefined) {
    return 'no cgroup v2 entry was found'
  }

  const current = path.posix.basename(line.slice(3).trim())

  return current === unit ? null : `the runner is in ${current}, not in ${unit}`
}

export async function runTaskRunner(deps: RunnerDependencies) {
  let dataDir: string

  try {
    dataDir = await fs.realpath(path.resolve(deps.dataDir))
  } catch {
    return 1
  }

  const secretValues = collectSecretValues(deps.env)
  const now = deps.now ?? (() => {
    return new Date()
  })
  const log = createRunnerLog(dataDir, secretValues, now)
  const hash = dataDirHash(dataDir)
  const unit = runnerUnitName(hash)
  const unitError = await checkRunnerUnit(deps, unit)

  // 台帳も storage も開かずに終わる（pi-durable の storage を2つの process が開かないようにする）
  if (unitError !== null) {
    log({ type: 'runner_unit_mismatch', unit, message: unitError })
    return 1
  }

  let config: ReturnType<typeof loadConfig>

  try {
    // 台帳、storage、unit 名が同じ dataDir を指すように、--data-dir を ARAYA_DATA_DIR にする
    config = loadConfig({ ...deps.env, ARAYA_DATA_DIR: dataDir })
  } catch (error) {
    log({ type: 'config_failed', message: describeError(error) })
    return 1
  }

  let ledger: TaskLedger

  try {
    ledger = openTaskLedger(dataDir, { secretValues, now })
  } catch (error) {
    log({ type: 'ledger_failed', message: describeError(error) })
    return 1
  }

  try {
    const invocationId = deps.env.INVOCATION_ID ?? `unverified-${randomUUID()}`
    const pid = deps.pid ?? process.pid
    ledger.markRunnerStarted({ unit, invocationId, pid })
    // 次の heartbeat は、ここで書いた heartbeat_at から数える
    const heartbeatAt = (deps.monotonicNow ?? defaultMonotonicNow)()
    log({ type: 'runner_started', unit, pid, invocationId })

    return await runWithLedger({ deps, dataDir, hash, invocationId, config, ledger, log, secretValues, now, heartbeatAt })
  } catch (error) {
    log({
      type: 'unexpected_error',
      message: describeError(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
    })

    return 1
  } finally {
    ledger.close()
  }
}

type RunnerContext = {
  deps: RunnerDependencies
  dataDir: string
  hash: string
  invocationId: string
  config: ReturnType<typeof loadConfig>
  ledger: TaskLedger
  log: (entry: Record<string, unknown>) => void
  secretValues: readonly string[]
  now: () => Date
  // runner の行を書いた時点（monotonic）
  heartbeatAt: number
}

async function runWithLedger(context: RunnerContext) {
  const { deps, dataDir, hash, invocationId, config, ledger, log, secretValues, now } = context
  const monotonicNow = deps.monotonicNow ?? defaultMonotonicNow
  const pollMs = deps.pollMs ?? POLL_MS
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
  const closeTimeoutMs = deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS
  const maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT_ATTEMPTS
  const faults = deps.faults ?? {}

  // 止めるように求められた時点（monotonic）。稼働時間はこの時点まで精算する
  let stopRequestedAt: number | null = null
  let wakePending = false
  let wakeLoop: (() => void) | null = null

  function wake() {
    wakePending = true
    wakeLoop?.()
  }

  function onStop() {
    stopRequestedAt ??= monotonicNow()
    wake()
  }

  if (deps.stopSignal.aborted) {
    onStop()
  } else {
    deps.stopSignal.addEventListener('abort', onStop, { once: true })
  }

  function stopRequested() {
    return stopRequestedAt !== null
  }

  // 次の loop まで待つ。待っている試行の task が終わったとき、止めるように求められたときはすぐに戻る
  function pause() {
    return new Promise<void>((resolve) => {
      if (wakePending) {
        wakePending = false
        resolve()
        return
      }

      const timer = setTimeout(done, pollMs)

      function done() {
        clearTimeout(timer)
        wakeLoop = null
        wakePending = false
        resolve()
      }

      wakeLoop = done
    })
  }

  async function runHarness() {
    let systemd: SystemdOps

    try {
      systemd = await (deps.createSystemdOps ?? createSystemdOps)(deps.env)
    } catch (error) {
      log({ type: 'systemd_unavailable', message: describeError(error) })
      return 1
    }

    // 起動の手順 4: 前の process が残した scope の中の process が、再開した会話や次の試行と重ならないようにする
    const startupStop = await systemd.stopScopes(scopePattern(hash))

    if (!startupStop.ok) {
      log({ type: 'scope_stop_failed', pattern: scopePattern(hash), message: startupStop.error, remaining: startupStop.remaining })
      return 1
    }

    const agentDir = path.resolve(config.piAgentDir ?? path.join(os.homedir(), '.pi', 'agent'))
    const storageDir = path.join(dataDir, STORAGE_DIR)
    await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
    await fs.chmod(storageDir, 0o700)
    const models = await (deps.createModels ?? createRunnerModelRuntime)({ agentDir, dataDir })
    const { extension, attemptTask } = createShikiExtension({
      dataDir,
      hash,
      ledger,
      systemd,
      models,
      env: deps.env,
      draftPrDelivery: deps.draftPrDelivery ?? true,
      secretValues,
      log,
      now,
      faults,
      ...(deps.createPiSettings === undefined ? {} : { createPiSettings: deps.createPiSettings })
    })
    const registry = createRegistry()
    registry.install(extension)
    const reportRedactor = createRedactor(secretValues)
    const restartLimit = deps.restartLimit
    const storage = await (deps.openStorage ?? openNodeSqliteStorage)(path.join(storageDir, STORAGE_FILE))
    const harness = await Harness.open(storage, {
      models,
      registry,
      ...(restartLimit === undefined ? {} : { settings: { restartLimit } }),
      env: ({ cwd }) => {
        return new NodeExecutionEnv({ cwd: cwd ?? config.devRoot, shellEnv: { ...deps.env } })
      },
      onReport: (error, info) => {
        // 切り詰めで秘密の一部や URL の @ が境界の外に出ないように、置き換えてから切り詰める
        log({ type: 'report', report: info.type, message: reportRedactor.redact(describeError(error)).slice(0, MAX_LOG_DETAIL_CHARS) })
      }
    }, ctx)

    // runner が close() を呼んだか。呼んでいないのに閉じ始めたら、Harness が失敗で閉じた
    let closingByRunner = false
    let harnessFailedAt: number | null = null
    harness.subscribeClose(() => {
      if (!closingByRunner && harnessFailedAt === null) {
        harnessFailedAt = monotonicNow()
        wake()
      }
    })

    function harnessFailed() {
      return harnessFailedAt !== null
    }

    // この process が動かしている試行の taskKey → 稼働時間の起点（monotonic）
    const origins = new Map<string, number>()
    // taskKey → 試行の task の id（session の document か、この process が作ったもの）
    const taskIds = new Map<string, TaskId<AttemptResult>>()
    // waitForTask で終わりを待っている試行
    const waiting = new Set<string>()
    // この process が abortTask を呼んだ試行（loop は abortTask を呼び直さない）
    const abortCalled = new Set<string>()
    const settledQueue: SettledItem[] = []
    // 記録の前に scope を止められず、次の loop で記録し直す結果
    const pendingResults = new Map<string, AttemptResult>()
    let abortFailed = false
    let reportedConfigError: string | null = null

    function shouldExit() {
      return stopRequested() || harnessFailed() || abortFailed
    }

    // 未加算の稼働時間を at の時点まで精算し、起点を進める
    function settlements(at: number) {
      const result: Settlement[] = []

      for (const [taskKey, origin] of origins) {
        result.push({ taskKey, addMs: Math.max(0, at - origin) })
        origins.set(taskKey, Math.max(origin, at))
      }

      return result
    }

    function activeMsOf(attempt: RunningAttempt, at: number) {
      const origin = origins.get(attempt.taskKey)

      return attempt.activeMs + (origin === undefined ? 0 : Math.max(0, at - origin))
    }

    function startWaiting(taskKey: string) {
      const id = taskIds.get(taskKey)

      if (id === undefined || waiting.has(taskKey)) {
        return
      }

      waiting.add(taskKey)
      harness.waitForTask(id, ctx).then(
        (settled) => {
          settledQueue.push({ taskKey, settled })
          wake()
        },
        (error: unknown) => {
          settledQueue.push({ taskKey, error })
          wake()
        }
      )
    }

    // 試行の task を作り、session の document に taskKey と task の id を書く（1つの commit）。document に id があれば作らない
    async function createAttemptTask(claimed: ClaimedAttempt) {
      try {
        const root = await harness.root(ctx)
        const id = await root.commit(async (tx) => {
          const attempts = await tx.doc(AttemptsDoc)
          const existing = attempts.byTaskKey[claimed.taskKey]

          if (existing !== undefined) {
            return existing.taskId
          }

          const created = await tx.createTask(attemptTask, buildAttemptInput(claimed), { ownership: { kind: 'conversation' }, background: true })
          attempts.byTaskKey[claimed.taskKey] = { taskId: created }

          return created
        }, ctx)
        taskIds.set(claimed.taskKey, id)

        return true
      } catch (error) {
        // Harness が閉じ始めた後の失敗は、task の作成の失敗として扱わない
        if (!harnessFailed()) {
          log({ type: 'attempt_task_create_failed', taskKey: claimed.taskKey, message: describeError(error) })
        }

        return false
      }
    }

    async function abortAttemptTask(taskKey: string) {
      const id = taskIds.get(taskKey)

      if (id === undefined) {
        return
      }

      abortCalled.add(taskKey)

      try {
        await faults.beforeAbortTask?.(taskKey)
        const result = await harness.abortTask(id, ctx)
        log({ type: 'attempt_abort', taskKey, result })
      } catch (error) {
        if (harnessFailed()) {
          return
        }

        log({ type: 'attempt_abort_failed', taskKey, message: describeError(error) })
        abortFailed = true
      }
    }

    // 中止を始める。台帳に理由を書けたときだけ abortTask を呼ぶ
    async function beginAttemptStop(taskKey: string, reason: StopReason, detail: string | null) {
      if (!ledger.beginStop(taskKey, reason, detail)) {
        return
      }

      log({ type: 'attempt_stopping', taskKey, reason })
      await abortAttemptTask(taskKey)
    }

    // 開き直したときの確認（resume() の前）。ここでは waitForTask を呼ばない
    async function reconcile() {
      const running = ledger.listRunningAttempts()
      const runningKeys = new Set(running.map((attempt) => {
        return attempt.taskKey
      }))
      const attempts = await harness.snapshot(AttemptsDoc, ctx)
      const keyByTaskId = new Map<string, string>()

      for (const [taskKey, entry] of Object.entries(attempts?.byTaskKey ?? {})) {
        keyByTaskId.set(String(entry.taskId), taskKey)
      }

      const resumed: string[] = []
      const created: string[] = []

      for (const attempt of running) {
        const entry = attempts?.byTaskKey[attempt.taskKey]

        if (entry !== undefined) {
          taskIds.set(attempt.taskKey, entry.taskId)
          ledger.appendRunResumed(attempt.taskKey)
          resumed.push(attempt.taskKey)
          continue
        }

        // 台帳で取り込んだ後、task を作る前に落ちた
        const claimed = ledger.readClaimedAttempt(attempt.taskKey)

        if (claimed !== null && await createAttemptTask(claimed)) {
          created.push(attempt.taskKey)
        }

        if (harnessFailed()) {
          return
        }
      }

      const inspection = await harness.inspect(ctx)
      const blocked: { taskKey: string; reason: string }[] = []

      for (const item of inspection.tasks) {
        // 止めるように求められたか、Harness が閉じ始めた後は、中止を新しく始めない
        if (shouldExit()) {
          return
        }

        const ownKey = keyByTaskId.get(String(item.record.id))
        const taskKey = ownKey ?? attempts?.byConversation[String(item.record.conversationId)]?.taskKey

        if (taskKey === undefined) {
          continue
        }

        if (!runningKeys.has(taskKey)) {
          // 台帳で running でない試行の task は、台帳に何も書かずに中止する
          const entry = attempts?.byTaskKey[taskKey]

          if (ownKey !== undefined && entry !== undefined) {
            taskIds.set(taskKey, entry.taskId)
            await abortAttemptTask(taskKey)
            taskIds.delete(taskKey)
          }

          continue
        }

        if (item.state.kind === 'blocked') {
          const state = item.state
          blocked.push({ taskKey, reason: state.reason })

          if (state.reason === 'restart_limit') {
            await beginAttemptStop(taskKey, 'restart_limit', null)
          } else {
            const cause = state.error === undefined ? '' : `: ${describeError(state.error)}`
            await beginAttemptStop(taskKey, 'attempt_error', `the attempt task is blocked (${state.reason})${cause}`)
          }
        }
      }

      for (const attempt of ledger.listRunningAttempts()) {
        if (shouldExit()) {
          return
        }

        // task がまだ無い試行は、loop で task を作った後に中止する
        if (abortCalled.has(attempt.taskKey) || !taskIds.has(attempt.taskKey)) {
          continue
        }

        if (attempt.stopReason !== null) {
          // 前の process が中止を始めた後に落ちた
          await abortAttemptTask(attempt.taskKey)
        } else if (attempt.cancelRequestedAt !== null) {
          await beginAttemptStop(attempt.taskKey, 'cancelled', null)
        } else if (attempt.agentFinishedAt === null && attempt.settings !== null && attempt.activeMs >= attempt.settings.timeoutMs) {
          await beginAttemptStop(attempt.taskKey, 'agent_timeout', null)
        }
      }

      log({ type: 'reconciled', running: [...runningKeys], resumed, created, blocked })
    }

    // loop の手順 2・3: 期限を過ぎた試行と、中止を求められた試行の中止を始める
    async function stopDueAttempts() {
      const at = monotonicNow()

      for (const attempt of ledger.listRunningAttempts()) {
        if (shouldExit()) {
          return
        }

        if (!taskIds.has(attempt.taskKey) || attempt.stopReason !== null || attempt.agentFinishedAt !== null || attempt.settings === null) {
          continue
        }

        if (activeMsOf(attempt, at) >= attempt.settings.timeoutMs) {
          await beginAttemptStop(attempt.taskKey, 'agent_timeout', null)
        }
      }

      for (const attempt of ledger.listRunningAttempts()) {
        if (shouldExit()) {
          return
        }

        if (!taskIds.has(attempt.taskKey)) {
          continue
        }

        if (attempt.cancelRequestedAt !== null && attempt.stopReason === null) {
          await beginAttemptStop(attempt.taskKey, 'cancelled', null)
        }

        await faults.afterCancelCheck?.(attempt.taskKey)
      }
    }

    // loop の手順 4: 台帳で running なのに、この process がまだ task を待っていない試行の task を作る
    async function recreateMissingTasks() {
      let createdAny = false

      for (const attempt of ledger.listRunningAttempts()) {
        if (shouldExit()) {
          return createdAny
        }

        if (taskIds.has(attempt.taskKey)) {
          continue
        }

        const claimed = ledger.readClaimedAttempt(attempt.taskKey)

        if (claimed === null) {
          continue
        }

        if (!origins.has(attempt.taskKey)) {
          origins.set(attempt.taskKey, monotonicNow())
        }

        if (await createAttemptTask(claimed)) {
          startWaiting(attempt.taskKey)
          createdAny = true
        }
      }

      return createdAny
    }

    // 取り込みの手順 1: 設定ファイルを読み、試行の設定を作る。不正なら null（内容が変わるまで log に1回だけ書く）
    async function readAttemptSettings() {
      let developmentModel: AttemptSettings['model']

      try {
        developmentModel = (await loadConfigFile(config.configPath)).developmentModel
        reportedConfigError = null
      } catch (error) {
        const message = describeError(error)

        if (message !== reportedConfigError) {
          log({ type: 'config_file_invalid', message })
          reportedConfigError = message
        }

        return null
      }

      await models.refresh({ allowNetwork: false })
      const settings: AttemptSettings = {
        devRoot: await realpathOr(config.devRoot),
        agentDir,
        model: developmentModel,
        timeoutMs: config.developmentTimeoutMs,
        verificationTimeoutMs: config.verificationTimeoutMs
      }

      return settings
    }

    // loop の手順 5: 空きと待ちがある間、古い順に取り込む
    async function claimAttempts() {
      if (shouldExit() || !ledger.hasClaimableAttempt(maxConcurrent)) {
        return
      }

      const settings = await readAttemptSettings()

      if (settings === null) {
        return
      }

      while (!shouldExit()) {
        const claimed = ledger.claimNextAttempt(maxConcurrent, settings)

        if (claimed === null) {
          return
        }

        // 待っていた時間は数えない
        origins.set(claimed.taskKey, monotonicNow())
        log({ type: 'attempt_claimed', taskKey: claimed.taskKey })
        await faults.afterClaimCommit?.(claimed.taskKey)

        if (shouldExit()) {
          return
        }

        // 作れなければ次の loop の手順 4 で作り直す
        if (await createAttemptTask(claimed)) {
          startWaiting(claimed.taskKey)
        }
      }
    }

    async function resultOf(item: SettledItem) {
      let detail: string

      if ('settled' in item) {
        const outcome = item.settled.state.outcome

        if ((outcome.status === 'completed' || outcome.status === 'aborted') && isAttemptResult(outcome.result)) {
          return outcome.result
        }

        detail = describeOutcome(outcome)
      } else {
        detail = `waitForTask failed: ${describeError(item.error)}`
      }

      const attempt = ledger.listRunningAttempts().find((candidate) => {
        return candidate.taskKey === item.taskKey
      })

      return buildAttemptErrorResult({
        dataDir,
        taskKey: item.taskKey,
        settings: attempt?.settings ?? null,
        detail,
        secretValues
      })
    }

    // loop の手順 6: 終わった試行の task の結果を、その試行の scope を止めてから記録する
    async function recordSettled() {
      for (const item of settledQueue.splice(0)) {
        if (shouldExit()) {
          return
        }

        waiting.delete(item.taskKey)
        pendingResults.set(item.taskKey, await resultOf(item))
      }

      for (const [taskKey, result] of pendingResults) {
        if (shouldExit()) {
          return
        }

        await faults.beforeRecordResult?.(taskKey)
        const stopped = await systemd.stopScopes(scopePattern(hash, taskKey))

        if (!stopped.ok) {
          // 結果を記録せず、枠も空けない。次の loop でやり直す
          log({ type: 'scope_stop_failed', taskKey, pattern: scopePattern(hash, taskKey), message: stopped.error, remaining: stopped.remaining })
          continue
        }

        // scope を止めている間に止めるように求められたか、Harness が閉じ始めていれば、記録せずに次の起動に持ち越す。
        // 試行は running のままで、稼働時間は止めるとき・Harness が失敗で閉じたときの精算で数える（起点は消さない）
        if (shouldExit()) {
          return
        }

        const at = monotonicNow()
        const origin = origins.get(taskKey) ?? at
        const recorded = ledger.recordResult(taskKey, result, { taskKey, addMs: Math.max(0, at - origin) })
        pendingResults.delete(taskKey)
        origins.delete(taskKey)
        taskIds.delete(taskKey)
        abortCalled.delete(taskKey)
        log(recorded.recorded
          ? { type: 'attempt_finished', taskKey, status: recorded.status, failureReason: recorded.failureReason }
          : { type: 'attempt_finished', taskKey, recorded: false })
      }
    }

    async function loop() {
      let lastHeartbeat = context.heartbeatAt

      while (!shouldExit()) {
        const at = monotonicNow()

        if (at - lastHeartbeat >= heartbeatMs) {
          ledger.heartbeat(invocationId, settlements(at))
          lastHeartbeat = at
        }

        await stopDueAttempts()

        // task を作った試行は、同じ loop の中で期限と中止の求めを確かめ直す
        if (await recreateMissingTasks()) {
          await stopDueAttempts()
        }

        await claimAttempts()
        await recordSettled()

        if (shouldExit()) {
          return
        }

        await pause()
      }
    }

    // 止めるとき（一時停止）。Harness を閉じてから scope を止め、稼働時間を精算して stopped にする
    async function finishStop() {
      const stoppedAt = stopRequestedAt ?? monotonicNow()
      log({ type: 'runner_stopping' })
      closingByRunner = true
      const closed = await settleWithin(harness.close(ctx), closeTimeoutMs)
      let code = 0

      if (closed.kind === 'timeout') {
        log({ type: 'harness_close_timeout' })
        code = 1
      } else {
        if (closed.kind === 'failed') {
          log({ type: 'harness_close_failed', message: describeError(closed.error) })
          code = 1
        }

        const stopped = await systemd.stopScopes(scopePattern(hash))

        if (!stopped.ok) {
          log({ type: 'scope_stop_failed', pattern: scopePattern(hash), message: stopped.error, remaining: stopped.remaining })
          code = 1
        }
      }

      ledger.markRunnerStopped(invocationId, settlements(stoppedAt))
      log({ type: 'runner_stopped', code })

      return code
    }

    // Harness が失敗で閉じたとき。閉じ終わるのを待ち、scope を止め、閉じ始めた時点まで精算する（runner の行は変えない）
    async function finishAfterHarnessFailure() {
      const failedAt = harnessFailedAt ?? monotonicNow()
      const closed = await settleWithin(harness.closed, closeTimeoutMs)
      const end = closed.kind === 'done' ? closed.value : undefined
      log({
        type: 'harness_failed',
        ...(closed.kind === 'timeout' ? { closeTimedOut: true } : {}),
        ...(typeof end === 'object' && end !== null && 'error' in end ? { message: describeError(end.error) } : {})
      })
      const stopped = await systemd.stopScopes(scopePattern(hash))

      if (!stopped.ok) {
        log({ type: 'scope_stop_failed', pattern: scopePattern(hash), message: stopped.error, remaining: stopped.remaining })
      }

      try {
        ledger.settleActiveTime(settlements(failedAt))
      } catch (error) {
        log({ type: 'settle_failed', message: describeError(error) })
      }

      return 1
    }

    // abortTask の失敗と予期しない誤り。Harness を閉じ、scope を止め、今の時点まで精算する（runner の行は変えない）
    async function finishAfterError() {
      closingByRunner = true
      const closed = await settleWithin(harness.close(ctx), closeTimeoutMs)

      if (closed.kind !== 'done') {
        log({ type: closed.kind === 'timeout' ? 'harness_close_timeout' : 'harness_close_failed' })
      }

      const stopped = await systemd.stopScopes(scopePattern(hash))

      if (!stopped.ok) {
        log({ type: 'scope_stop_failed', pattern: scopePattern(hash), message: stopped.error, remaining: stopped.remaining })
      }

      try {
        ledger.settleActiveTime(settlements(monotonicNow()))
      } catch (error) {
        log({ type: 'settle_failed', message: describeError(error) })
      }

      return 1
    }

    try {
      await reconcile()

      if (!shouldExit()) {
        harness.resume()
        // resume() を呼んだ時点を、running の試行すべての稼働時間の起点にする
        const resumedAt = monotonicNow()

        for (const attempt of ledger.listRunningAttempts()) {
          origins.set(attempt.taskKey, resumedAt)
          startWaiting(attempt.taskKey)
        }

        await loop()
      }
    } catch (error) {
      if (!harnessFailed()) {
        log({
          type: 'unexpected_error',
          message: describeError(error),
          ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {})
        })

        return finishAfterError()
      }
    }

    if (harnessFailed()) {
      return finishAfterHarnessFailure()
    }

    if (abortFailed) {
      return finishAfterError()
    }

    return finishStop()
  }

  try {
    return await runHarness()
  } finally {
    deps.stopSignal.removeEventListener('abort', onStop)
  }
}
