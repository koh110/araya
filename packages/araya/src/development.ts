import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import type { SessionModel } from './development-model.ts'
import {
  VERIFICATION_OUTPUT_BYTES,
  type GitCommandRunner,
  type VerificationCommandInput,
  type VerificationCommandResult
} from './development-process.ts'
import { deliverDraftPullRequests, type DraftPrSnapshotGuard, type DraftPrWorktreeEvidence, type DraftPrWorktreeInput } from './draft-pr-delivery.ts'
import { hashGitDiffSnapshot, splitGitDiffSections } from './draft-pr-snapshot.ts'
import {
  readDecision,
  readTaskState,
  type DecisionRecord,
  type VerificationRecord,
  type WorktreeRecord
} from './development-worktrees.ts'
import type { CutSide } from './redaction.ts'

const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1000
const MAX_SUMMARY_CHARS = 4000
const MAX_FAILURE_DETAIL_CHARS = 500
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_GIT_STDERR_BYTES = 8 * 1024
const MAX_CHANGED_FILES = 1000
const MAX_CHANGED_PATH_BYTES = 128 * 1024
export const MAX_DIFF_BYTES = 256 * 1024
export const DIFF_TRUNCATION_MARKER = `\n[diff truncated: the evidence limit is ${MAX_DIFF_BYTES} bytes across all worktrees]\n`
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024
const GIT_TIMEOUT_MS = 60_000
const GIT_CANDIDATES = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'] as const
// `-C` で指定した worktree 以外を git に操作させる環境変数は引き継がない
const GIT_REPOSITORY_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE'
] as const

// SHIKI が使った model と、それを選んだ設定の出どころ
export type AgentModelEvidence = SessionModel & { source: 'araya-config' | 'pi-settings' }

// SHIKI の終わり方。差分の収集と検証は、これを受け取ってから行う。
// error は agent_timeout・model_unavailable・submission の reason など、errorMessage はその詳細（秘密を置き換えたもの）
export type AgentOutcome =
  | { status: 'completed'; summary: string; model: AgentModelEvidence }
  | { status: 'failed' | 'timeout'; error: string; errorMessage?: string; model?: AgentModelEvidence }

export type DevelopmentResult = {
  status: 'completed' | 'failed' | 'blocked'
  evidence: Record<string, unknown>
  // SHIKI が人に求めた判断の質問。decision.json が無ければ null
  decisionQuestion: string | null
  // 差分を集めたかどうか。集めた試行だけが、差分と検証の出力の本文を evidence.json に残す
  collected: boolean
}

export type DevelopmentResultInput = {
  taskKey: string
  title: string
  draftPrDelivery: boolean
  // 開発 root の実 path（呼び出し側で解決済み）
  devRoot: string
  stateDir: string
  agent: AgentOutcome
  env: Readonly<Record<string, string | undefined>>
  verificationTimeoutMs: number
  // 中止されたら、実行中の検証のコマンドを timeout と同じ手順で止める（Harness を閉じたとき、試行を中止したとき）
  signal?: AbortSignal
  // 秘密の置き換え。誤りの message を切り詰める前に使う（切り詰めで秘密の一部や URL の @ が境界の外に出ないように）
  redact: (text: string) => string
  // 上限で切って読んだ本文（差分、検証の出力、git の stderr）の置き換え。cut は切った側で、その境界に接する部分も置き換える
  redactTruncated: (text: string, cut: CutSide) => string
}

export type DevelopmentResultDependencies = {
  // 差分の収集の git を起動する関数。runner は試行の scope の中で起動する関数を渡す
  runGit: GitCommandRunner
  // commit・push の git を起動する関数。runner は試行の delivery scope の中で起動する関数を渡す
  runDeliveryGit?: GitCommandRunner
  // GitHub CLI を起動する関数。runner は試行の delivery scope の中で起動する関数を渡す
  runGitHub?: GitCommandRunner
  // index は verifications.jsonl の中の登録の順番（0 から）。runner は検証の scope の名前に使う
  runVerification: (input: VerificationCommandInput & { index: number }) => Promise<VerificationCommandResult>
  // 差分の収集に使う git（test 用）。省略時は GIT_CANDIDATES から選ぶ
  gitExecutable?: string
}

type FailureReason =
  | 'termination_unconfirmed'
  | 'task_state_invalid'
  | 'evidence_collection_failed'
  | 'agent_timeout'
  | 'agent_failed'
  | 'no_changes'
  | 'verification_missing'
  | 'verification_failed'
  | 'draft_pr_failed'

type GitContext = {
  executable: string
  env: Record<string, string | undefined>
  run: GitCommandRunner
  redact: (text: string) => string
  redactTruncated: (text: string, cut: CutSide) => string
}

type DiffEvidence = {
  headSha: string
  headMoved: boolean
  changedFiles: string[]
  diff: string
  diffTruncated: boolean
  diffStat: { files: number; insertions: number; deletions: number; truncated: boolean }
  snapshotSha256: string
  snapshotDiffSha256: string
}

type VerificationEvidence = {
  command: string[]
  cwd: string
  status: 'passed' | 'failed' | 'timeout' | 'not_run'
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  reason?: string
}

function isWithinOrEqual(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)

  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

// 秘密を置き換えてから切り詰める
function describeError(error: unknown, redact: (text: string) => string) {
  const message = error instanceof Error ? error.message : String(error)

  return redact(message).slice(0, MAX_FAILURE_DETAIL_CHARS)
}

function validateTimeout(timeoutMs: number, name: string) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`${name} must be between 1000 and ${MAX_TASK_TIMEOUT_MS} milliseconds`)
  }
}

async function findGitExecutable() {
  for (const candidate of GIT_CANDIDATES) {
    try {
      const realPath = await fs.realpath(candidate)
      const stat = await fs.stat(realPath)

      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        return realPath
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
        throw error
      }
    }
  }

  throw new Error(`git was not found in ${GIT_CANDIDATES.join(', ')}`)
}

function createGitEnv(env: Readonly<Record<string, string | undefined>>) {
  const gitEnv: Record<string, string | undefined> = {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  }

  for (const key of GIT_REPOSITORY_ENV_KEYS) {
    delete gitEnv[key]
  }

  return gitEnv
}

async function runGit(git: GitContext, worktreePath: string, args: readonly string[], stdoutLimitBytes = MAX_GIT_OUTPUT_BYTES) {
  const result = await git.run(git.executable, [
    '-C', worktreePath,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat',
    ...args
  ], {
    env: git.env,
    timeoutMs: GIT_TIMEOUT_MS,
    stdout: { mode: 'strict', limitBytes: stdoutLimitBytes },
    stderr: { mode: 'tail', limitBytes: MAX_GIT_STDERR_BYTES }
  })

  if (!result.terminationConfirmed) {
    throw Object.assign(new Error(`git ${args[0] ?? ''} termination could not be confirmed`), { terminationConfirmed: false })
  }

  return result
}

async function runGitChecked(git: GitContext, worktreePath: string, args: readonly string[]) {
  const result = await runGit(git, worktreePath, args)

  if (result.terminationReason !== undefined || result.exitCode !== 0) {
    // stderr は末尾だけを残すので、上限を超えたときは先頭の境界も置き換える
    const stderr = result.stderrBytes > MAX_GIT_STDERR_BYTES
      ? git.redactTruncated(result.stderr, 'start').trim()
      : git.redact(result.stderr.trim())
    const detail = stderr === '' ? '' : `: ${stderr.slice(0, MAX_FAILURE_DETAIL_CHARS)}`
    throw new Error(`git ${args.join(' ')} failed${detail}`)
  }

  return result.stdout
}

function parseNulSeparatedPaths(output: string) {
  const paths: string[] = []

  for (const entry of output.split('\0')) {
    if (entry === '') {
      continue
    }

    if (path.isAbsolute(entry) || entry.split(/[\\/]+/u).includes('..')) {
      throw new Error(`git reported an unexpected path: ${JSON.stringify(entry)}`)
    }

    paths.push(entry)
  }

  return paths
}

async function readBoundedFile(fileHandle: FileHandle, limit: number) {
  const buffer = Buffer.alloc(limit + 1)
  let length = 0

  while (length < buffer.byteLength) {
    const { bytesRead } = await fileHandle.read(buffer, length, buffer.byteLength - length, length)

    if (bytesRead === 0) {
      break
    }

    length += bytesRead
  }

  return {
    content: buffer.subarray(0, Math.min(length, limit)),
    truncated: length > limit
  }
}

async function collectUntrackedDiff(worktreePath: string, untrackedFiles: readonly string[]) {
  const chunks: string[] = []
  const entries: { path: string; diff: string }[] = []
  let bytes = 0
  let truncated = false

  for (const relativePath of untrackedFiles) {
    const candidate = path.resolve(worktreePath, relativePath)

    if (!isWithinOrEqual(candidate, worktreePath)) {
      throw new Error('untracked path is outside the worktree')
    }

    const displayedPath = JSON.stringify(relativePath.replaceAll('\\', '/'))
    let fileHandle

    try {
      fileHandle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    } catch (error) {
      if (isErrno(error, 'ELOOP')) {
        const note = `\n[untracked symlink omitted: ${displayedPath}]\n`
        chunks.push(note)
        entries.push({ path: relativePath, diff: note })
        bytes += Buffer.byteLength(note)
        truncated = true
        continue
      }

      if (isErrno(error, 'ENOENT')) {
        throw new Error(`untracked file ${displayedPath} disappeared during evidence collection`)
      }

      throw error
    }

    try {
      const stat = await fileHandle.stat()

      if (!stat.isFile()) {
        const note = `\n[untracked non-regular file omitted: ${displayedPath}]\n`
        chunks.push(note)
        entries.push({ path: relativePath, diff: note })
        bytes += Buffer.byteLength(note)
        truncated = true
        continue
      }

      const mode = (stat.mode & 0o111) === 0 ? '100644' : '100755'
      const header = [
        `diff --git a/${displayedPath} b/${displayedPath}`,
        `new file mode ${mode}`,
        '--- /dev/null',
        `+++ b/${displayedPath}`
      ].join('\n')
      const remaining = Math.max(0, MAX_UNTRACKED_FILE_BYTES - bytes)
      const fileRead = await readBoundedFile(fileHandle, remaining)

      if (fileRead.truncated || stat.size > fileRead.content.byteLength) {
        const chunk = `${header}\n[untracked file content omitted or truncated: ${displayedPath}; bytes=${stat.size}]\n`
        chunks.push(chunk)
        entries.push({ path: relativePath, diff: chunk })
        bytes += Buffer.byteLength(chunk)
        truncated = true
        continue
      }

      let text: string

      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fileRead.content)
      } catch {
        const chunk = `${header}\n[binary untracked file omitted: ${displayedPath}; bytes=${stat.size}]\n`
        chunks.push(chunk)
        entries.push({ path: relativePath, diff: chunk })
        bytes += Buffer.byteLength(chunk)
        truncated = true
        continue
      }

      const lines = text === '' ? [] : text.split('\n')

      if (text.endsWith('\n')) {
        lines.pop()
      }

      const hunk = lines.length === 0
        ? []
        : [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => {
            return `+${line}`
          })]
      const chunk = `${header}\n${hunk.join('\n')}${hunk.length === 0 ? '' : '\n'}${text !== '' && !text.endsWith('\n') ? '\\ No newline at end of file\n' : ''}`
      chunks.push(chunk)
      entries.push({ path: relativePath, diff: chunk })
      bytes += Buffer.byteLength(chunk)
    } finally {
      await fileHandle.close()
    }
  }

  return { diff: chunks.join(''), entries, truncated }
}

function truncateUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, 'utf8')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let end = Math.min(buffer.byteLength, maxBytes)

  while (end >= Math.max(0, maxBytes - 4)) {
    try {
      return decoder.decode(buffer.subarray(0, end))
    } catch {
      end -= 1
    }
  }

  return decoder.decode(buffer.subarray(0, Math.max(0, end)))
}

// 切り詰めの印も含めて budget 以内に収める。印が入らない budget では diff を残さない。
// git diff の出力が上限で止まったとき（forceMarker）は、budget 以内でも切り詰めたことが分かるように印を付ける。
// 切った末尾の境界は、印を付ける前に置き換える。git diff の出力が上限（budget）で止まったときも、ここで budget から印の分を
// 除いた位置で切り直すので、git diff の出力の境界は diff に残らない
function limitDiff(diff: string, budget: number, forceMarker: boolean, redactTruncated: GitContext['redactTruncated']) {
  if (!forceMarker && Buffer.byteLength(diff) <= budget) {
    return diff
  }

  const markerBytes = Buffer.byteLength(DIFF_TRUNCATION_MARKER)

  if (budget < markerBytes) {
    return ''
  }

  return `${redactTruncated(truncateUtf8(diff, budget - markerBytes), 'end')}${DIFF_TRUNCATION_MARKER}`
}

function summarizeDiff(diff: string, fileCount: number, truncated: boolean) {
  let insertions = 0
  let deletions = 0
  let inHunk = false

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }

    if (line.startsWith('@@ ')) {
      inHunk = true
      continue
    }

    if (!inHunk) {
      continue
    }

    if (line.startsWith('+')) {
      insertions += 1
    } else if (line.startsWith('-')) {
      deletions += 1
    }
  }

  return { files: fileCount, insertions, deletions, truncated }
}

// snapshot の再確認では redaction count を増やさない。diff 本文は evidence へ返さず、hash 比較にだけ使う。
function createSnapshotGitContext(git: GitContext): GitContext {
  return {
    ...git,
    redact: (text) => text,
    redactTruncated: (text) => text
  }
}

// base SHA と作業 tree の差（commit 済み・未 commit・untracked）を集める
async function collectWorktreeDiff(git: GitContext, record: WorktreeRecord, diffBudget: number) {
  const worktreeReal = await fs.realpath(record.worktreePath)

  // 記録の検証の後に symlink へ置き換えられた worktree からは差分を集めない
  if (worktreeReal !== record.worktreePath) {
    throw new Error(`${record.worktreePath} resolves to ${worktreeReal}; recorded paths must not go through symlinks`)
  }

  const toplevel = (await runGitChecked(git, worktreeReal, ['rev-parse', '--show-toplevel'])).trim()

  if (await fs.realpath(toplevel) !== worktreeReal) {
    throw new Error(`${record.worktreePath} is not the root of a git worktree`)
  }

  const branch = (await runGitChecked(git, worktreeReal, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

  if (branch !== record.branch) {
    throw new Error(`the worktree branch changed from ${record.branch} to ${branch}`)
  }

  const headSha = (await runGitChecked(git, worktreeReal, ['rev-parse', '--verify', 'HEAD'])).trim()
  const trackedFiles = parseNulSeparatedPaths(await runGitChecked(git, worktreeReal, [
    'diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--name-only', '-z', record.baseSha, '--'
  ]))
  const untrackedFiles = parseNulSeparatedPaths(await runGitChecked(git, worktreeReal, [
    'ls-files', '--others', '--exclude-standard', '-z'
  ]))
  const changedFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort()

  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`more than ${MAX_CHANGED_FILES} files changed in ${record.worktreePath}`)
  }

  if (Buffer.byteLength(changedFiles.join('\n')) > MAX_CHANGED_PATH_BYTES) {
    throw new Error(`changed paths exceed ${MAX_CHANGED_PATH_BYTES} bytes in ${record.worktreePath}`)
  }

  const trackedDiff = await runGit(git, worktreeReal, [
    'diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--unified=3', record.baseSha, '--'
  ], diffBudget)

  if (trackedDiff.exitCode === null && trackedDiff.terminationReason !== 'output_overflow') {
    throw new Error('git diff did not finish')
  }

  if (trackedDiff.terminationReason === 'timeout' || trackedDiff.terminationReason === 'invalid_utf8') {
    throw new Error(`git diff failed (${trackedDiff.terminationReason})`)
  }

  if (trackedDiff.terminationReason === undefined && trackedDiff.exitCode !== 0) {
    throw new Error(`git diff exited with ${String(trackedDiff.exitCode)}`)
  }

  const untracked = await collectUntrackedDiff(worktreeReal, untrackedFiles)
  const rawDiff = `${trackedDiff.stdout}${untracked.diff}`
  const trackedOverflowed = trackedDiff.terminationReason === 'output_overflow'
  const diff = limitDiff(rawDiff, diffBudget, trackedOverflowed, git.redactTruncated)
  const sectionsByPath = new Map<string, string>()
  const trackedSections = splitGitDiffSections(trackedDiff.stdout)
  let sectionsComplete = trackedSections !== null && trackedSections.length === trackedFiles.length

  if (trackedSections !== null && trackedSections.length === trackedFiles.length) {
    for (const [index, changedPath] of trackedFiles.entries()) {
      const section = trackedSections[index]

      if (section !== undefined) {
        sectionsByPath.set(changedPath, section)
      }
    }
  }

  for (const entry of untracked.entries) {
    const sections = splitGitDiffSections(entry.diff)

    if (sections === null || sections.length !== 1) {
      sectionsComplete = false
      continue
    }

    sectionsByPath.set(entry.path, sections[0] ?? '')
  }

  const orderedSections = changedFiles.map((changedPath) => sectionsByPath.get(changedPath))
  const completeSections: string[] = []

  for (const section of orderedSections) {
    if (section === undefined) {
      continue
    }

    completeSections.push(section)
  }

  const normalizedSnapshotSha256 = completeSections.length === changedFiles.length
    ? hashGitDiffSnapshot(changedFiles, completeSections)
    : null
  const snapshotDiffSha256 = normalizedSnapshotSha256 ?? createHash('sha256').update(rawDiff).digest('hex')
  const diffTruncated = trackedOverflowed || untracked.truncated || diff !== rawDiff || !sectionsComplete || normalizedSnapshotSha256 === null
  const snapshotSha256 = createHash('sha256')
    .update(branch)
    .update('\0')
    .update(headSha)
    .update('\0')
    .update(changedFiles.join('\0'))
    .update('\0')
    .update(rawDiff)
    .digest('hex')

  const evidence: DiffEvidence = {
    headSha,
    headMoved: headSha !== record.baseSha,
    changedFiles,
    diff,
    diffTruncated,
    diffStat: summarizeDiff(diff, changedFiles.length, diffTruncated),
    snapshotSha256,
    snapshotDiffSha256
  }

  return evidence
}

// 検証の cwd が symlink などで worktree の外を指していないことを確かめる。存在しない cwd は検証の実行側で cwd_missing にする
async function checkVerificationCwd(cwd: string, worktreePath: string) {
  let cwdReal: string

  try {
    cwdReal = await fs.realpath(cwd)
  } catch (error) {
    return isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') ? undefined : 'cwd_unresolvable'
  }

  return isWithinOrEqual(cwdReal, worktreePath) ? undefined : 'cwd_outside_worktree'
}

function notRun(record: VerificationRecord, reason: string) {
  const evidence: VerificationEvidence = {
    command: [...record.command],
    cwd: record.cwd,
    status: 'not_run',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    reason
  }

  return evidence
}

function toWorktreeEvidence(record: WorktreeRecord, diff: DiffEvidence, verifications: VerificationEvidence[]) {
  return {
    repository: record.repository,
    worktreePath: record.worktreePath,
    branch: record.branch,
    base: record.base,
    baseSha: record.baseSha,
    headSha: diff.headSha,
    headMoved: diff.headMoved,
    excludeAdded: record.excludeAdded,
    changedFiles: diff.changedFiles,
    diffStat: diff.diffStat,
    diff: diff.diff,
    diffTruncated: diff.diffTruncated,
    verifications
  }
}

function toWorktreeLocation(record: WorktreeRecord) {
  return {
    repository: record.repository,
    worktreePath: record.worktreePath,
    branch: record.branch,
    base: record.base,
    baseSha: record.baseSha,
    excludeAdded: record.excludeAdded
  }
}

// SHIKI の終わり方は agent にまとめる。summary だけは top level に置く
export function agentEvidence(agent: AgentOutcome) {
  if (agent.status === 'completed') {
    return { summary: agent.summary.slice(0, MAX_SUMMARY_CHARS), agent: { model: agent.model } }
  }

  return {
    agent: {
      error: agent.error,
      ...(agent.errorMessage === undefined ? {} : { errorMessage: agent.errorMessage }),
      ...(agent.model === undefined ? {} : { model: agent.model })
    }
  }
}

// 差分の収集と検証を行わずに作る evidence（worktree だけの evidence）。状態 directory の worktrees.jsonl から
// worktree の path と branch だけを残す。読めなければ worktree を空にし、その理由を detail に返す
export async function buildWorktreeOnlyEvidence(input: {
  taskKey: string
  devRoot: string
  stateDir: string | null
  redact: (text: string) => string
}) {
  const worktrees: { worktreePath: string; branch: string }[] = []
  let detail: string | null = null

  if (input.stateDir !== null) {
    try {
      const content = await fs.readFile(path.join(input.stateDir, 'worktrees.jsonl'), 'utf8')

      for (const line of content.split('\n')) {
        if (line === '') {
          continue
        }

        const value: unknown = JSON.parse(line)

        if (
          typeof value !== 'object' || value === null || Array.isArray(value) ||
          !('worktreePath' in value) || typeof value.worktreePath !== 'string' ||
          !('branch' in value) || typeof value.branch !== 'string'
        ) {
          throw new Error('a record does not have worktreePath and branch')
        }

        worktrees.push({ worktreePath: value.worktreePath, branch: value.branch })
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        worktrees.length = 0
        detail = `worktrees.jsonl could not be read: ${describeError(error, input.redact)}`
      }
    }
  }

  return {
    evidence: { taskKey: input.taskKey, devRoot: input.devRoot, stateDir: input.stateDir, worktrees, bodiesStored: false },
    detail
  }
}

export async function collectDevelopmentResult(
  input: DevelopmentResultInput,
  dependencies: DevelopmentResultDependencies
): Promise<DevelopmentResult> {
  validateTimeout(input.verificationTimeoutMs, 'verificationTimeoutMs')
  const { taskKey, devRoot, stateDir, agent, verificationTimeoutMs, redact, redactTruncated } = input

  let decision: DecisionRecord | null = null

  function fail(failureReason: FailureReason, collected: boolean, extra: Record<string, unknown> = {}) {
    const decisionQuestion = decision?.question ?? null
    const developmentResult: DevelopmentResult = {
      status: 'failed',
      evidence: { taskKey, devRoot, outcome: 'failed', failureReason, worktrees: [], decisionQuestion, ...extra },
      decisionQuestion,
      collected
    }

    return developmentResult
  }

  let state: Awaited<ReturnType<typeof readTaskState>>

  try {
    state = await readTaskState({ devRoot, stateDir, taskKey })
    decision = await readDecision(stateDir)
  } catch (error) {
    decision = null
    return fail('task_state_invalid', false, { ...agentEvidence(agent), failureDetail: describeError(error, redact) })
  }

  // SHIKI が成功で終わって判断を求めていれば blocked。差分は集め、検証は実行しない
  const decisionRequested = agent.status === 'completed' && decision !== null

  const diffs: DiffEvidence[] = []
  const diffBudgets: number[] = []
  let git: GitContext | null = null

  try {
    git = {
      executable: dependencies.gitExecutable ?? await findGitExecutable(),
      env: createGitEnv(input.env),
      run: dependencies.runGit,
      redact,
      redactTruncated
    }

    let diffBudget = MAX_DIFF_BYTES

    for (const record of state.worktrees) {
      diffBudgets.push(diffBudget)
      const diff = await collectWorktreeDiff(git, record, diffBudget)
      diffBudget = Math.max(0, diffBudget - Buffer.byteLength(diff.diff))
      diffs.push(diff)
    }
  } catch (error) {
    // 差分の収集に使う git の終了を確認できない場合も、差分の収集の失敗として扱う
    return fail('evidence_collection_failed', false, {
      ...agentEvidence(agent),
      failureDetail: describeError(error, redact),
      worktrees: state.worktrees.map(toWorktreeLocation)
    })
  }

  const changed = state.worktrees.map((_record, index) => {
    return (diffs[index]?.changedFiles.length ?? 0) > 0
  })
  const anyChanged = changed.includes(true)
  let verificationUnconfirmed = false
  const worktrees: ReturnType<typeof toWorktreeEvidence>[] = []

  for (const [index, record] of state.worktrees.entries()) {
    const diff = diffs[index]

    if (diff === undefined) {
      continue
    }

    const registered = state.verifications.filter((verification) => {
      return verification.repository === record.repository
    })
    const verifications: VerificationEvidence[] = []

    for (const verification of registered) {
      if (agent.status !== 'completed') {
        verifications.push(notRun(verification, agent.status === 'timeout' ? 'agent_timeout' : 'agent_failed'))
        continue
      }

      if (decisionRequested) {
        verifications.push(notRun(verification, 'decision_requested'))
        continue
      }

      if (changed[index] !== true) {
        verifications.push(notRun(verification, 'no_changes'))
        continue
      }

      if (verificationUnconfirmed) {
        verifications.push(notRun(verification, 'previous_termination_unconfirmed'))
        continue
      }

      const cwd = path.join(record.worktreePath, verification.cwd)
      const cwdProblem = await checkVerificationCwd(cwd, record.worktreePath)

      if (cwdProblem !== undefined) {
        verifications.push({ ...notRun(verification, cwdProblem), status: 'failed' })
        continue
      }

      let result: VerificationCommandResult

      try {
        result = await dependencies.runVerification({
          command: verification.command,
          cwd,
          env: input.env,
          timeoutMs: verificationTimeoutMs,
          index: state.verifications.indexOf(verification),
          ...(input.signal === undefined ? {} : { signal: input.signal })
        })
      } catch (error) {
        verifications.push({ ...notRun(verification, 'verification_error'), status: 'failed', stderr: describeError(error, redact) })
        continue
      }

      if (!result.terminationConfirmed) {
        verificationUnconfirmed = true
      }

      verifications.push({
        command: [...verification.command],
        cwd: verification.cwd,
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        // 検証の出力は末尾だけを残すので、上限を超えたときは先頭の境界を置き換える
        stdout: result.stdoutBytes > VERIFICATION_OUTPUT_BYTES ? redactTruncated(result.stdout, 'start') : result.stdout,
        stderr: result.stderrBytes > VERIFICATION_OUTPUT_BYTES ? redactTruncated(result.stderr, 'start') : result.stderr,
        ...(result.reason === undefined ? {} : { reason: result.reason })
      })
    }

    worktrees.push(toWorktreeEvidence(record, diff, verifications))
  }

  if (agent.status === 'completed' && !decisionRequested && !verificationUnconfirmed) {
    const snapshotGit = createSnapshotGitContext(git)
    let worktreeChangedDuringVerification = false

    try {
      for (const [index, record] of state.worktrees.entries()) {
        const verified = diffs[index]
        const current = await collectWorktreeDiff(snapshotGit, record, diffBudgets[index] ?? 0)

        if (verified === undefined || verified.snapshotSha256 !== current.snapshotSha256) {
          worktreeChangedDuringVerification = true
          break
        }
      }
    } catch (error) {
      return fail('evidence_collection_failed', true, {
        ...agentEvidence(agent),
        failureDetail: describeError(error, redact),
        worktrees
      })
    }

    if (worktreeChangedDuringVerification) {
      return fail('verification_failed', true, {
        ...agentEvidence(agent),
        worktrees,
        failureDetail: 'the worktree changed during verification or its final diff could not be captured completely; delivery was skipped'
      })
    }
  }

  function decideFailureReason(): FailureReason | undefined {
    if (verificationUnconfirmed) {
      return 'termination_unconfirmed'
    }

    if (agent.status === 'timeout') {
      return 'agent_timeout'
    }

    if (agent.status === 'failed') {
      return 'agent_failed'
    }

    // 判断の依頼では、差分が無いことや検証が無いことを失敗にしない
    if (decisionRequested) {
      return undefined
    }

    if (!anyChanged) {
      return 'no_changes'
    }

    const missing = worktrees.some((worktree, index) => {
      return changed[index] === true && worktree.verifications.length === 0
    })

    if (missing) {
      return 'verification_missing'
    }

    const failed = worktrees.some((worktree) => {
      return worktree.verifications.some((verification) => {
        return verification.status !== 'passed' && verification.status !== 'not_run'
      })
    })

    return failed ? 'verification_failed' : undefined
  }

  const failureReason = decideFailureReason()

  if (failureReason !== undefined) {
    return fail(failureReason, true, {
      ...agentEvidence(agent),
      worktrees,
      ...(verificationUnconfirmed ? { terminationConfirmed: false } : {})
    })
  }

  const decisionQuestion = decision?.question ?? null

  if (decisionRequested) {
    return {
      status: 'blocked',
      evidence: { taskKey, devRoot, outcome: 'blocked', ...agentEvidence(agent), worktrees, decisionQuestion },
      decisionQuestion,
      collected: true
    }
  }

  if (!input.draftPrDelivery) {
    return {
      status: 'completed',
      evidence: { taskKey, devRoot, outcome: 'completed', ...agentEvidence(agent), worktrees, decisionQuestion: null },
      decisionQuestion: null,
      collected: true
    }
  }

  if (git === null || dependencies.runGitHub === undefined) {
    return fail('draft_pr_failed', true, {
      ...agentEvidence(agent),
      worktrees,
      failureDetail: 'Draft PR delivery command runners are not configured'
    })
  }

  const snapshotGit = createSnapshotGitContext(git)

  try {
    for (const [index, record] of state.worktrees.entries()) {
      const verified = diffs[index]
      const current = await collectWorktreeDiff(snapshotGit, record, diffBudgets[index] ?? 0)

      if (verified === undefined || verified.diffTruncated || current.diffTruncated || verified.snapshotSha256 !== current.snapshotSha256) {
        return fail('verification_failed', true, {
          ...agentEvidence(agent),
          worktrees,
          failureDetail: 'the worktree changed during verification or its final diff could not be captured completely; delivery was skipped'
        })
      }
    }
  } catch (error) {
    return fail('evidence_collection_failed', true, {
      ...agentEvidence(agent),
      failureDetail: describeError(error, redact),
      worktrees
    })
  }

  const preflightSnapshotGuards: DraftPrSnapshotGuard[] = []

  for (const [index, record] of state.worktrees.entries()) {
    const diff = diffs[index]

    if (diff === undefined) {
      return fail('draft_pr_failed', true, {
        ...agentEvidence(agent),
        worktrees,
        failureDetail: 'verified worktree snapshot is missing'
      })
    }

    const diffBudget = diffBudgets[index] ?? 0
    const readSnapshot = async () => {
      const current = await collectWorktreeDiff(snapshotGit, record, diffBudget)

      return { snapshotSha256: current.snapshotSha256, diffTruncated: current.diffTruncated }
    }

    preflightSnapshotGuards.push({ record, snapshotSha256: diff.snapshotSha256, readSnapshot })
  }

  const deliveryWorktrees: DraftPrWorktreeInput[] = []

  for (const [index, record] of state.worktrees.entries()) {
    if (changed[index] !== true) {
      continue
    }

    const diff = diffs[index]
    const evidence = worktrees[index]
    const guard = preflightSnapshotGuards[index]

    if (diff === undefined || evidence === undefined || guard === undefined) {
      return fail('draft_pr_failed', true, {
        ...agentEvidence(agent),
        worktrees,
        failureDetail: 'verified worktree evidence is missing'
      })
    }

    deliveryWorktrees.push({
      record,
      headSha: diff.headSha,
      verificationCount: evidence.verifications.filter((verification) => verification.status === 'passed').length,
      snapshotSha256: diff.snapshotSha256,
      snapshotDiffSha256: diff.snapshotDiffSha256,
      snapshotChangedFiles: [...diff.changedFiles].sort(),
      readSnapshot: guard.readSnapshot
    })
  }

  const delivery = await deliverDraftPullRequests({
    taskKey,
    title: input.title,
    worktrees: deliveryWorktrees,
    preflightSnapshotGuards,
    env: input.env,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    redact
  }, {
    runGit: dependencies.runDeliveryGit ?? dependencies.runGit,
    runGitHub: dependencies.runGitHub,
    gitExecutable: git.executable
  })
  const deliveryByPath = new Map<string, DraftPrWorktreeEvidence>()

  for (const item of delivery.worktrees) {
    deliveryByPath.set(item.worktreePath, item)
  }

  const deliveredWorktrees = worktrees.map((worktree) => {
    const item = deliveryByPath.get(worktree.worktreePath)

    return item === undefined
      ? { ...worktree, draftPrStatus: 'skipped' }
      : { ...worktree, ...item }
  })
  const evidence: Record<string, unknown> = {
    taskKey,
    devRoot,
    outcome: delivery.status,
    ...agentEvidence(agent),
    worktrees: deliveredWorktrees,
    decisionQuestion: delivery.decisionQuestion,
    draftPrDelivery: { status: delivery.status, worktrees: delivery.worktrees }
  }

  if (delivery.failureReason !== null) {
    evidence.failureReason = delivery.failureReason
  }

  if (delivery.failureDetail !== null) {
    evidence.failureDetail = redact(delivery.failureDetail).slice(0, MAX_FAILURE_DETAIL_CHARS)
  }

  const developmentResult: DevelopmentResult = {
    status: delivery.status,
    evidence,
    decisionQuestion: delivery.decisionQuestion,
    collected: true
  }

  return developmentResult
}
