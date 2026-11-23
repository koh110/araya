// Discord bot の常駐 loop。unit 稼働の確かめ、agent session の open、gateway 接続を組み立てる。
// 設定が無ければ有効化されない（discord_disabled を log して終了 code 1。unit file を入れるのは人間）
// log は <dataDir>/logs/discord.log（JSON lines）。external 由来の文字列は秘密を置き換えてから書く

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { collectSecretValues, createRedactor } from '../infrastructure/redaction.ts'
import { dataDirHash, discordUnitName } from '../infrastructure/systemd.ts'
import { loadDiscordConfig, type DiscordConfig } from './config.ts'
import {
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
import { newState, readDiscordBotState, writeDiscordBotState } from './state.ts'
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
// 終了時に HOOT 判断 run の完了を待つ上限。越えたら close を進め、durable state 側で resume する
const HOOT_STOP_WAIT_MS = 20_000
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

// systemd unit process であることを INVOCATION_ID と cgroup で確かめる
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
// proper-lockfile の stale（30 s）だけを待つと SIGKILL 後に 20〜40 s 起動できない窓ができる。
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

  const log = deps.log ?? fileLogger(path.join(deps.dataDir, 'logs', 'discord.log'))
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

  const log = deps.log ?? fileLogger(path.join(dataDir, 'logs', 'discord.log'))
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

  let state

  try {
    state = readDiscordBotState(dataDir) ?? newState()
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
    })
    logSafe({ type: 'discord_chat_ready' })
  } catch (error) {
    logError('discord_chat_unavailable', error)
  }

  const chatHandlerRef: { current: DiscordChatHandler | null } = { current: null }
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

      // install の ready 判定は state file を読む
      writeDiscordBotState(dataDir, state)
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
    },
    onMessage: async (message, reply) => {
      await chatHandlerRef.current?.handle(message, reply)
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

    // report 配送は agent host の durable task 側で進む。bot loop は stop まで待つ
    while (!deps.stopSignal.aborted) {
      await sleep(pollMs, deps.stopSignal)
    }
  } finally {
    // CLI の control を最初に止める（shutdown の途中で新しい stop / reset を受け取らない）
    cliControl?.stop()

    // gateway を閉じる前に HOOT loop を止める（送信先の gateway が無くなった後の deliver を避ける）
    hoot?.stop()

    if (hootTask !== undefined) {
      await Promise.race([
        hootTask,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer)
            resolve()
          }, HOOT_STOP_WAIT_MS)
          timer.unref?.()
        }),
      ])
    }

    chatHandlerRef.current?.stopAccepting()
    await chatHandlerRef.current?.drain()

    try {
      await gateway.close()
    } catch {
      // close の失敗は終了処理の邪魔をしない
    }

    await closeChatSession()
    logSafe({ type: 'discord_stopped' })
  }

  return 0
}
