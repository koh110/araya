import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export type Risk = 'read-only' | 'workspace' | 'external'

export type Observation = {
  observationId: string
  kind: string
  title: string
  risk: Risk
  payload: Record<string, unknown>
}

export type ReadObservationsResult = {
  observations: Observation[]
  errors: string[]
}

const allowedKeys = new Set(['id', 'title', 'kind', 'risk', 'payload'])

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('string expected')
  }

  return value.trim()
}

function optionalText(value: unknown, fallback: string): string {
  if (value === undefined) {
    return fallback
  }

  const text = asText(value)

  return text === '' ? fallback : text
}

function optionalJsonObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {}
  }

  if (!isJsonObject(value)) {
    throw new Error('payload object expected')
  }

  return value
}

function asRisk(value: unknown): Risk {
  const text = asText(value)

  if (text === 'read-only' || text === 'workspace' || text === 'external') {
    return text
  }

  throw new Error('risk must be read-only, workspace, or external')
}

function autoObservationId(parsed: Record<string, unknown>): string {
  const hash = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')

  return `auto:${hash.slice(0, 24)}`
}

function validateObservation(parsed: unknown): Observation {
  if (!isJsonObject(parsed)) {
    throw new Error('JSON object expected')
  }

  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`unknown key: ${key}`)
    }
  }

  const title = asText(parsed.title)

  if (title === '') {
    throw new Error('title is required')
  }

  const kind = optionalText(parsed.kind, 'investigate')
  const risk = asRisk(parsed.risk)
  const payload = optionalJsonObject(parsed.payload)

  if (kind === 'development') {
    if (risk !== 'workspace') {
      throw new Error('development kind requires workspace risk')
    }

    const unknownPayloadKeys = Object.keys(payload).filter((key) => {
      return key !== 'task'
    })

    if (unknownPayloadKeys.length > 0) {
      throw new Error(
        `development payload accepts only task; unsupported key(s): ${unknownPayloadKeys.join(', ')} ` +
        '(verifyCommand was removed: the agent registers verification commands per repository)'
      )
    }

    if (typeof payload.task !== 'string' || payload.task.trim() === '') {
      throw new Error('development task payload.task is required')
    }

    if (payload.task.length > 20_000 || payload.task.includes('\0')) {
      throw new Error('development task must be at most 20000 characters and contain no NUL byte')
    }
  } else if (risk === 'workspace') {
    throw new Error('workspace risk requires development kind')
  }

  const rawId = parsed.id
  const observationId = rawId === undefined ? autoObservationId(parsed) : asText(rawId)

  if (observationId === '') {
    throw new Error('id must not be empty')
  }

  return {
    observationId,
    kind,
    title,
    risk,
    payload
  }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const child = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      yield* walkFiles(child)
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield child
    }
  }
}

export async function readObservationSource(inboxDir: string): Promise<ReadObservationsResult> {
  const observations: Observation[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  let files: string[] = []

  try {
    for await (const file of walkFiles(inboxDir)) {
      files.push(file)
    }
  } catch (error) {
    errors.push(`${inboxDir}: ${error instanceof Error ? error.message : String(error)}`)
    return { observations, errors }
  }

  files.sort()

  for (const file of files) {
    let content: string

    try {
      content = await fs.readFile(file, 'utf8')
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const lines = content.split(/\r?\n/u)

    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') {
        continue
      }

      try {
        const parsed: unknown = JSON.parse(line)
        const observation = validateObservation(parsed)

        if (seen.has(observation.observationId)) {
          errors.push(`${file}:${index + 1}: duplicate observation id: ${observation.observationId}`)
          continue
        }

        seen.add(observation.observationId)
        observations.push(observation)
      } catch (error) {
        errors.push(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return { observations, errors }
}
