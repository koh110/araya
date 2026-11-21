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
  createDiscordChatHandler,
  splitDiscordChatReply,
  type DiscordChatHandler,
} from './chat.ts'
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

type ProperLockfile = {
  lock(
    resourcePath: string,
    options: { lockfilePath: string; retries: number; stale: number; update: number },
  ): Promise<() => Promise<void>>
}

const properLockfile: ProperLockfile = createRequire(import.meta.url)('proper-lockfile')
const DISCORD_PROCESS_LOCK_STALE_MS = 30_000
const DISCORD_PROCESS_LOCK_UPDATE_MS = 10_000
const DEFAULT_POLL_MS = 5_000
// 終了時に HOOT 判断 run の完了を待つ上限。越えたら close を進め、durable state 側で resume する
const HOOT_STOP_WAIT_MS = 20_000

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
  createGateway?: (
    config: DiscordConfig,
    handlers: DiscordGatewayHandlers,
  ) => Promise<DiscordGateway>
  createChatSession?: typeof createDefaultArayaAgentSession
  log?: (entry: Record<string, unknown>) => void
  // HOOT loop の poll 間隔（test で短くする）。既定 60000
  hootPollMs?: number
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
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
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

// systemd と foreground の同じ dataDir 起動を排他し、異常終了後は stale lock を回収する。
async function acquireDiscordProcessLock(dataDir: string) {
  const canonicalDataDir = await fs.promises.realpath(dataDir)

  return properLockfile.lock(canonicalDataDir, {
    lockfilePath: path.join(canonicalDataDir, '.discord-bot.lock'),
    retries: 0,
    stale: DISCORD_PROCESS_LOCK_STALE_MS,
    update: DISCORD_PROCESS_LOCK_UPDATE_MS,
  })
}

export async function runDiscordBot(deps: DiscordBotDependencies) {
  try {
    await fs.promises.mkdir(path.join(deps.dataDir, 'logs'), { recursive: true, mode: 0o700 })
  } catch {
    // runDiscordBotUnlocked が設定の誤りを処理し、必要なら失敗を記録する
  }

  const log = deps.log ?? fileLogger(path.join(deps.dataDir, 'logs', 'discord.log'))
  const redactor = createRedactor(collectSecretValues(deps.env))
  let releaseLock: () => Promise<void>

  try {
    releaseLock = await acquireDiscordProcessLock(deps.dataDir)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
      log({ type: 'discord_already_running' })

      return 1
    }

    log({
      type: 'discord_instance_lock_failed',
      message: redactor.redact(errorMessage(error)).slice(0, 500),
    })

    return 1
  }

  try {
    return await runDiscordBotUnlocked(deps)
  } finally {
    await releaseLock()
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
      })
      state.unit = unit
      state.readyId = readyId
      state.lastReadyAt = new Date(nowMs()).toISOString()

      // install の ready 判定は state file を読む
      writeDiscordBotState(dataDir, state)
      logSafe({ type: 'discord_ready', unit })
    },
    onMessage: async (message, reply) => {
      await chatHandlerRef.current?.handle(message, reply)
    },
    onError: (message) => {
      logSafe({ type: 'discord_error', message: redactor.redact(message).slice(0, 500) })
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

  try {
    try {
      await gateway.connect()
    } catch (error) {
      logError('discord_connect_failed', error)

      return 1
    }

    logSafe({ type: 'discord_started', unit, pollMs })

    // report 配送は agent host の durable task 側で進む。bot loop は stop まで待つ
    while (!deps.stopSignal.aborted) {
      await sleep(pollMs, deps.stopSignal)
    }
  } finally {
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
