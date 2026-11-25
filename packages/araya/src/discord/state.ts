import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Discord bot の状態（<dataDir>/discord/state.json）。ready 判定と、再起動後の履歴 backfill が
// 続ける位置（lastSeenMessageId）を持つ。通知の配送 retry は agent host の durable task 側が持つ。
// 書くのは bot process だけ（process lock で 1 process が保証されている）

export const DISCORD_STATE_VERSION = 3
// backfill cursor を持つ前の state。read 時に migration して lastSeenMessageId を null で埋める
export const DISCORD_STATE_VERSION_BEFORE_CURSOR = 1
// unfinished / answered の id 集合を持つ前の state。read 時に migration して空配列で埋める。
// 2026-11-24 の incident で unfinished が memory 上にしか無く、restart で消えた。cursor が unfinished より
// 後ろへ進み、受理済みの message 3 件が恒久的に処理されなかった。cursor と同じ file で保持する
export const DISCORD_STATE_VERSION_BEFORE_UNFINISHED = 2

export type DiscordBotState = {
  version: number
  // 最後に ready になったときに確かめた unit 名
  unit: string | null
  // ready になった process の識別子。旧 state には無いので読み込み時は optional
  readyId?: string | null
  lastReadyAt: string | null
  // 処理を終えたか、明示的に破棄した message id の最大値（「この id より古い message は処理済み」の位置）。
  // 受理しただけで turn が終わっていない id は進めない。Discord の snowflake は単調増加なので id だけで比較できる。
  // 旧 state には無いので読み込み時は optional
  lastSeenMessageId?: string | null
  // 受理したが turn が終わっていない ids。restart 後の backfill が「age 上限を越えていても」取り直す対象。
  // 旧 state には無いので読み込み時は optional（migration で空配列）
  unfinishedMessageIds?: string[]
  // turn を終えて実応答を送れた ids。cursor がより古い unfinished で止まっている間は cursor がその id に
  // 届かないので、restart 後の backfill が同じ message に二度応答するのを防ぐ記録として残す。
  // 設計の択は「nonce だけに依存せず、state file に保存した answered で skip する」方。Discord が同じ
  // author + 同じ nonce を 1 通にまとめるのは過去数分のあいだだけなので、restart をまたいだ再応答は nonce
  // では止められない。at-least-once は壊れない: unfinished かつ answered でない id は age 上限を無視して
  // 必ず取り直し、turn 完了＋応答送信済みは処理完了なので再実行しない。応答送信中に process が消えた case は
  // answered に入らないので unfinished のまま残り、次の restart が取り直して二度走ることがある
  // （at-least-once の副作用として許容する。二重送信を防ぎすぎて取り直しを止めるより軽い）
  answeredMessageIds?: string[]
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
  if (
    state.version !== DISCORD_STATE_VERSION &&
    state.version !== DISCORD_STATE_VERSION_BEFORE_UNFINISHED &&
    state.version !== DISCORD_STATE_VERSION_BEFORE_CURSOR
  ) {
    return false
  }

  // id 集合は有ってよい形（message id の array）だけ。中身の形が壊れているものは読まない
  if (!(isDiscordMessageIdList(state.unfinishedMessageIds) && isDiscordMessageIdList(state.answeredMessageIds))) {
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

// id 集合の形。旧 version の file は key が無いので migration 側で空配列に埋める
function isDiscordMessageIdList(value: unknown) {
  if (value === undefined || value === null) {
    return true
  }

  if (!Array.isArray(value)) {
    return false
  }

  return value.every((entry) => {
    return typeof entry === 'string' && isDiscordMessageId(entry)
  })
}

// state file に在ってよい key。#29（task 機構撤去）で無くなった通知配送 retry 用の `cursor`（number）と
// `backoff` を state.json に残した file が今も動く。誰も読まない key を state の一部として持ち回ると、
// 同じ名前の state field を将来増やしたときに型の違う値（backfill の cursor は lastSeenMessageId の string id
// の事）を state として読む形になるので read で落とす。次の state 書き込みで file から消える
export const DISCORD_STATE_KEYS = new Set<string>([
  'version',
  'unit',
  'readyId',
  'lastReadyAt',
  'lastSeenMessageId',
  'unfinishedMessageIds',
  'answeredMessageIds',
])

// 読み込んだ object から既知 key だけを持つ state を作る（state file の形を DiscordBotState に一致させる）。
// 無い key は migration 側で埋める値で埋める
function toKnownStateKeys(state: DiscordBotState): DiscordBotState {
  return {
    version: DISCORD_STATE_VERSION,
    unit: state.unit,
    readyId: state.readyId ?? null,
    lastReadyAt: state.lastReadyAt ?? null,
    lastSeenMessageId: state.lastSeenMessageId ?? null,
    unfinishedMessageIds: state.unfinishedMessageIds ?? [],
    answeredMessageIds: state.answeredMessageIds ?? [],
  }
}

// state.json が無ければ null。形が壊れているときは誤り（bot は restart policy で再起動し、人間が直す）
// onExtraKeys: 既知 key 以外が file に在ったときの報告（bot 側 log 用）。未知 key を理由に起動は止めない
// （rollback や手当てで書いた key を壊さない。未知 key は state へ引き込まない）
export function readDiscordBotState(dataDir: string, onExtraKeys?: (keys: string[]) => void) {
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

  const extraKeys = Object.keys(value).filter((key) => {
    return !DISCORD_STATE_KEYS.has(key)
  })

  if (extraKeys.length > 0) {
    onExtraKeys?.(extraKeys)
  }

  // v1 / v2 -> v3: 無い key だけを埋める（既存の lastSeenMessageId は保持するので、v2 の cursor が v3 で
  // null に戻る事はない）。read だけでは file を書き換えない（次の state 書き込みで v3 になる）。
  // 既知 key 以外（cursor・backoff など）はここで落とす
  return toKnownStateKeys(value)
}

export function newState() {
  const state: DiscordBotState = {
    version: DISCORD_STATE_VERSION,
    unit: null,
    readyId: null,
    lastReadyAt: null,
    lastSeenMessageId: null,
    unfinishedMessageIds: [],
    answeredMessageIds: [],
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

// cursor を messageId まで進めてよいかの gate。unfinished に messageId より古い id が残っている間は
// 進めてはいけない。cursor が unfinished を越えると、その id は backfill の取り直し対象から消えて
// 二度と処理されない（at-least-once の gate）。live（bot.ts）と backfill で同じ判定を使う
export function canAdvanceCursorPast(
  unfinishedMessageIds: Iterable<string>,
  messageId: string,
): boolean {
  for (const pending of unfinishedMessageIds) {
    if (isDiscordMessageIdNewer(messageId, pending)) {
      return false
    }
  }

  return true
}

// cursor が既に越えている ids を返す（state file に書く前の prune 用）。cursor が無い state では何も
// 返さない。cursor が届いた側の ids を持ち続けると state file が無制限に膨れる：answered は backfill が
// cursor より新しい物だけを見るので持つ意味が無く、unfinished は cursor がその id を越えた時点で backfill の
// 取り直し対象から外れる（取り直しを待って持ち続けると cursor が恒久的に止まる）。unfinished を cursor
// より新しい間（＝まだ取り直し対象）は残す。起動直後の save での pruning だけは bot.ts で例外にしている
// （cursor gate 以前に書かれた state の unfinished を、backfill が読む前に消さないため）
export function idsBehindCursor(ids: Iterable<string>, cursor: string | null): string[] {
  if (cursor === null) {
    return []
  }

  const behind: string[] = []

  for (const id of ids) {
    if (!isDiscordMessageIdNewer(id, cursor)) {
      behind.push(id)
    }
  }

  return behind
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
