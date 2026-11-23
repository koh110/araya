import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Discord bot の状態（<dataDir>/discord/state.json）。ready 判定と、再起動後の履歴 backfill が
// 続ける位置（lastSeenMessageId）を持つ。通知の配送 retry は agent host の durable task 側が持つ。
// 書くのは bot process だけ（process lock で 1 process が保証されている）

export const DISCORD_STATE_VERSION = 2
// backfill cursor を持つ前の state。read 時に migration して lastSeenMessageId を null で埋める
export const DISCORD_STATE_VERSION_BEFORE_CURSOR = 1

export type DiscordBotState = {
  version: number
  // 最後に ready になったときに確かめた unit 名
  unit: string | null
  // ready になった process の識別子。旧 state には無いので読み込み時は optional
  readyId?: string | null
  lastReadyAt: string | null
  // gateway から見た (受理・破棄どちらでも) message id の最大値。Discord の snowflake は単調増加なので
  // id だけで「どこまで見たか」を比較できる。旧 state には無いので読み込み時は optional
  lastSeenMessageId?: string | null
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

  // 未来の version は読まない（downgrade 時の state 破棄を避ける）
  if (state.version !== DISCORD_STATE_VERSION && state.version !== DISCORD_STATE_VERSION_BEFORE_CURSOR) {
    return false
  }

  if (!(state.unit === null || typeof state.unit === 'string')) {
    return false
  }

  if (
    !(
      state.lastSeenMessageId === undefined ||
      state.lastSeenMessageId === null ||
      (typeof state.lastSeenMessageId === 'string' && isDiscordMessageId(state.lastSeenMessageId))
    )
  ) {
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

  return true
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

  // v1 -> v2: cursor を null で埋める。read だけでは file を書き換えない（次の ready 書き込みで v2 になる）
  if (value.version === DISCORD_STATE_VERSION_BEFORE_CURSOR) {
    return { ...value, version: DISCORD_STATE_VERSION, lastSeenMessageId: null }
  }

  return value
}

export function newState() {
  const state: DiscordBotState = {
    version: DISCORD_STATE_VERSION,
    unit: null,
    readyId: null,
    lastReadyAt: null,
    lastSeenMessageId: null,
  }

  return state
}

// Discord snowflake: 先頭 42 bit が millisecond timestamp。id 単調増加なので比較に使える
export function isDiscordMessageId(value: string) {
  return /^[0-9]{1,20}$/u.test(value)
}

// a が b より新しい id かどうか。数字として比較できないものは新しくない扱いにする
export function isDiscordMessageIdNewer(a: string | null | undefined, b: string | null | undefined) {
  if (a === null || a === undefined || !isDiscordMessageId(a)) {
    return false
  }

  if (b === null || b === undefined || !isDiscordMessageId(b)) {
    return true
  }

  try {
    return BigInt(a) > BigInt(b)
  } catch {
    return false
  }
}

// gateway から見た message id を記録する。現在より古い id は無視して state を返す（同じ object なら changes なし）
export function noteDiscordSeenMessageId(state: DiscordBotState, messageId: string): DiscordBotState {
  if (!isDiscordMessageIdNewer(messageId, state.lastSeenMessageId ?? null)) {
    return state
  }

  return { ...state, lastSeenMessageId: messageId }
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
