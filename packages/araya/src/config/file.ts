import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import {
  isThinkingLevel,
  MODEL_REFERENCE_RULE,
  parseModelReference,
  THINKING_LEVEL_RULE,
  type DevelopmentModel
} from './model.ts'

const MAX_CONFIG_FILE_BYTES = 64 * 1024
const TOP_LEVEL_KEYS = ['development'] as const
const DEVELOPMENT_KEYS = ['model', 'thinkingLevel'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function describeErrno(error: unknown) {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }

  return error instanceof Error ? error.message : String(error)
}

function invalidConfig(configPath: string, reason: string) {
  return new Error(`invalid Araya config file ${configPath}: ${reason}`)
}

function findUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).filter((key) => {
    return !allowed.includes(key)
  })
}

async function readBounded(fileHandle: FileHandle, limit: number) {
  const buffer = Buffer.alloc(limit + 1)
  let length = 0

  while (length < buffer.byteLength) {
    const { bytesRead } = await fileHandle.read(buffer, length, buffer.byteLength - length, length)

    if (bytesRead === 0) {
      break
    }

    length += bytesRead
  }

  return buffer.subarray(0, length)
}

// 何も無ければ undefined を返す。存在するのに読めなければ失敗にする
async function readConfigText(configPath: string) {
  let linkStat

  try {
    linkStat = await fs.lstat(configPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined
    }

    throw invalidConfig(configPath, `could not be inspected (${describeErrno(error)})`)
  }

  let fileHandle: FileHandle

  try {
    // FIFO などで止まらないように non-blocking で開き、開いた file が通常の file かを確かめる
    fileHandle = await fs.open(configPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch (error) {
    if (linkStat.isSymbolicLink() && (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR'))) {
      throw invalidConfig(configPath, 'the file is a broken symbolic link')
    }

    throw invalidConfig(configPath, `could not be read (${describeErrno(error)})`)
  }

  try {
    if (!(await fileHandle.stat()).isFile()) {
      throw invalidConfig(configPath, 'not a regular file')
    }

    let content: Buffer

    try {
      content = await readBounded(fileHandle, MAX_CONFIG_FILE_BYTES)
    } catch (error) {
      throw invalidConfig(configPath, `could not be read (${describeErrno(error)})`)
    }

    if (content.byteLength > MAX_CONFIG_FILE_BYTES) {
      throw invalidConfig(configPath, `the file exceeds ${MAX_CONFIG_FILE_BYTES} bytes`)
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      throw invalidConfig(configPath, 'the file is not valid UTF-8')
    }
  } finally {
    await fileHandle.close()
  }
}

function parseDevelopmentModel(configPath: string, value: unknown) {
  if (!isRecord(value)) {
    throw invalidConfig(configPath, 'the top level must be a JSON object')
  }

  const unknownTopLevelKeys = findUnknownKeys(value, TOP_LEVEL_KEYS)

  if (unknownTopLevelKeys.length > 0) {
    throw invalidConfig(configPath, `unknown key(s): ${unknownTopLevelKeys.join(', ')}`)
  }

  if (!('development' in value)) {
    return null
  }

  const development = value.development

  if (!isRecord(development)) {
    throw invalidConfig(configPath, 'development must be an object')
  }

  const unknownDevelopmentKeys = findUnknownKeys(development, DEVELOPMENT_KEYS)

  if (unknownDevelopmentKeys.length > 0) {
    throw invalidConfig(configPath, `unknown key(s) in development: ${unknownDevelopmentKeys.join(', ')}`)
  }

  if (!('model' in development)) {
    throw invalidConfig(configPath, 'development.model is required')
  }

  const reference = parseModelReference(development.model)

  if (reference === undefined) {
    throw invalidConfig(configPath, `development.model must be ${MODEL_REFERENCE_RULE}`)
  }

  if (!('thinkingLevel' in development)) {
    const model: DevelopmentModel = { ...reference, thinkingLevel: null }

    return model
  }

  const thinkingLevel = development.thinkingLevel

  if (!isThinkingLevel(thinkingLevel)) {
    throw invalidConfig(configPath, `development.thinkingLevel must be ${THINKING_LEVEL_RULE}`)
  }

  const model: DevelopmentModel = { ...reference, thinkingLevel }

  return model
}

// Araya の設定ファイルを読み、検証する。subcommand の起動時に1回だけ呼ぶ
export async function loadConfigFile(configPath: string) {
  const text = await readConfigText(configPath)

  if (text === undefined) {
    return { developmentModel: null }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidConfig(configPath, 'the file is not valid JSON')
  }

  return { developmentModel: parseDevelopmentModel(configPath, parsed) }
}

const MAX_PI_SETTINGS_BYTES = 1024 * 1024

type PiDefaultModel =
  | { model: string }
  | { reason: 'pi_settings_missing' | 'pi_settings_unreadable' | 'pi_settings_invalid' | 'pi_default_missing' | 'pi_default_invalid' }

export type DefaultConfigInitialization =
  | { status: 'created'; configPath: string; model: string }
  | { status: 'existing'; configPath: string }
  | { status: 'skipped'; configPath: string; reason: Exclude<PiDefaultModel, { model: string }>['reason'] }

// Pi の defaultProvider/defaultModel だけを読み、秘密情報など他の設定は持ち込まない
async function readPiDefaultModel(settingsPath: string): Promise<PiDefaultModel> {
  let linkStat

  try {
    linkStat = await fs.lstat(settingsPath)
  } catch (error) {
    return { reason: isErrno(error, 'ENOENT') ? 'pi_settings_missing' : 'pi_settings_unreadable' }
  }

  let fileHandle: FileHandle

  try {
    fileHandle = await fs.open(settingsPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch {
    return { reason: linkStat.isSymbolicLink() ? 'pi_settings_missing' : 'pi_settings_unreadable' }
  }

  let settings: unknown

  try {
    let isRegularFile: boolean

    try {
      isRegularFile = (await fileHandle.stat()).isFile()
    } catch {
      return { reason: 'pi_settings_unreadable' }
    }

    if (!isRegularFile) {
      return { reason: 'pi_settings_invalid' }
    }

    let content: Buffer

    try {
      content = await readBounded(fileHandle, MAX_PI_SETTINGS_BYTES)
    } catch {
      return { reason: 'pi_settings_unreadable' }
    }

    if (content.byteLength > MAX_PI_SETTINGS_BYTES) {
      return { reason: 'pi_settings_invalid' }
    }

    let text: string

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      return { reason: 'pi_settings_invalid' }
    }

    try {
      settings = JSON.parse(text)
    } catch {
      return { reason: 'pi_settings_invalid' }
    }
  } finally {
    await fileHandle.close()
  }

  if (!isRecord(settings)) {
    return { reason: 'pi_settings_invalid' }
  }

  if (!Object.hasOwn(settings, 'defaultProvider') || !Object.hasOwn(settings, 'defaultModel')) {
    return { reason: 'pi_default_missing' }
  }

  if (typeof settings.defaultProvider !== 'string' || typeof settings.defaultModel !== 'string') {
    return { reason: 'pi_default_invalid' }
  }

  const model = `${settings.defaultProvider}/${settings.defaultModel}`

  if (parseModelReference(model) === undefined) {
    return { reason: 'pi_default_invalid' }
  }

  return { model }
}

// deploy が runner を install するときに呼ぶ。既存 config は検証したうえで変更しない
export async function initializeConfigFromPiSettings(configPath: string, settingsPath: string): Promise<DefaultConfigInitialization> {
  try {
    await fs.lstat(configPath)
    await loadConfigFile(configPath)

    return { status: 'existing', configPath }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  const piDefault = await readPiDefaultModel(settingsPath)

  if (!('model' in piDefault)) {
    return { status: 'skipped', configPath, reason: piDefault.reason }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(path.dirname(configPath), `.config.json.${randomBytes(8).toString('hex')}.tmp`)
  const content = `${JSON.stringify({ development: { model: piDefault.model } }, null, 2)}\n`
  let temporaryCreated = false
  let created = false
  let existing = false

  try {
    const fileHandle = await fs.open(temporaryPath, 'wx', 0o600)
    temporaryCreated = true

    try {
      await fileHandle.writeFile(content, 'utf8')
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
    }

    try {
      await fs.link(temporaryPath, configPath)
      created = true
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error
      }

      existing = true
    }
  } finally {
    if (temporaryCreated) {
      await fs.rm(temporaryPath, { force: true })
    }
  }

  if (existing) {
    await loadConfigFile(configPath)

    return { status: 'existing', configPath }
  }

  if (!created) {
    throw new Error(`could not initialize Araya config file ${configPath}`)
  }

  await loadConfigFile(configPath)

  return { status: 'created', configPath, model: piDefault.model }
}
