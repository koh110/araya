// Discord bot の常駐 loop。unit 稼働の確かめ、agent session の open、gateway 接続を組み立てる。
// 設定が無ければ有効化されない（discord_disabled を log して終了 code 1。unit file を入れるのは人間）
// log は <dataDir>/logs/discord.log（JSON lines）。external 由来の文字列は秘密を置き換えてから書く

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { collectSecretValues, createRedactor } from '../infrastructure/redaction.ts'
import { ensurePrivateLogFile } from '../infrastructure/private-file-mode.ts'
import { dataDirHash, discordUnitName } from '../infrastructure/systemd.ts'
import { loadDiscordConfig, type DiscordConfig } from './config.ts'
import {
  CHAT_SHUTDOWN_UNPROCESSED_REPLY,
  CHAT_UNAVAILABLE_REPLY,
  createDiscordChatHandler,
  splitDiscordChatReply,
  type DiscordChatHandler,
} from './chat.ts'
import { ARAYA_SLASH_COMMANDS, SESSION_COMMAND_NAME, validateArayaSlashCommands } from './slash.ts'
import { CLI_CONTROL_POLL_MS, createCliControlLoop } from './cli-control.ts'
import { createDefaultArayaAgentSession, type ArayaAgentSession } from '../agent/host.ts'
import { createHootLoop } from '../hoot/tick.ts'
import type { ObservationDependencies } from '../hoot/observe.ts'
import { readHootState } from '../hoot/store.ts'
import {
  createDiscordGateway,
  type DiscordGateway,
  type DiscordGatewayHandlers,
} from './gateway.ts'
import {
  isDiscordMessageIdNewer,
  canAdvanceCursorPast,
  idsBehindCursor,
  newState,
  noteDiscordSeenMessageId,
  readDiscordBotState,
  writeDiscordBotState,
  type DiscordBotState,
} from './state.ts'
import { runDiscordRestartBackfill } from './backfill.ts'
import {
  currentDiscordLockOwner,
  discordLockPath,
  reclaimDeadDiscordProcessLock,
  removeDiscordLockOwner,
  writeDiscordLockOwner,
  type DiscordLockReclaim,
} from './process-lock.ts'
import {
  discordRestartStartedText,
  postDiscordRestartNotice,
  type RestartNoticeFetch,
} from './restart-notice.ts'

type ProperLockfile = {
  lock(
    resourcePath: string,
    options: {
      lockfilePath: string
      retries: number
      stale: number
      update: number
      onCompromised?: (error: Error) => void
    },
  ): Promise<() => Promise<void>>
}

const properLockfile: ProperLockfile = createRequire(import.meta.url)('proper-lockfile')
const DISCORD_PROCESS_LOCK_STALE_MS = 30_000
const DISCORD_PROCESS_LOCK_UPDATE_MS = 10_000
// 残留 lock を先行回収してよい最小 age。生きている holder は update 周期で mtime を更新するので、
// その半分より若い lock を削るのは「 refresh が止まっている」証拠が揃うまで待つ
const DISCORD_PROCESS_LOCK_MIN_RECLAIM_AGE_MS = DISCORD_PROCESS_LOCK_UPDATE_MS / 2
const DEFAULT_POLL_MS = 5_000
// #36: shutdown は budget 付きで進める。unit の TimeoutStopSec=30 に収まる合計にする（越えた分は SIGKILL になり、
// 残留 lock（#37）と message を受信できない時間を増やす）。drain を無制限に待つことが 67 s の取りこぼしの一方の要因だった
export const SHUTDOWN_WAIT_MS = {
  // HOOT 判断 run。判断 state は durable なので、待てなくても次の tick で resume する
  hootMs: 5_000,
  // 受理済みの conversation turn と reply 送信
  drainMs: 10_000,
  // gateway close
  gatewayMs: 5_000,
  // agent session close
  sessionMs: 5_000,
} as const
export const SHUTDOWN_BUDGET_TOTAL_MS =
  SHUTDOWN_WAIT_MS.hootMs + SHUTDOWN_WAIT_MS.drainMs + SHUTDOWN_WAIT_MS.gatewayMs + SHUTDOWN_WAIT_MS.sessionMs
export type DiscordShutdownWaits = { [key in keyof typeof SHUTDOWN_WAIT_MS]: number }
// CLI の control request を bot 内部で処理するときの user 識別子（Discord の user ではない。log と session に残す name）
const CLI_CONTROL_USER = 'cli'

export type DiscordBotDependencies = {
  dataDir: string
  env: Readonly<Record<string, string | undefined>>
  stopSignal: AbortSignal
  // systemd の unit として起動したことを確かめる。foreground（araya discord run）と test では false を渡す
  verifyUnit?: boolean
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  pollMs?: number
  // 壁時計 ms（backoff の待ち時刻の基準）
  nowMs?: () => number
  // 通知投稿の REST fetch を test で差し替える。既定は global fetch
  fetch?: RestartNoticeFetch
  createGateway?: (
    config: DiscordConfig,
    handlers: DiscordGatewayHandlers,
  ) => Promise<DiscordGateway>
  createChatSession?: typeof createDefaultArayaAgentSession
  log?: (entry: Record<string, unknown>) => void
  // test で shutdown budget を短くする。既定は SHUTDOWN_WAIT_MS（production 値）
  shutdownWaits?: Partial<DiscordShutdownWaits>
  // HOOT loop の poll 間隔（test で短くする）。既定 60000
  hootPollMs?: number
  // CLI の control request を拾う poll 間隔（test で短くする）。既定 1000
  cliControlPollMs?: number
  // HOOT 観測の command 実行（test で fake を入れる）。既定は runBoundedCommand での gh 実行
  hootRunCommand?: ObservationDependencies['runCommand']
  hootObservationTimeoutMs?: number
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()

      return
    }

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

// log 失敗で bot を止めない。appendFileSync は 1 行ずつ開く（小さい log なので十分）
// mode については appendFileSync だけでは決まらない: 新規 file は process の umask を引いた mode で作られ
// （実測 0664）、既にある file の mode はそのまま残る。mode の約束は下の createFileLogger で整える
function fileLogger(filePath: string) {
  return (entry: Record<string, unknown>) => {
    try {
      // ts を先頭に: 「いつ」起きたかを log から直接追えるようにする
      fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
    } catch {
      // log が書けないことは診断の失敗で、処理は続けないよりマシに扱う（次 tick でまた試みる）
    }
  }
}

// <dataDir>/logs を 0700、discord.log を 0600 に整えてから logger を作る（docs の「log file は mode 0600」を
// 実側の値にする）。整えられなくても bot は止めず、discord.log 自身に discord_log_mode_failed を出す
// （log が書けない状況だとその 1 行も落ちない。fileLogger は append 失敗を握る）
async function createFileLogger(dataDir: string) {
  const filePath = path.join(dataDir, 'logs', 'discord.log')
  const log = fileLogger(filePath)
  const outcome = await ensurePrivateLogFile(filePath)

  if (!outcome.ok) {
    log({ type: 'discord_log_mode_failed', message: outcome.message.slice(0, 500) })
  }

  return log
}

// systemd unit process であることを INVOCATION_ID と cgroup で確かめる
type WaitOutcome = { outcome: 'done' } | { outcome: 'failed'; error: unknown } | { outcome: 'timeout' }

// budget 内に task を収める。越えたら timeout を返して置きに行く（実行中の reply 送信を途中で潰すより、
// 次の SIGKILL に任せる方が被害が小さい。task の throw は here で握らず failed として返す）
async function waitWithBudget(task: Promise<unknown>, budgetMs: number): Promise<WaitOutcome> {
  let timer: NodeJS.Timeout | undefined

  const outcome = await new Promise<WaitOutcome>((resolve) => {
    let settled = false

    timer = setTimeout(() => {
      if (settled) {
        return
      }

      settled = true
      resolve({ outcome: 'timeout' })
    }, budgetMs)
    timer.unref?.()

    void task.then(
      () => {
        if (settled) {
          return
        }

        settled = true
        resolve({ outcome: 'done' })
      },
      (error: unknown) => {
        if (settled) {
          return
        }

        settled = true
        resolve({ outcome: 'failed', error })
      }
    )
  })

  if (timer !== undefined) {
    clearTimeout(timer)
  }

  return outcome
}

async function verifyDiscordUnit(
  expectedUnit: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  const invocationId = env.INVOCATION_ID ?? ''

  if (invocationId === '') {
    throw Object.assign(
      new Error(
        'discord_unit_unverified: INVOCATION_ID がありません。systemd の unit として起動するか、foreground では araya discord run を使ってください',
      ),
      { code: 'discord_unit_unverified' },
    )
  }

  const cgroup = await fs.promises.readFile('/proc/self/cgroup', 'utf8')
  const lines = cgroup.trim().split(/\r?\n/u)
  const unitPathValue =
    lines
      .map((line) => {
        return line.split(':').at(-1) ?? ''
      })
      .filter((value) => {
        return value !== ''
      })
      .at(-1) ?? ''
  const unitName = path.posix.basename(unitPathValue)

  if (unitName !== expectedUnit) {
    throw Object.assign(
      new Error(`discord_unit_unverified: unit の名前が一致しません（期待 ${expectedUnit}）`),
      { code: 'discord_unit_unverified' },
    )
  }
}

// systemd と foreground の同じ dataDir 起動を排他し、異常終了後は残留 lock を即回収する（#37）。
// proper-lockfile の stale（30 s）だけを待つと SIGKILL 後に 20〜40 s 起動できない状態が続く。
// owner record で「 holder が実在しない」と確かめられた分だけ先に回収し、生存 holder の排他は保つ。
// ELOCKED には判定理由（owner PID・lock age）を載せて、呼び出し側の log で追えるようにする。
async function acquireDiscordProcessLock(
  dataDir: string,
  log: (entry: Record<string, unknown>) => void,
  onCompromised: (error: Error) => void,
): Promise<{ release: () => Promise<void>; canonicalDataDir: string }> {
  const canonicalDataDir = await fs.promises.realpath(dataDir)
  const lockOptions = {
    lockfilePath: discordLockPath(canonicalDataDir),
    retries: 0,
    stale: DISCORD_PROCESS_LOCK_STALE_MS,
    update: DISCORD_PROCESS_LOCK_UPDATE_MS,
    onCompromised,
  }
  const acquire = async (): Promise<() => Promise<void>> => {
    const release = await properLockfile.lock(canonicalDataDir, lockOptions)
    await writeDiscordLockOwner(canonicalDataDir, currentDiscordLockOwner())

    return release
  }

  try {
    return { release: await acquire(), canonicalDataDir }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ELOCKED') {
      throw error
    }
  }

  const reclaim = await reclaimDeadDiscordProcessLock(canonicalDataDir, {
    nowMs: (): number => Date.now(),
    minLockAgeMs: DISCORD_PROCESS_LOCK_MIN_RECLAIM_AGE_MS,
  })

  if (!reclaim.reclaimed) {
    throw lockedError(reclaim)
  }

  log({
    type: 'discord_lock_reclaimed',
    ownerPid: reclaim.ownerPid,
    ownerStatus: reclaim.ownerStatus,
    lockAgeMs: Math.round(reclaim.lockAgeMs),
  })

  try {
    return { release: await acquire(), canonicalDataDir }
  } catch {
    // 回収の隙間に別の起動が lock を取った。排他は保たれているので従来どおり起動失敗で返す
    throw lockedError({ ...reclaim, reason: 'reclaim_race' })
  }
}

function lockedError(reclaim: DiscordLockReclaim): Error {
  return Object.assign(new Error('discord_already_running'), {
    code: 'ELOCKED',
    lockReason: reclaim.reason,
    lockOwnerPid: reclaim.ownerPid,
    lockOwnerStatus: reclaim.ownerStatus,
    lockAgeMs: Math.round(reclaim.lockAgeMs),
  })
}

// ELOCKED に載せた診断情報を log entry に落とす（値が無い型は key ごと省略する）
function lockDiagnosticsOf(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {}
  }

  const record = error as Error & {
    lockReason?: unknown
    lockOwnerPid?: unknown
    lockOwnerStatus?: unknown
    lockAgeMs?: unknown
  }
  const entry: Record<string, unknown> = {}

  if (typeof record.lockReason === 'string') {
    entry.lockReason = record.lockReason
  }

  if (typeof record.lockOwnerPid === 'number') {
    entry.lockOwnerPid = record.lockOwnerPid
  }

  if (typeof record.lockOwnerStatus === 'string') {
    entry.lockOwnerStatus = record.lockOwnerStatus
  }

  if (typeof record.lockAgeMs === 'number') {
    entry.lockAgeMs = record.lockAgeMs
  }

  return entry
}

export async function runDiscordBot(deps: DiscordBotDependencies) {
  try {
    await fs.promises.mkdir(path.join(deps.dataDir, 'logs'), { recursive: true, mode: 0o700 })
  } catch {
    // runDiscordBotUnlocked が設定の誤りを処理し、必要なら失敗を記録する
  }

  const log = deps.log ?? (await createFileLogger(deps.dataDir))
  const redactor = createRedactor(collectSecretValues(deps.env))
  // lock の維持が壊れた（stale を越えて mtime を更新できなかった）ときは library の既定である timer 内 throw
  // （未処理例外で process が死んで残留 lock を残すもう一つの入口）にせず、clean shutdown に入る
  const lockLost = new AbortController()
  const onLockCompromised = (error: Error): void => {
    log({
      type: 'discord_lock_compromised',
      message: redactor.redact(errorMessage(error)).slice(0, 500),
    })
    lockLost.abort()
  }
  let acquired: { release: () => Promise<void>; canonicalDataDir: string }

  try {
    acquired = await acquireDiscordProcessLock(deps.dataDir, log, onLockCompromised)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
      log({ type: 'discord_already_running', ...lockDiagnosticsOf(error) })

      return 1
    }

    log({
      type: 'discord_instance_lock_failed',
      message: redactor.redact(errorMessage(error)).slice(0, 500),
    })

    return 1
  }

  const shutdown = new AbortController()

  for (const signal of [deps.stopSignal, lockLost.signal]) {
    if (signal.aborted) {
      shutdown.abort()

      break
    }

    signal.addEventListener('abort', () => {
      shutdown.abort()
    }, { once: true })
  }

  try {
    return await runDiscordBotUnlocked({
      ...deps,
      // lock 用に整えた logger をそのまま使い回す（mode を整える作業を 1 起動で 2 度やらない）
      log,
      stopSignal: shutdown.signal,
    })
  } finally {
    try {
      await acquired.release()
    } catch {
      // 回収済み lock の release 失敗（ENOTACQUIRED 等）で終了処理を止めない
    }

    await removeDiscordLockOwner(acquired.canonicalDataDir)
  }
}

async function runDiscordBotUnlocked(deps: DiscordBotDependencies) {
  const dataDir = deps.dataDir
  const nowMs =
    deps.nowMs ??
    (() => {
      return Date.now()
    })
  const sleep = deps.sleep ?? defaultSleep
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS

  const log = deps.log ?? (await createFileLogger(dataDir))
  const environmentSecretValues = collectSecretValues(deps.env)
  let redactor = createRedactor(environmentSecretValues)
  function logSafe(entry: Record<string, unknown>) {
    log(entry)
  }
  function logError(type: string, error: unknown, extra: Record<string, unknown> = {}) {
    logSafe({ type, ...extra, message: redactor.redact(errorMessage(error)).slice(0, 500) })
  }

  let source

  try {
    source = await loadDiscordConfig(dataDir, deps.env)
  } catch (error) {
    logError('discord_config_failed', error)

    return 1
  }

  if (!source.enabled) {
    logSafe({ type: 'discord_disabled', reason: 'not_configured' })

    return 1
  }

  const config = source.config
  // .env から読んだ bot token も ledger、reply、notification の全経路で伏せる
  const secretValues = [...new Set([...environmentSecretValues, config.botToken])]
  redactor = createRedactor(secretValues)
  const dataHash = dataDirHash(await fs.promises.realpath(dataDir))
  const unit = discordUnitName(dataHash)
  const readyId = randomUUID()

  if (deps.verifyUnit !== false) {
    try {
      await verifyDiscordUnit(unit, deps.env)
    } catch (error) {
      logError('discord_unit_unverified', error)

      return 1
    }
  }

  let state: DiscordBotState

  try {
    // 旧 version が残した既知 key 以外（通知 retry 用の cursor・backoff など）は state へ引き込まない。
    // ここで log に出すので、次の state 書き込みで file から消える（unknown key を理由に起動は止めない）
    state =
      readDiscordBotState(dataDir, (keys) => {
        logSafe({ type: 'discord_state_extra_keys', keys })
      }) ?? newState()
  } catch (error) {
    logError('discord_state_failed', error)

    return 1
  }

  // 起動通知を「再起動しました」「起動しました」に分ける基準。onReady が state を更新する前の値を使う
  const previousLastReadyAt = state.lastReadyAt

  let chatSession: ArayaAgentSession | null = null
  // report の deliver は gateway 作成後でないと送れないので、late binding で参照する。
  // 作成失敗時は reject とし、配送待ちの reporter が close を止めない
  type GatewaySettlement = { ok: true; gateway: DiscordGateway } | { ok: false; error: Error }
  let settleGatewayReady: (settlement: GatewaySettlement) => void = () => {}
  const gatewayReady = new Promise<GatewaySettlement>((resolve) => {
    settleGatewayReady = resolve
  })

  async function deliverReport(name: string, text: string, nonce: string) {
    const settlement = await gatewayReady

    if (!settlement.ok) {
      throw settlement.error
    }

    const chunks = splitDiscordChatReply(redactor.redact(`task[${name}] の報告:\n${text}`))

    for (const [index, chunk] of chunks.entries()) {
      // nonce は 25 文字上限。chunk suffix を付けると再送でも同じ nonce になる
      await settlement.gateway.sendText(chunk, index === 0 ? nonce : `${nonce}-${index.toString(36)}`)
    }
  }

  async function deliverProgress(text: string, nonce: string) {
    const settlement = await gatewayReady

    if (!settlement.ok) {
      throw settlement.error
    }

    await settlement.gateway.sendText(redactor.redact(text), nonce)
  }

  async function closeChatSession() {
    try {
      await chatSession?.close?.()
    } catch (error) {
      logError('discord_chat_close_failed', error)
    }
  }

  try {
    chatSession = await (deps.createChatSession ?? createDefaultArayaAgentSession)({
      dataDir,
      env: deps.env,
      redactor,
      deliverReport,
      deliverProgress,
      log: logSafe,
    })
    logSafe({ type: 'discord_chat_ready' })
  } catch (error) {
    logError('discord_chat_unavailable', error)
  }

  const chatHandlerRef: { current: DiscordChatHandler | null } = { current: null }
  // #36: この process が処理を終えた（turn を完走・破棄した / backfill が処理を始めた）message id。
  // backfill は cursor とこの Set で重複を飛ばす。受理しただけの id はここへ書かない（次へ）
  const liveMessageIds = new Set<string>()
  // 受理して turn が実行中の ids。live と backfill が同じ message を二重に走らせないための排他で、
  // backfill はこの id を discord_backfill_ignored reason:"live_processing" で飛ばす。
  // 受理の事実を liveMessageIds に書いて gate にすると、unfinished の id が live gate で止まって
  // backfill が取り直せなくなる（at-least-once）。実行中である事実だけを書く
  const liveProcessingMessageIds = new Set<string>()
  // #36: 受理したが turn が終わっていない id。cursor をこの Set より新しい所へ進めると、
  // 実行中に kill された message が backfill の対象から消えて二度と処理されない（at-least-once の gate）。
  // memory だけだと restart で消える（2026-11-24 の incident で 08:00 の shutdown 後に unfinished が無いまま
  // Araya 自身の message で cursor が unfinished より後ろへ進み、3 件が恒久的に処理されなかった）ので
  // state.json に書き、起動時にここへ復元する
  const unfinishedMessageIds = new Set<string>(state.unfinishedMessageIds ?? [])
  // turn を終えて実応答を送れたが、cursor がより古い unfinished で止まっている ids。Discord は同じ author +
  // 同じ nonce を過去数分のあいだ 1 通にまとめるだけなので、restart 後の再応答は nonce では止められない。
  // state.json に残して再応答を抑える（answered だけに依存する択は state.ts の field comment に書いた）
  const answeredMessageIds = new Set<string>(state.answeredMessageIds ?? [])
  // shutdown に入ったら cursor を進めない。drain budget で置き去りにした turn の promise が後で
  // 解決して cursor が動くと、その message が backfill の対象から消える
  let shuttingDown = false
  // 起動時の backfill が 1 回走り終わったかどうか。走るまでの state 書き込みでは、state.json から復元した
  // cursor より古い unfinished を prune しない（prune すると backfill が読む前に取り直し対象が消える）
  let startupBackfillSettled = false
  // 復元時点で cursor より古い側の unfinished（invariant 壊れの candidate）。prune の例外はこの id だけ
  const restoredUnfinishedBehindCursor = new Set<string>()

  if (unfinishedMessageIds.size > 0) {
    const restoredCursor = state.lastSeenMessageId ?? null
    // cursor の invariant は「この id より古い message を全て処理し終えた」位置。state file 上の unfinished が
    // cursor より古い側にある = invariant が壊れた state（cursor gate の無い build が書いた・state file を
    // 手で編集した）。backfill は cursor を戻さずにこれらの id だけ history から取り直す
    const behindCursor = sortedMessageIds(unfinishedMessageIds).filter((messageId) => {
      return restoredCursor !== null && !isDiscordMessageIdNewer(messageId, restoredCursor)
    })

    for (const messageId of behindCursor) {
      restoredUnfinishedBehindCursor.add(messageId)
    }

    // state.json から復元した unfinished。取り直し（backfill）が走る前に「何が置き去りだったか」を出しておく
    logSafe({
      type: 'discord_unfinished_restored',
      count: unfinishedMessageIds.size,
      messageIds: sortedMessageIds(unfinishedMessageIds).slice(0, 20),
      cursor: restoredCursor,
      behindCursor: behindCursor.length,
    })
  }

  // id 集合は古い順に並べて state file へ書く（log・diff で読みやすい形に固定する）
  function sortedMessageIds(ids: Iterable<string>) {
    return [...ids].sort((a, b) => {
      return isDiscordMessageIdNewer(a, b) ? 1 : -1
    })
  }

  // cursor が越えた ids を state file から落とす（集合が無制限に膨れないため）。answered は cursor が届いた
  // 側では backfill が見ないので持っても意味が無く、unfinished も cursor が越えた時点で取り直し対象から外れる
  // （持ち続けると cursor が恒久的に止まる）。unfinished を cursor より新しい間（まだ取り直し対象）は残す。
  // 復元した unfinished は、起動時の backfill が読む前に消さない（startupBackfillSettled まで keep）。
  // Set は中身だけ塗り替える（backfill と共有している object への参照は保つ）
  function pruneIdsBehindCursor(cursor: string | null) {
    if (cursor === null) {
      return
    }

    for (const id of idsBehindCursor(answeredMessageIds, cursor)) {
      answeredMessageIds.delete(id)
    }

    const droppedUnfinished: string[] = []

    for (const id of idsBehindCursor(unfinishedMessageIds, cursor)) {
      if (!startupBackfillSettled && restoredUnfinishedBehindCursor.has(id)) {
        continue
      }

      unfinishedMessageIds.delete(id)
      droppedUnfinished.push(id)
    }

    // cursor が unfinished を越えた（＝その id はこの先 backfill で取り直さない）ことを黙らせない。
    // 越えた理由が Discord 側で unknown な case（fetch 範囲（新しい 100 件）の外にある unfinished などを over_limit で落とし、
    // その間に cursor が進んだ）はここに載る
    if (droppedUnfinished.length > 0) {
      logSafe({
        type: 'discord_unfinished_pruned',
        count: droppedUnfinished.length,
        messageIds: droppedUnfinished.slice(0, 20),
        cursor,
      })
    }
  }

  function saveDiscordState(next: DiscordBotState) {
    // unfinished / answered の集合は memory の Set が正。書く直前に state へ写し込む。state file の書き込み
    // 失敗（discord_state_write_failed）はここで log して握り潰す：state が書けないのは observability の
    // 問題で、受理済みの会話を止める理由にはしない（noteLiveMessageReceived も同じ経由なので会話は続く）
    pruneIdsBehindCursor(next.lastSeenMessageId ?? null)
    state = {
      ...next,
      unfinishedMessageIds: sortedMessageIds(unfinishedMessageIds),
      answeredMessageIds: sortedMessageIds(answeredMessageIds),
    }

    try {
      writeDiscordBotState(dataDir, state)
    } catch (error) {
      logError('discord_state_write_failed', error)
    }
  }

  // 受理した ids を cursor より古い unfinished に加える。処理中である事実だけ liveProcessingMessageIds に書き、
  // turn が終わるまで liveMessageIds には書かない（受理の事実だけで live gate を作ると unfinished の id が
  // backfill の取り直しから外れる）。unfinished は受理の時点で state file へ書く（ここで書いておかないと
  // SIGKILL で失われる）
  function noteLiveMessageReceived(messageId: string) {
    liveProcessingMessageIds.add(messageId)
    unfinishedMessageIds.add(messageId)
    saveDiscordState(state)
  }

  // cursor は「この id より古い message を全て処理し終えた」位置なので、turn 中の message より先へ
  // 進めると、そこで kill された message は restart 後の backfill で取り直せません。
  // 古い unfinished が無くなってから cursor を進める（state.json から復元した unfinished も含む）
  function canAdvanceCursor(messageId: string) {
    return canAdvanceCursorPast(unfinishedMessageIds, messageId)
  }

  // sentAnswer: chat.ts が案内ではなく実応答の chunk を 1 つ以上送れたかどうか（onMessage で reply を
  // 追跡して数える）。案内だけ送った turn を answered にすると、Discord 側への送信結果に処理の完了を
  // 依存させることになる
  function commitLiveMessageSeen(messageId: string, sentAnswer: boolean) {
    liveProcessingMessageIds.delete(messageId)

    if (shuttingDown) {
      // 置き去りにした turn の id は unfinished に残す（discord_shutdown_unfinished に載る）。drain が送る
      // 「今回は処理できませんでした。」（self notice）は送信結果であって処理の完了ではない。2026-11-24 の
      // incident ではこの案内自体が Discord に届いていない（1574692480371392604 で
      // discord_chat_reply_failed）ので、notice の送信記録を取り直しの skip 条件にしない
      return
    }

    // turn を完走した id は liveMessageIds（この process が処理を終えた id）に書く。Discord が同じ message を
    // 2 度配信したとき（echo・再接続後の再 delivery）、live 側が同じ id に 2 度 turn を走らせないための記録。
    // 受理しただけの id はここに書かない（noteLiveMessageReceived は liveProcessingMessageIds だけ）
    liveMessageIds.add(messageId)

    // turn を完走した id は unfinished から出す（unfinished に残すと cursor がその id で止まり続ける）。
    // answered に記録するのは実応答を送れた場合だけ。会話 session が無くて CHAT_UNAVAILABLE_REPLY だけを
    // 送った turn などは answered にならないので、cursor がその id に届いていなければ次の restart の
    // backfill が取り直す
    unfinishedMessageIds.delete(messageId)

    if (sentAnswer) {
      answeredMessageIds.add(messageId)
    }

    if (!canAdvanceCursor(messageId)) {
      // unfinished が残る間は cursor を進めない。取り直した側が cursor を動かすまで待つ。
      // 応答を送った事実だけは state に残す（restart 後の二度応答を防ぐ）
      saveDiscordState(state)

      return
    }

    saveDiscordState(noteDiscordSeenMessageId(state, messageId))
  }

  // 会話にしない message（admission 失敗など）。turn を走らせないので受理した時点で完了扱い
  function noteLiveMessageDiscarded(messageId: string) {
    liveMessageIds.add(messageId)
    unfinishedMessageIds.delete(messageId)
    answeredMessageIds.delete(messageId)

    if (!canAdvanceCursor(messageId)) {
      // 2026-11-24 の incident の入口。unfinished が memory 上に無い状態で self message（bot の応答の echo）
      // がここを通り、cursor が unfinished より後ろへ進んだ。unfinished が残っている間は
      // 破棄した message でも cursor を進めない
      saveDiscordState(state)

      return
    }

    saveDiscordState(noteDiscordSeenMessageId(state, messageId))
  }
  const handlers: DiscordGatewayHandlers = {
    onReady: (botUserId) => {
      chatHandlerRef.current = createDiscordChatHandler({
        config,
        botUserId: botUserId ?? '',
        session: chatSession,
        redactor,
        log: logSafe,
        // Discord の message から会話 session と HOOT を操作する control command（Issue #33）
        dataDir,
        nowMs,
      })
      state.unit = unit
      state.readyId = readyId
      state.lastReadyAt = new Date(nowMs()).toISOString()

      // install の ready 判定は state file を読む（unfinished / answered の集合もここで state の形へ揃える）
      saveDiscordState(state)
      logSafe({ type: 'discord_ready', unit })

      // channel からの操作は slash command に統一する（Issue #33）。guild へ bulk overwrite で登録し、
      // 失敗しても会話機能は止めない（command が出ない状態は log で見られる）
      void (async () => {
        const problems = validateArayaSlashCommands(ARAYA_SLASH_COMMANDS)

        if (problems.length > 0) {
          logSafe({ type: 'discord_commands_invalid', problems: problems.slice(0, 10) })

          return
        }

        try {
          const registered = await gateway.registerCommands(ARAYA_SLASH_COMMANDS)
          logSafe({ type: 'discord_commands_registered', commands: registered })
        } catch (error) {
          logError('discord_commands_register_failed', error)
        }
      })()

      // #36: gateway が閉じている間に投稿された message は Discord が再配信しないので、cursor より新しい
      // history だけを古い順に会話 queue へ流し込む。ready 後の 1 回だけ。失敗しても会話機能は止めない
      void (async () => {
        const chatHandler = chatHandlerRef.current

        if (chatHandler === null) {
          logSafe({ type: 'discord_backfill_skipped', reason: 'chat_handler_unavailable' })

          return
        }

        const outcome = await runDiscordRestartBackfill({
          config,
          botUserId: botUserId ?? '',
          gateway,
          chatHandler,
          log: logSafe,
          nowMs,
          state,
          saveState: (next) => {
            // backfill は ready 時の state を参照しているので、live 側で cursor が先に進んでいることがある。
            // 今の state にマージしてから保存し、cursor を後ろへ戻さない。
            // merge にも live と同じ unfinished gate を通す。backfill 側の cursor が unfinished を越えていれば
            // ここで止める（越えた unfinished は次の state 書き込みの prune で state file から消えるため）。
            // 現在の配線では unfinished の Set を backfill と共有しているので live 側の per-message gate が
            // 先に効く。ここは defense の gate（backfill に別の集合を渡す変更を入れたときに最初の gate になる）
            const nextCursor = next.lastSeenMessageId ?? null
            const advanced = nextCursor === null ? state : noteDiscordSeenMessageId(state, nextCursor)

            if (advanced === state) {
              // cursor は進まない（backfill 側の cursor が今より後ろに無い）。id 集合だけ書き直す
              saveDiscordState(state)

              return
            }

            if (!canAdvanceCursorPast(unfinishedMessageIds, advanced.lastSeenMessageId ?? '')) {
              logSafe({
                type: 'discord_backfill_cursor_merge_blocked',
                cursor: state.lastSeenMessageId ?? null,
                requestedCursor: advanced.lastSeenMessageId ?? null,
                unfinishedMessageIds: sortedMessageIds(unfinishedMessageIds).slice(0, 20),
              })
              saveDiscordState(state)

              return
            }

            saveDiscordState(advanced)
          },
          isHandled: (messageId) => {
            // live gate は「受理した事実」ではない。飛ばすのは (1) この process が処理中
            // （liveProcessingMessageIds）、(2) この process が処理を終えた（liveMessageIds: turn 完走・破棄 /
            // backfill が処理を始めた）、(3) 前回の process で実応答を送った（answeredMessageIds）id だけ。
            // unfinished の id は unfinished 側を優先する（案内だけ送った id が answered に混ざった state file
            // でも取り直される）。Discord が同じ author + 同じ nonce を 1 通にまとめるのは過去数分のあいだだけ
            // なので、(3) は state.json の記録で止めている
            return (
              liveMessageIds.has(messageId) ||
              liveProcessingMessageIds.has(messageId) ||
              (answeredMessageIds.has(messageId) && !unfinishedMessageIds.has(messageId))
            )
          },
          markHandled: (messageId) => {
            liveMessageIds.add(messageId)
          },
          markAnswered: (messageId) => {
            answeredMessageIds.add(messageId)
          },
          // state.json から復元した unfinished。backfill はこの id を age 上限を無視して取り直し、
          // 取り直す間は cursor をその id より後ろへ進めない
          unfinishedMessageIds,
          // live で受理して turn が実行中の ids。backfill はこれを reason:"live_processing" で飛ばす
          // （live 側が終わってから同じ id を取り直す）
          liveProcessingMessageIds,
        })
        // history を読めた起動なら、以降の state 書き込みで cursor が越えた unfinished を prune してよい
        // （取り直せなかった unfinished を持ち続けると集合と cursor が膨れっ放しになる。落とした事は
        // discord_unfinished_pruned に出す）。history を読めなかった起動では prune しない：次の restart で
        // 取り直せたはずの id を黙って落とす方を選ぶ。fetch 失敗の繰り返しの間は log
        // （discord_unfinished_restored）に載り続ける
        startupBackfillSettled = outcome.historyFetched
        saveDiscordState(state)
      })().catch((error: unknown) => {
        logError('discord_backfill_failed', error)
      })
    },
    onMessage: async (message, reply) => {
      // #36: cursor は turn が終わった後に進める。drain budget で置き去りにされた message は cursor が
      // 動いていないので、restart 後の backfill が同じ id から取り直します（at-least-once）
      // 排他: backfill が処理を始めた／終えた id を live で再び走らせない（Discord が同じ message を 2 度
      // 配信したときの二重応答もここで止める）
      if (liveMessageIds.has(message.messageId) || liveProcessingMessageIds.has(message.messageId)) {
        logSafe({
          type: 'discord_chat_duplicate_skipped',
          messageId: message.messageId,
          reason: liveMessageIds.has(message.messageId) ? 'already_processed' : 'already_processing',
        })

        return
      }

      // onReady（chatHandler 生成）より前に message を受け取った形。turn を走らせていないのに処理完了扱いに
      // すると、unfinished から出て answered にも入らないまま cursor だけが進む（discord_chat_received
      // も discord_chat_ignored にも載らない）。受理したが未処理なので unfinished に書き、cursor は進めない
      // （liveProcessingMessageIds には書かない：実行中の id ではないので backfill の取り直しを止める）
      const chatHandler = chatHandlerRef.current

      if (chatHandler === null) {
        logSafe({
          type: 'discord_chat_ignored',
          messageId: message.messageId,
          reason: 'handler_not_ready',
        })
        unfinishedMessageIds.add(message.messageId)
        saveDiscordState(state)

        return
      }

      noteLiveMessageReceived(message.messageId)
      // chat.ts が送る reply を数える。self notice（CHAT_SHUTDOWN_UNPROCESSED_REPLY）と会話機能不可の案内
      // （CHAT_UNAVAILABLE_REPLY）は Discord 側への送信結果であって処理の完了ではないので、これだけを
      // 送った turn を answered に記録しない。会話を実行して失敗した旨の案内（CHAT_ERROR_REPLY）は turn が
      // 走った結果なので answered に数える（失敗した message を restart ごとに試し直さない）
      let answerChunks = 0

      try {
        await chatHandler.handle(message, async (content, nonce) => {
          if (content !== CHAT_SHUTDOWN_UNPROCESSED_REPLY && content !== CHAT_UNAVAILABLE_REPLY) {
            answerChunks += 1
          }

          await reply(content, nonce)
        })
      } finally {
        commitLiveMessageSeen(message.messageId, answerChunks > 0)
      }
    },
    // slash command（/araya ... / /hoot ...）。queue を通さないので会話の実行中でも効く
    onInteraction: async (request, reply) => {
      const chatHandler = chatHandlerRef.current

      if (chatHandler === null) {
        await reply(CHAT_UNAVAILABLE_REPLY).catch(() => undefined)

        return
      }

      await chatHandler.handleCommand(request, reply)
    },
    onError: (message) => {
      logSafe({ type: 'discord_error', message: redactor.redact(message).slice(0, 500) })
    },
    // 取りこぼし診断: messageId・IDs・拒否理由だけを discord.log に残す（本文は渡さない）
    onIgnored: (metadata, failures) => {
      noteLiveMessageDiscarded(metadata.messageId)
      logSafe({
        type: 'discord_message_ignored',
        messageId: metadata.messageId,
        guildId: metadata.guildId,
        channelId: metadata.channelId,
        userId: metadata.userId,
        failures,
      })
    },
  }

  let gateway: DiscordGateway

  try {
    gateway = await (deps.createGateway ?? createDiscordGateway)(config, handlers)
  } catch (error) {
    logError('discord_gateway_failed', error)
    settleGatewayReady({
      ok: false,
      error: error instanceof Error ? error : new Error('discord gateway creation failed'),
    })
    await closeChatSession()

    return 1
  }

  settleGatewayReady({ ok: true, gateway })

  // HOOT（Human Out of the Loop）の wakeup loop。state が無効なら model も gh も呼ばない。
  // 判断 run は tool を持たない専用 conversation なので、ここで file も child も変わらない
  let hoot: ReturnType<typeof createHootLoop> | undefined
  let hootTask: Promise<void> | undefined

  try {
    const hootState = await readHootState(dataDir)
    logSafe({
      type: 'hoot_state',
      enabled: hootState.settings.enabled,
      mode: hootState.settings.mode,
      activeGoals: hootState.goals.filter((goal) => {
        return goal.status === 'active'
      }).length,
      lastRunAt: hootState.loop.lastRunAt,
    })

    if (chatSession === null) {
      logSafe({ type: 'hoot_disabled', reason: 'no_agent_session' })
    } else {
      const session = chatSession
      hoot = createHootLoop({
        dataDir,
        devRoot: path.resolve(deps.env.ARAYA_DEV_ROOT || path.join(deps.env.HOME || os.homedir(), 'dev')),
        decide: async (input) => {
          if (session.hootDecide === undefined) {
            throw new Error('hoot_decide_unavailable: agent session に hootDecide がありません')
          }

          return await session.hootDecide(input)
        },
        deliver: async (text, nonce) => {
          const settlement = await gatewayReady

          if (!settlement.ok) {
            throw settlement.error
          }

          await settlement.gateway.sendText(text, nonce)
        },
        // Issue #31（1A）: 承認済みの dispatch を main Discord 会話へ submit する。HOOT 判断 run 側には
        // tool が無く、作業を実行するのはこの main 会話だけ。人間の message と同じ queue で直列化する
        dispatchInject: async (input) => {
          const handler = chatHandlerRef.current

          if (handler === null) {
            throw new Error('hoot_inject_unavailable: chat handler がまだ ready ではありません')
          }

          const settlement = await gatewayReady

          if (!settlement.ok) {
            throw settlement.error
          }

          const answer = await handler.inject(
            { content: input.content, requestId: input.requestId, notice: input.notice },
            async (text, nonce) => {
              await settlement.gateway.sendText(text, nonce)
            }
          )

          logSafe({
            type: 'hoot_inject_delivered',
            injectKey: input.injectKey,
            proposalKey: input.proposalKey,
            answerChars: answer.length,
          })
        },
        redactor,
        // HOOT の log entry は gh・model 由来の text を含む。書く前に秘密を置き換える
        log: (entry) => {
          const redacted = redactor.redactDeep(entry)

          logSafe(
            typeof redacted === 'object' && redacted !== null
              ? (redacted as Record<string, unknown>)
              : { message: String(redacted) }
          )
        },
        nowMs,
        env: deps.env,
        pollMs: deps.hootPollMs,
        runCommand: deps.hootRunCommand,
        observationTimeoutMs: deps.hootObservationTimeoutMs,
      })
      hootTask = hoot.run().catch((error: unknown) => {
        logError('hoot_loop_failed', error)
      })
    }
  } catch (error) {
    logError('hoot_state_failed', error)
  }

  // CLI からの control request（`araya status・stop・reset`）。slash command と同じ chat handler の runControl を
  // 呼ぶので operation は Discord 側と 1:1。local file を書ける OS user が許可の境界（Discord の allowlist は通さない）
  let cliControl: ReturnType<typeof createCliControlLoop> | undefined

  try {
    cliControl = createCliControlLoop({
      dataDir,
      nowMs,
      log: logSafe,
      pollMs: deps.cliControlPollMs,
      redact: (text) => {
        return redactor.redact(text)
      },
      run: async (command, requestId) => {
        const chatHandler = chatHandlerRef.current

        if (chatHandler === null) {
          if (command === 'status') {
            // 読み取りの status だけは startup 中でも答える（session が無いので会話の状態は出せない）
            return '会話 session はまだ ready ではありません（bot の startup 中）。unit の稼働は araya discord status で確かめてください'
          }

          throw new Error('chat_session_unavailable: 会話 session がまだ ready ではありません')
        }

        return await chatHandler.runControl({
          interactionId: requestId,
          commandName: SESSION_COMMAND_NAME,
          userId: CLI_CONTROL_USER,
          guildId: config.guildId,
          channelId: config.channelId,
          subcommandGroup: null,
          subcommand: command,
          options: {},
        })
      },
    })
    cliControl.start()
    logSafe({ type: 'discord_cli_control_started', pollMs: deps.cliControlPollMs ?? CLI_CONTROL_POLL_MS })
  } catch (error) {
    logError('discord_cli_control_failed', error)
  }

  try {
    try {
      await gateway.connect()
    } catch (error) {
      logError('discord_connect_failed', error)

      return 1
    }

    logSafe({ type: 'discord_started', unit, pollMs })

    // #36: 起動完了をユーザーへ可視化する。投稿失敗は稼働を止めない（postDiscordRestartNotice は throw しない）
    void postDiscordRestartNotice({
      botToken: config.botToken,
      channelId: config.channelId,
      text: discordRestartStartedText(previousLastReadyAt),
      fetchImpl: deps.fetch,
    }).then((ok) => {
      logSafe({ type: 'discord_restart_notice', ok })
    })

    // report 配送は agent host の durable task 側で進む。bot loop は stop まで待つ。
    // 待っているだけの区間で chat の停滞検査だけを動かす（実行中の turn が CHAT_STALL_WARN_MS を
    // 超えたら discord_chat_stalled に 1 回残る。status を開いていない停滞もここで可視化する）
    while (!deps.stopSignal.aborted) {
      chatHandlerRef.current?.tick()
      await sleep(pollMs, deps.stopSignal)
    }
  } finally {
    // CLI の control を最初に止める（shutdown の途中で新しい stop / reset を受け取らない）
    const shutdownStartedAtMs = nowMs()
    shuttingDown = true
    const waits: DiscordShutdownWaits = { ...SHUTDOWN_WAIT_MS, ...deps.shutdownWaits }

    cliControl?.stop()

    // gateway を閉じる前に HOOT loop を止める（送信先の gateway が無くなった後の deliver を避ける）
    hoot?.stop()

    if (hootTask !== undefined) {
      const waited = await waitWithBudget(hootTask, waits.hootMs)

      if (waited.outcome === 'timeout') {
        logSafe({ type: 'discord_shutdown_timeout', step: 'hoot_run', budgetMs: waits.hootMs })
      }
    }

    const chatHandler = chatHandlerRef.current
    chatHandler?.stopAccepting()
    const pending = chatHandler?.pendingCount() ?? { queued: 0, processing: 0, elapsedMs: null }
    // drain がどこまで進んだかの実測できる証跡（#36: graceful drain が動いているかを log で確かめる）
    logSafe({
      type: 'discord_stopping',
      queued: pending.queued,
      processing: pending.processing,
      elapsedMs: Math.max(0, nowMs() - shutdownStartedAtMs),
    })

    if (chatHandler !== null && chatHandler !== undefined) {
      const waited = await waitWithBudget(chatHandler.drain(), waits.drainMs)

      if (waited.outcome === 'timeout') {
        logSafe({
          type: 'discord_shutdown_timeout',
          step: 'chat_drain',
          budgetMs: waits.drainMs,
          queued: pending.queued,
          processing: pending.processing,
        })
      } else if (waited.outcome === 'failed') {
        logError('discord_drain_failed', waited.error)
      }

      // #36: 実行中に置き去りにした ids。cursor が動いていないので restart 後の backfill が同じ id から
      // 取り直します。黙って捨てていないことを log に残し、state.json にも残す（memory だけの状態で
      // process が消えると restart 後に取り直せない。2026-11-24 の incident）
      if (unfinishedMessageIds.size > 0) {
        const ids = sortedMessageIds(unfinishedMessageIds)

        saveDiscordState(state)
        logSafe({
          type: 'discord_shutdown_unfinished',
          count: ids.length,
          messageIds: ids.slice(0, 20),
          cursor: state.lastSeenMessageId ?? null,
        })
      }
    }

    const gatewayWaited = await waitWithBudget(gateway.close(), waits.gatewayMs)

    if (gatewayWaited.outcome === 'timeout') {
      logSafe({ type: 'discord_shutdown_timeout', step: 'gateway_close', budgetMs: waits.gatewayMs })
    } else if (gatewayWaited.outcome === 'failed') {
      logError('discord_gateway_close_failed', gatewayWaited.error)
    }

    const sessionWaited = await waitWithBudget(closeChatSession(), waits.sessionMs)

    if (sessionWaited.outcome === 'timeout') {
      logSafe({ type: 'discord_shutdown_timeout', step: 'agent_session_close', budgetMs: waits.sessionMs })
    } else if (sessionWaited.outcome === 'failed') {
      logError('discord_session_close_failed', sessionWaited.error)
    }

    logSafe({
      type: 'discord_stopped',
      elapsedMs: Math.max(0, nowMs() - shutdownStartedAtMs),
    })
  }

  return 0
}
