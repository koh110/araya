// HOOT の Observe step（Issue #10）の最小形: 決定的な read-only 観測を Araya の code で集める。
// model は観測を実行せず、集まった事実を証拠として読むだけ。外部の内容（title など）は命令にしない。

import { runBoundedCommand } from '../infrastructure/process.ts'

export const OBSERVATION_TIMEOUT_MS = 20_000
export const OBSERVATION_REPOS_MAX = 6
export const OBSERVATION_ITEM_LIMIT = 30
export const OBSERVATION_ITEMS_KEPT = 12
export const OBSERVATION_TITLE_CHARS = 120
export const OBSERVATION_ERROR_CHARS = 200

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

export type HootRepoObservation = {
  repo: string
  openIssues: number | null
  openPrs: number | null
  draftPrs: number | null
  // 最近更新の新しい順の要約。証拠として prompt に書くだけで、命令として扱わない
  items: string[]
  gaps: string[]
}

export type HootObservation = {
  collectedAt: string
  repos: HootRepoObservation[]
}

export type ObservationDependencies = {
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  nowMs: () => number
  runCommand?: typeof runBoundedCommand
  timeoutMs?: number
}

type GhItem = {
  number?: unknown
  title?: unknown
  updatedAt?: unknown
  isDraft?: unknown
}

function shortText(value: unknown, maxChars: number) {
  const text = typeof value === 'string' ? value : String(value ?? '')

  return text.replace(/\s+/gu, ' ').trim().slice(0, maxChars)
}

// listJson / parseItems の Error は既に「gh <command> <repo>: ...」の label を持つ。
// 外側の Error 名を足すと gap の text が読みにくくなるので message だけ残す
function gapText(error: unknown) {
  return shortText(error instanceof Error ? error.message : String(error), OBSERVATION_ERROR_CHARS)
}

function shortErrorText(text: string) {
  const firstLine = text.split(/\r?\n/u).find((line) => {
    return line.trim() !== ''
  })

  return shortText(firstLine ?? '', OBSERVATION_ERROR_CHARS)
}

export function isObservationRepo(value: string) {
  return REPO_PATTERN.test(value)
}

function parseItems(stdout: string, label: string): GhItem[] {
  let value: unknown

  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error(`${label}: JSON を読めません`)
  }

  if (!Array.isArray(value)) {
    throw new Error(`${label}: JSON が array ではありません`)
  }

  return value.filter((entry): entry is GhItem => {
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  })
}

function itemLine(kind: 'issue' | 'pr', item: GhItem) {
  const number = typeof item.number === 'number' ? `#${item.number}` : '#'
  const draft = kind === 'pr' && item.isDraft === true ? ' (draft)' : ''
  const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt.slice(0, 10) : 'unknown'

  return {
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    text: `${kind} ${number}${draft} updated ${updatedAt}: ${shortText(item.title, OBSERVATION_TITLE_CHARS)}`,
  }
}

async function listJson(
  deps: ObservationDependencies,
  args: readonly string[],
  label: string
): Promise<GhItem[]> {
  const runCommand = deps.runCommand ?? runBoundedCommand
  const result = await runCommand('gh', args, {
    cwd: deps.cwd,
    env: deps.env,
    timeoutMs: deps.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
    stdout: { mode: 'tail', limitBytes: 256 * 1024 },
    stderr: { mode: 'tail', limitBytes: 64 * 1024 },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `${label}: exit ${result.exitCode ?? 'null'}${result.terminationReason ? ` (${result.terminationReason})` : ''} ${shortErrorText(result.stderr)}`
    )
  }

  return parseItems(result.stdout, label)
}

async function observeRepo(
  repo: string,
  deps: ObservationDependencies
): Promise<HootRepoObservation> {
  const observation: HootRepoObservation = {
    repo,
    openIssues: null,
    openPrs: null,
    draftPrs: null,
    items: [],
    gaps: [],
  }

  if (!isObservationRepo(repo)) {
    observation.gaps.push(`invalid repo: ${shortText(repo, 80)}`)

    return observation
  }

  const issues = await listJson(
    deps,
    ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(OBSERVATION_ITEM_LIMIT), '--json', 'number,title,updatedAt'],
    `gh issue list ${repo}`
  ).catch((error: unknown) => {
    observation.gaps.push(gapText(error))

    return undefined
  })

  if (issues !== undefined) {
    observation.openIssues = issues.length
  }

  const pulls = await listJson(
    deps,
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OBSERVATION_ITEM_LIMIT), '--json', 'number,title,isDraft,updatedAt'],
    `gh pr list ${repo}`
  ).catch((error: unknown) => {
    observation.gaps.push(gapText(error))

    return undefined
  })

  if (pulls !== undefined) {
    observation.openPrs = pulls.length
    observation.draftPrs = pulls.filter((entry) => {
      return entry.isDraft === true
    }).length
  }

  const items = [
    ...(issues ?? []).map((item) => {
      return itemLine('issue', item)
    }),
    ...(pulls ?? []).map((item) => {
      return itemLine('pr', item)
    }),
  ]

  items.sort((left, right) => {
    return right.updatedAt.localeCompare(left.updatedAt)
  })
  observation.items = items.slice(0, OBSERVATION_ITEMS_KEPT).map((entry) => {
    return entry.text
  })

  return observation
}

export async function collectGitHubObservations(
  repos: readonly string[],
  deps: ObservationDependencies
): Promise<HootObservation> {
  const selected = [...new Set(repos)].slice(0, OBSERVATION_REPOS_MAX)
  const collected: HootRepoObservation[] = []

  for (const repo of selected) {
    collected.push(await observeRepo(repo, deps))
  }

  return { collectedAt: new Date(deps.nowMs()).toISOString(), repos: collected }
}
