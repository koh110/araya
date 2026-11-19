import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

import {
  isThinkingLevel,
  MODEL_REFERENCE_RULE,
  parseModelReference,
  THINKING_LEVEL_RULE,
  type ConfigModel
} from './model.ts'

const MAX_CONFIG_FILE_BYTES = 64 * 1024
const TOP_LEVEL_KEYS = ['agent'] as const
const AGENT_KEYS = ['model', 'thinkingLevel'] as const

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

function parseAgentModel(configPath: string, value: unknown) {
  if (!isRecord(value)) {
    throw invalidConfig(configPath, 'the top level must be a JSON object')
  }

  const unknownTopLevelKeys = findUnknownKeys(value, TOP_LEVEL_KEYS)

  if (unknownTopLevelKeys.length > 0) {
    const migrationHint = unknownTopLevelKeys.includes('development')
      ? '（`development` は撤去されました。`development.model` を使っていたときは `model` と `thinkingLevel` を `agent` に移してください。file 内の設定が不要なら file を消すと Pi の default model を使います）'
      : ''

    throw invalidConfig(configPath, `unknown key(s): ${unknownTopLevelKeys.join(', ')}${migrationHint}`)
  }

  if (!('agent' in value)) {
    return null
  }

  const agent = value.agent

  if (!isRecord(agent)) {
    throw invalidConfig(configPath, 'agent must be an object')
  }

  const unknownAgentKeys = findUnknownKeys(agent, AGENT_KEYS)

  if (unknownAgentKeys.length > 0) {
    throw invalidConfig(configPath, `unknown key(s) in agent: ${unknownAgentKeys.join(', ')}`)
  }

  if (!('model' in agent)) {
    throw invalidConfig(configPath, 'agent.model is required')
  }

  const reference = parseModelReference(agent.model)

  if (reference === undefined) {
    throw invalidConfig(configPath, `agent.model must be ${MODEL_REFERENCE_RULE}`)
  }

  if (!('thinkingLevel' in agent)) {
    const model: ConfigModel = { ...reference, thinkingLevel: null }

    return model
  }

  const thinkingLevel = agent.thinkingLevel

  if (!isThinkingLevel(thinkingLevel)) {
    throw invalidConfig(configPath, `agent.thinkingLevel must be ${THINKING_LEVEL_RULE}`)
  }

  const model: ConfigModel = { ...reference, thinkingLevel }

  return model
}

// Araya の設定ファイルを読み、検証する。agent session の開始時に呼ぶ
export async function loadConfigFile(configPath: string) {
  const text = await readConfigText(configPath)

  if (text === undefined) {
    return { agentModel: null }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidConfig(configPath, 'the file is not valid JSON')
  }

  return { agentModel: parseAgentModel(configPath, parsed) }
}
