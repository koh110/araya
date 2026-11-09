import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Discord bot の状態（<dataDir>/discord/state.json）。通知の位置と retry の待ち状態だけを持つ。
// Task の本体は台帳（tasks.sqlite）にあり、ここには書かない。書くのは bot process だけ

export const DISCORD_STATE_VERSION = 1

export type DiscordNotificationBackoff = {
  // 送信に失敗した event の seq。次は この nextAttemptAtMs（壁時計 ms）以降に同じ event を送り直す
  eventSeq: number
  attempts: number
  nextAttemptAtMs: number
}

export type DiscordBotState = {
  version: number
  // 通知を送ったか、意図的に省略した最新の task_events.seq。初回は null（初回起動時、その時点の最新から始める）
  cursor: number | null
  backoff: DiscordNotificationBackoff | null
  // 最後に ready になったときに確かめた unit 名
  unit: string | null
  // ready になった process の識別子。旧 state には無いので読み込み時は optional
  readyId?: string | null
  lastReadyAt: string | null
}

export function discordStateFilePath(dataDir: string) {
  return path.join(dataDir, 'discord', 'state.json')
}

function isStateShape(value: unknown): value is DiscordBotState {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const state: Record<string, unknown> = {}

  for (const [key, property] of Object.entries(value)) {
    state[key] = property
  }

  if (state.version !== DISCORD_STATE_VERSION) {
    return false
  }

  if (
    !(
      state.cursor === null ||
      (typeof state.cursor === 'number' && Number.isSafeInteger(state.cursor) && state.cursor >= 0)
    )
  ) {
    return false
  }

  if (!(state.unit === null || typeof state.unit === 'string')) {
    return false
  }

  if (!(state.lastReadyAt === null || typeof state.lastReadyAt === 'string')) {
    return false
  }

  if (
    !(state.readyId === undefined || state.readyId === null || typeof state.readyId === 'string')
  ) {
    return false
  }

  if (state.backoff === null) {
    return true
  }

  if (typeof state.backoff !== 'object' || state.backoff === null) {
    return false
  }

  const backoff: Record<string, unknown> = {}

  for (const [key, property] of Object.entries(state.backoff)) {
    backoff[key] = property
  }

  return (
    typeof backoff.eventSeq === 'number' &&
    Number.isSafeInteger(backoff.eventSeq) &&
    backoff.eventSeq >= 1 &&
    typeof backoff.attempts === 'number' &&
    Number.isSafeInteger(backoff.attempts) &&
    backoff.attempts >= 1 &&
    typeof backoff.nextAttemptAtMs === 'number' &&
    Number.isSafeInteger(backoff.nextAttemptAtMs)
  )
}

// state.json が無ければ null。形が壊れているときは誤り（bot は restart policy で再起動し、人間が直す）
export function readDiscordBotState(dataDir: string) {
  const filePath = discordStateFilePath(dataDir)
  let text: string

  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }

  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    throw Object.assign(
      new Error(`discord_state_invalid: ${filePath} は有効な JSON ではありません`),
      { code: 'discord_state_invalid' },
    )
  }

  if (!isStateShape(value)) {
    throw Object.assign(
      new Error(`discord_state_invalid: ${filePath} が bot の state の形ではありません`),
      { code: 'discord_state_invalid' },
    )
  }

  return value
}

export function newState(initialUnit: string | null) {
  const state: DiscordBotState = {
    version: DISCORD_STATE_VERSION,
    cursor: null,
    backoff: null,
    unit: initialUnit,
    readyId: null,
    lastReadyAt: null,
  }

  return state
}

// 同じ directory の一時 file（mode 0600）に書いてから rename する。directory が無ければ mode 0700 で作る
export function writeDiscordBotState(dataDir: string, state: DiscordBotState) {
  const directory = path.dirname(discordStateFilePath(dataDir))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(directory, `.state.${randomBytes(6).toString('hex')}.tmp`)

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    fs.renameSync(temporaryPath, discordStateFilePath(dataDir))
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {
      // 一時 file が無いなどの後始末の失敗は元の誤りに隠す
    }

    throw error
  }
}
