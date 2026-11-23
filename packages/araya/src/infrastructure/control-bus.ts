// CLI と稼働中の Discord bot process を結ぶ control request の file bus（Issue #33）。
// `/araya status・stop・reset` は bot process の内側で会話 session を操作するので、CLI からも同じ operation を
// 打つために「CLI が request を書き、bot が拾って result を返す」だけに絞る（port・secret を作らない）。
// 書けるのは同じ OS user だけなので、権限は file system の owner がそのまま境界になる
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const CONTROL_COMMANDS = ['status', 'stop', 'reset'] as const

export type ControlCommandName = (typeof CONTROL_COMMANDS)[number]

export type ControlRequest = {
  version: 1
  id: string
  command: ControlCommandName
  source: 'cli'
  createdAt: string
}

export type ControlResult = {
  version: 1
  id: string
  command: ControlCommandName
  ok: boolean
  output: string
  finishedAt: string
  error?: string
}

// 古い request は bot が起動していない間に溜まるので、期限で「実行しませんでした」として閉じる
export const CONTROL_REQUEST_TTL_MS = 3 * 60 * 1000
export const CONTROL_RESULT_TTL_MS = 10 * 60 * 1000
// 溜まりすぎを防ぐ（CLI が wait を諦めた case の file を無限に残さない）
export const CONTROL_MAX_FILES = 40

export function isControlCommandName(value: string): value is ControlCommandName {
  return (CONTROL_COMMANDS as readonly string[]).includes(value)
}

function controlRoot(dataDir: string) {
  return path.join(dataDir, 'control')
}

export function controlRequestsDir(dataDir: string) {
  return path.join(controlRoot(dataDir), 'requests')
}

export function controlResultsDir(dataDir: string) {
  return path.join(controlRoot(dataDir), 'results')
}

function requestPath(dataDir: string, id: string) {
  return path.join(controlRequestsDir(dataDir), `${id}.json`)
}

function claimPath(dataDir: string, id: string) {
  return path.join(controlRequestsDir(dataDir), `${id}.json.claim`)
}

function resultPath(dataDir: string, id: string) {
  return path.join(controlResultsDir(dataDir), `${id}.json`)
}

// 同じ file に衝突しない id（interaction id の代わり reset の requestId に使う）
export function controlRequestId(nowMs: number, seed: string): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:TZ.]/gu, '')
  const digest = createHash('sha256').update(`${nowMs}:${seed}`).digest('hex').slice(0, 12)

  return `cli-${stamp}-${digest}`
}

async function ensureDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
}

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function parseControlJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }

    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function toControlRequest(value: Record<string, unknown>): ControlRequest | null {
  if (value.version !== 1 || typeof value.id !== 'string' || typeof value.command !== 'string') {
    return null
  }

  if (!isControlCommandName(value.command)) {
    return null
  }

  return {
    version: 1,
    id: value.id,
    command: value.command,
    source: 'cli',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  }
}

export async function writeControlRequest(dataDir: string, request: ControlRequest): Promise<void> {
  await ensureDirectory(controlRequestsDir(dataDir))
  await writeJson(requestPath(dataDir, request.id), request)
}

export async function readControlRequest(dataDir: string, id: string): Promise<ControlRequest | null> {
  try {
    const parsed = parseControlJson(await fs.readFile(requestPath(dataDir, id), 'utf8'))

    return parsed === null ? null : toControlRequest(parsed)
  } catch {
    return null
  }
}

// claim は rename を使う（単発の bot process 向けの実質 lock。同じ request を 2 回実行しない）
export async function claimControlRequest(dataDir: string, id: string): Promise<ControlRequest | null> {
  const from = requestPath(dataDir, id)
  const to = claimPath(dataDir, id)

  try {
    await fs.rename(from, to)
  } catch {
    return null
  }

  try {
    const parsed = parseControlJson(await fs.readFile(to, 'utf8'))

    return parsed === null ? null : toControlRequest(parsed)
  } catch {
    await fs.rm(to, { force: true })

    return null
  }
}

// CLI が待ち切れにした request を取り消す（bot が後で実行しないように unclaim の分だけ消す）
export async function cancelControlRequest(dataDir: string, id: string): Promise<boolean> {
  try {
    await fs.unlink(requestPath(dataDir, id))

    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // bot が claim 済み（rename 済み）。claim 側は bot が閉じる
      return false
    }

    throw error
  }
}

export async function readPendingControlRequests(dataDir: string): Promise<ControlRequest[]> {
  let names: string[]

  try {
    names = await fs.readdir(controlRequestsDir(dataDir))
  } catch {
    return []
  }

  const requests: ControlRequest[] = []

  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue
    }

    try {
      const parsed = parseControlJson(await fs.readFile(path.join(controlRequestsDir(dataDir), name), 'utf8'))
      const request = parsed === null ? null : toControlRequest(parsed)

      if (request !== null) {
        requests.push(request)
      }
    } catch {
      // 壊れた request は読み飛ばす（log 側に out of band で出す）
    }
  }

  return requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export async function finishControlRequest(
  dataDir: string,
  id: string,
  result: Omit<ControlResult, 'version' | 'id'>,
): Promise<ControlResult> {
  await ensureDirectory(controlResultsDir(dataDir))

  const full: ControlResult = { version: 1, id, ...result }
  await writeJson(resultPath(dataDir, id), full)
  await fs.rm(claimPath(dataDir, id), { force: true })

  return full
}

export async function readControlResult(dataDir: string, id: string): Promise<ControlResult | null> {
  try {
    const parsed = parseControlJson(await fs.readFile(resultPath(dataDir, id), 'utf8'))

    if (parsed === null || parsed.version !== 1 || typeof parsed.id !== 'string') {
      return null
    }

    const output = typeof parsed.output === 'string' ? parsed.output : ''
    const error = typeof parsed.error === 'string' ? parsed.error : undefined

    return {
      version: 1,
      id: parsed.id,
      command: isControlCommandName(String(parsed.command ?? '')) ? (parsed.command as ControlCommandName) : 'status',
      ok: parsed.ok === true,
      output,
      finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : '',
      ...(error === undefined ? {} : { error }),
    }
  } catch {
    return null
  }
}

// 期限切れの request は「実行しませんでした」の result として閉じる（CLI が待つままにしない）
export async function pruneControlFiles(dataDir: string, nowMs: number): Promise<number> {
  const cutoffMs = nowMs - CONTROL_REQUEST_TTL_MS
  const resultCutoffMs = nowMs - CONTROL_RESULT_TTL_MS
  let pruned = 0

  try {
    const names = await fs.readdir(controlRequestsDir(dataDir))

    for (const name of names) {
      const filePath = path.join(controlRequestsDir(dataDir), name)
      const isClaim = name.endsWith('.json.claim')
      const isRequest = name.endsWith('.json')

      if (!isClaim && !isRequest) {
        continue
      }

      const id = name.replace(/\.json(\.claim)?$/u, '')
      // claim file も中身は request の JSON なので同じ parser で読める
      const request = toControlRequest(parseControlJson(await fs.readFile(filePath, 'utf8')) ?? {})
      const stat = await fs.stat(filePath)
      let createdAtMs = Date.parse(request?.createdAt ?? '')

      // createdAt が読めない file も古さでは裁く（mtime を期限に見る）
      if (Number.isNaN(createdAtMs)) {
        createdAtMs = stat.mtimeMs
      }

      if (createdAtMs >= cutoffMs) {
        continue
      }

      // 未 claim の request には「実行しませんでした」を返す（claim 済みは bot が途中で落ちた分）
      if (isRequest) {
        await finishControlRequest(dataDir, id, {
          command: request?.command ?? 'status',
          ok: false,
          output: '',
          finishedAt: new Date(nowMs).toISOString(),
          error: 'araya_control_stale: bot が要求を取り出す前に期限を超えました（araya discord status で稼働を確かめてください）',
        })
      }

      await fs.rm(filePath, { force: true })
      pruned += 1
    }
  } catch {
    // control dir が無いのは正常（control を一度も打っていない）
  }

  try {
    const names = await fs.readdir(controlResultsDir(dataDir))
    const results: { name: string; mtimeMs: number }[] = []

    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue
      }

      const filePath = path.join(controlResultsDir(dataDir), name)
      results.push({ name: name, mtimeMs: (await fs.stat(filePath)).mtimeMs })
    }

    results.sort((left, right) => left.mtimeMs - right.mtimeMs)

    const expired = results.filter((entry) => {
      return entry.mtimeMs < resultCutoffMs
    })
    // 期限切れ以外も、max を超える分は古い順に捨てる
    const overflowCount = Math.max(0, results.length - expired.length - CONTROL_MAX_FILES)
    const overflow = results
      .filter((entry) => {
        return entry.mtimeMs >= resultCutoffMs
      })
      .slice(0, overflowCount)

    for (const entry of [...expired, ...overflow]) {
      await fs.rm(path.join(controlResultsDir(dataDir), entry.name), { force: true })
      pruned += 1
    }
  } catch {
    // results dir が無いのも正常
  }

  return pruned
}
