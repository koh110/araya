// Discord bot の常駐 loop。unit 稼働の確かめ、台帳の open、gateway 接続、通知 tick を組み立てる。
// 設定が無ければ有効化されない（discord_disabled を log して終了 code 1。unit file を入れるのは人間）
// log は <dataDir>/logs/discord.log（JSON lines）。external 由来の文字列は秘密を置き換えてから書く

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { collectSecretValues, createRedactor } from '../infrastructure/redaction.ts'
import { dataDirHash, discordUnitName, runnerUnitName } from '../infrastructure/systemd.ts'
import { openTaskLedger, type TaskLedger } from '../runner/ledger.ts'
import { loadDiscordConfig, type DiscordConfig } from './config.ts'
import {
  createDiscordGateway,
  type DiscordGateway,
  type DiscordGatewayHandlers,
} from './gateway.ts'
import { handleDiscordCommand } from './interactions.ts'
import { NOTIFICATION_POLL_MS, notificationTick } from './notifier.ts'
import { newState, readDiscordBotState, writeDiscordBotState } from './state.ts'

type ProperLockfile = {
  lock(
    resourcePath: string,
    options: { lockfilePath: string; retries: number; stale: number; update: number },
  ): Promise<() => Promise<void>>
}

const properLockfile = createRequire(import.meta.url)('proper-lockfile') as ProperLockfile
const DISCORD_PROCESS_LOCK_STALE_MS = 30_000
const DISCORD_PROCESS_LOCK_UPDATE_MS = 10_000

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
  log?: (entry: Record<string, unknown>) => void
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

// unit process であることを確かめる（runner と同じ INVOCATION_ID・cgroup の使い方）
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
    // runDiscordBotUnlocked が設定・台帳の誤りを処理し、必要なら失敗を記録する
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
  const pollMs = deps.pollMs ?? NOTIFICATION_POLL_MS

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
  // discord.env から読んだ bot token も ledger、reply、notification の全経路で伏せる
  const secretValues = [...new Set([...environmentSecretValues, config.botToken])]
  redactor = createRedactor(secretValues)
  const dataHash = dataDirHash(await fs.promises.realpath(dataDir))
  const unit = discordUnitName(dataHash)
  const runnerUnit = runnerUnitName(dataHash)
  const readyId = randomUUID()

  if (deps.verifyUnit !== false) {
    try {
      await verifyDiscordUnit(unit, deps.env)
    } catch (error) {
      logError('discord_unit_unverified', error)

      return 1
    }
  }

  let ledger: TaskLedger

  try {
    ledger = openTaskLedger(dataDir, { secretValues })
  } catch (error) {
    logError('discord_ledger_failed', error)

    return 1
  }

  let state

  try {
    state = readDiscordBotState(dataDir) ?? newState(null)
  } catch (error) {
    logError('discord_state_failed', error)
    ledger.close()

    return 1
  }

  const handlers: DiscordGatewayHandlers = {
    onReady: () => {
      state.unit = unit
      state.readyId = readyId
      state.lastReadyAt = new Date(nowMs()).toISOString()

      // 初回は、この起動より前の event をさかのぼって送らない
      if (state.cursor === null) {
        state.cursor = ledger.lastEventSeq()
      }

      // install の ready 判定と、再開時の cursor 継続は state file を読む
      writeDiscordBotState(dataDir, state)
      logSafe({ type: 'discord_ready', unit, cursor: state.cursor })
    },
    onInteraction: async (request, reply) => {
      const replies = handleDiscordCommand(request, {
        config,
        unit: runnerUnit,
        ledger,
        nowMs,
        redactor,
      })

      for (const item of replies) {
        await reply(item.content)
      }
    },
    onError: (message) => {
      logSafe({ type: 'discord_error', message: redactor.redact(message).slice(0, 500) })
    },
  }

  const createGateway = deps.createGateway ?? createDiscordGateway
  let gateway: DiscordGateway

  try {
    gateway = await createGateway(config, handlers)
  } catch (error) {
    logError('discord_gateway_failed', error)
    ledger.close()

    return 1
  }

  try {
    try {
      await gateway.connect()
    } catch (error) {
      logError('discord_connect_failed', error)

      return 1
    }

    logSafe({ type: 'discord_started', unit, pollMs })

    while (!deps.stopSignal.aborted) {
      await sleep(pollMs, deps.stopSignal)

      if (deps.stopSignal.aborted) {
        break
      }

      try {
        const result = await notificationTick({
          dataDir,
          ledger,
          state,
          send: gateway.sendText,
          nowMs,
          log: logSafe,
          redactor,
        })

        if (result.sent > 0 || result.skipped > 0) {
          logSafe({
            type: 'discord_notifications',
            sent: result.sent,
            skipped: result.skipped,
            cursor: state.cursor,
          })
        }
      } catch (error) {
        logError('discord_tick_failed', error)
      }
    }
  } finally {
    try {
      await gateway.close()
    } catch {
      // close の失敗は終了処理の邪魔をしない
    }

    ledger.close()
    logSafe({ type: 'discord_stopped' })
  }

  return 0
}
