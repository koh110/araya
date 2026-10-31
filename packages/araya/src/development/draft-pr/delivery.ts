import fs from 'node:fs/promises'
import path from 'node:path'

import type { GitCommandRunner } from '../../infrastructure/process.ts'
import type { WorktreeRecord } from '../worktrees.ts'
import { hashGitDiffSnapshot, splitGitDiffSections } from './snapshot.ts'
import { isSecretEnvName } from '../../infrastructure/redaction.ts'

const GITHUB_HOST = 'github.com'
const GH_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 120_000
const MAX_GH_STDOUT_BYTES = 64 * 1024
const MAX_GH_STDERR_BYTES = 8 * 1024
const MAX_GIT_STDOUT_BYTES = 512 * 1024
const MAX_GIT_STDERR_BYTES = 8 * 1024
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

export type DraftPrDeliveryStatus = 'completed' | 'blocked' | 'failed'

export type DraftPrWorktreeEvidence = {
  repository: string
  worktreePath: string
  branch: string
  draftPrStatus: 'not_attempted' | 'prepared' | 'committed' | 'pushed' | 'created' | 'reused' | 'failed'
  commitSha: string | null
  baseBranch: string | null
  draftPrUrl: string | null
  remoteSideEffectsUnconfirmed?: boolean
}

export type DraftPrDeliveryResult = {
  status: DraftPrDeliveryStatus
  failureReason: string | null
  failureDetail: string | null
  decisionQuestion: string | null
  worktrees: DraftPrWorktreeEvidence[]
}

export type DraftPrWorktreeInput = {
  record: WorktreeRecord
  headSha: string
  verificationCount: number
  snapshotSha256: string
  snapshotDiffSha256: string
  snapshotChangedFiles: string[]
  readSnapshot: () => Promise<{ snapshotSha256: string; diffTruncated: boolean }>
}

export type DraftPrSnapshotGuard = Pick<DraftPrWorktreeInput, 'record' | 'snapshotSha256' | 'readSnapshot'>

export type DraftPrDeliveryInput = {
  taskKey: string
  title: string
  worktrees: DraftPrWorktreeInput[]
  preflightSnapshotGuards: DraftPrSnapshotGuard[]
  env: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  redact: (text: string) => string
}

export type DraftPrDeliveryDependencies = {
  runGit: GitCommandRunner
  runGitHub: GitCommandRunner
  gitExecutable?: string
  ghExecutable?: string
}

type DeliveryFailure = Error & {
  status: 'blocked' | 'failed'
  failureReason: string
  stage: string
}

type PreparedWorktree = {
  input: DraftPrWorktreeInput
  repositorySlug: string
  repositoryArgument: string
  pushUrl: string
  baseBranch: string
  userName: string
  userEmail: string
  existingPullRequest: PullRequest | null
}

type PullRequest = {
  url: string
  isDraft: boolean
  state: string
  headRefName: string
  baseRefName: string
  headRepository: { nameWithOwner: string } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createFailure(status: DeliveryFailure['status'], failureReason: string, stage: string, message: string) {
  return Object.assign(new Error(message), { status, failureReason, stage })
}

function isDeliveryFailure(error: unknown): error is DeliveryFailure {
  return error instanceof Error &&
    'status' in error && (error.status === 'blocked' || error.status === 'failed') &&
    'failureReason' in error && typeof error.failureReason === 'string' &&
    'stage' in error && typeof error.stage === 'string'
}

function safeEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const selected: Record<string, string | undefined> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isSecretEnvName(key)) {
      selected[key] = value
    }
  }

  for (const key of GIT_REPOSITORY_ENV_KEYS) {
    delete selected[key]
  }

  selected.GIT_OPTIONAL_LOCKS = '0'
  selected.GIT_TERMINAL_PROMPT = '0'
  selected.GH_PROMPT_DISABLED = '1'
  selected.GH_NO_UPDATE_NOTIFIER = '1'

  return selected
}

function isMissingPathError(error: unknown) {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function findExecutable(name: string, env: Readonly<Record<string, string | undefined>>) {
  const searchPath = env.PATH

  if (searchPath !== undefined) {
    for (const directory of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(directory)) {
        continue
      }

      const candidate = path.join(directory, name)

      try {
        const realPath = await fs.realpath(candidate)
        const stat = await fs.stat(realPath)

        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          return realPath
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error
        }
      }
    }
  }

  throw createFailure('blocked', 'github_cli_unavailable', 'find_gh', 'gh CLI was not found in PATH')
}

function runOptions(input: DraftPrDeliveryInput, cwd: string, timeoutMs: number, outputLimit: number) {
  return {
    cwd,
    env: safeEnvironment(input.env),
    timeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    stdout: { mode: 'strict' as const, limitBytes: outputLimit },
    stderr: { mode: 'tail' as const, limitBytes: MAX_GH_STDERR_BYTES }
  }
}

async function runGit(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  worktreePath: string,
  args: readonly string[]
) {
  const executable = dependencies.gitExecutable ?? '/usr/bin/git'
  const result = await dependencies.runGit(executable, [
    '-C', worktreePath,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat',
    ...args
  ], runOptions(input, worktreePath, GIT_TIMEOUT_MS, MAX_GIT_STDOUT_BYTES))

  if (!result.terminationConfirmed || result.terminationReason !== undefined || result.exitCode === null) {
    throw createFailure('failed', 'draft_pr_failed', 'git_command', 'git command did not finish cleanly')
  }

  return result
}

async function requireGitOutput(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  worktreePath: string,
  args: readonly string[],
  options: { status: DeliveryFailure['status']; failureReason: string; stage: string; message: string }
) {
  const result = await runGit(input, dependencies, worktreePath, args)

  if (result.exitCode !== 0) {
    throw createFailure(options.status, options.failureReason, options.stage, options.message)
  }

  return result.stdout.trim()
}

async function runGh(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  executable: string,
  cwd: string,
  args: readonly string[],
  stdin?: string
) {
  return dependencies.runGitHub(executable, args, {
    ...runOptions(input, cwd, GH_TIMEOUT_MS, MAX_GH_STDOUT_BYTES),
    stderr: { mode: 'tail', limitBytes: MAX_GH_STDERR_BYTES },
    ...(stdin === undefined ? {} : { input: stdin })
  })
}

async function requireGhSuccess(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  executable: string,
  cwd: string,
  args: readonly string[],
  options: { status: DeliveryFailure['status']; failureReason: string; stage: string; message: string }
) {
  const result = await runGh(input, dependencies, executable, cwd, args)

  if (!result.terminationConfirmed || result.terminationReason !== undefined || result.exitCode !== 0) {
    throw createFailure(options.status, options.failureReason, options.stage, options.message)
  }

  return result.stdout.trim()
}

function safeRepositorySegment(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value) && value !== '.' && value !== '..'
}

function parseRepositoryPath(value: string) {
  const parts = value.replace(/\.git$/iu, '').split('/')

  if (parts.length !== 2 || !parts.every(safeRepositorySegment)) {
    return null
  }

  return `${parts[0]}/${parts[1]}`
}

function parseGitHubRemote(value: string) {
  const sshScp = /^(?:git@github\.com:)([^?#]+)$/iu.exec(value)
  const sshUrl = /^ssh:\/\/git@github\.com\/([^?#]+)$/iu.exec(value)

  if (sshScp !== null || sshUrl !== null) {
    return parseRepositoryPath((sshScp ?? sshUrl)?.[1] ?? '')
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    return null
  }

  if (
    parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== GITHUB_HOST ||
    parsed.username !== '' || parsed.password !== '' || parsed.port !== '' || parsed.search !== '' || parsed.hash !== ''
  ) {
    return null
  }

  return parseRepositoryPath(parsed.pathname.slice(1))
}

function parseUrlRewritePrefixes(output: string) {
  if (output === '') {
    return []
  }

  if (!output.endsWith('\0')) {
    return null
  }

  const prefixes: string[] = []
  const entries = output.slice(0, -1).split('\0')

  for (const entry of entries) {
    const separator = entry.indexOf('\n')

    if (separator < 0 || !/^url\..*\.(?:push)?insteadof$/iu.test(entry.slice(0, separator))) {
      return null
    }

    prefixes.push(entry.slice(separator + 1))
  }

  return prefixes
}

function validBranchName(value: string) {
  return value !== '' && !value.startsWith('-') && !/[\u0000-\u001f\u007f]/u.test(value)
}

function parseDefaultBranch(output: string) {
  let parsed: unknown

  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }

  if (!isRecord(parsed) || !isRecord(parsed.defaultBranchRef) || typeof parsed.defaultBranchRef.name !== 'string') {
    return null
  }

  const branch = parsed.defaultBranchRef.name

  return validBranchName(branch) ? branch : null
}

function isPullRequest(value: unknown): value is PullRequest {
  return isRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.isDraft === 'boolean' &&
    typeof value.state === 'string' &&
    typeof value.headRefName === 'string' &&
    typeof value.baseRefName === 'string' &&
    (value.headRepository === null ||
      (isRecord(value.headRepository) && typeof value.headRepository.nameWithOwner === 'string'))
}

function parsePullRequests(output: string) {
  let parsed: unknown

  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }

  if (!Array.isArray(parsed) || !parsed.every(isPullRequest)) {
    return null
  }

  return parsed
}

function validPullRequestUrl(value: string, repositorySlug: string) {
  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    return false
  }

  const parts = parsed.pathname.split('/').filter((part) => part !== '')

  return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === GITHUB_HOST &&
    parsed.username === '' && parsed.password === '' && parsed.search === '' && parsed.hash === '' &&
    parts.length === 4 && parts[2] === 'pull' && /^[1-9][0-9]*$/u.test(parts[3] ?? '') &&
    `${parts[0]}/${parts[1]}`.toLowerCase() === repositorySlug.toLowerCase()
}

function pullRequestListArgs(repositoryArgument: string, branch: string) {
  return [
    'pr', 'list',
    '--repo', repositoryArgument,
    '--head', branch,
    '--state', 'all',
    '--limit', '2',
    '--json', 'url,isDraft,state,headRefName,baseRefName,headRepository'
  ]
}

async function listPullRequests(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  executable: string,
  prepared: Pick<PreparedWorktree, 'input' | 'repositoryArgument' | 'repositorySlug'>,
  options: { status: DeliveryFailure['status']; failureReason: string; stage: string; message: string }
) {
  const output = await requireGhSuccess(
    input,
    dependencies,
    executable,
    prepared.input.record.worktreePath,
    pullRequestListArgs(prepared.repositoryArgument, prepared.input.record.branch),
    options
  )
  const pullRequests = parsePullRequests(output)

  if (pullRequests === null || pullRequests.length > 1 || pullRequests.some((pullRequest) => {
    return !validPullRequestUrl(pullRequest.url, prepared.repositorySlug)
  })) {
    throw createFailure(options.status, options.failureReason, options.stage, options.message)
  }

  return pullRequests[0] ?? null
}

function isCompatibleDraft(pullRequest: PullRequest, repositorySlug: string, branch: string, baseBranch: string) {
  return pullRequest.headRepository !== null &&
    pullRequest.headRepository.nameWithOwner.toLowerCase() === repositorySlug.toLowerCase() &&
    pullRequest.state === 'OPEN' && pullRequest.isDraft &&
    pullRequest.headRefName === branch && pullRequest.baseRefName === baseBranch
}

function newWorktreeEvidence(input: DraftPrWorktreeInput): DraftPrWorktreeEvidence {
  return {
    repository: input.record.repository,
    worktreePath: input.record.worktreePath,
    branch: input.record.branch,
    draftPrStatus: 'not_attempted',
    commitSha: null,
    baseBranch: null,
    draftPrUrl: null
  }
}

function decisionFor(failureReason: string) {
  switch (failureReason) {
    case 'github_cli_unavailable':
      return 'gh CLI を PATH に追加してから Task を retry してください。'
    case 'github_auth_unavailable':
      return 'runner と同じ OS user で GitHub CLI を認証し、Task を retry してください。'
    case 'github_remote_unsupported':
      return '対象 repository の origin と push URL を github.com の同一 repository にそろえ、push URL に適用される Git の URL 書き換え設定を解消してから Task を retry してください。'
    case 'git_identity_unavailable':
      return '対象 repository に local user.name と user.email を設定してから Task を retry してください。'
    case 'github_repository_unavailable':
    case 'github_pr_lookup_failed':
      return 'GitHub repository へのアクセス状態を確認してから Task を retry してください。'
    case 'draft_pr_conflict':
      return '同じ branch の既存 PR の state と base branch を確認してから対応してください。'
    default:
      return null
  }
}

function makeResult(
  status: DraftPrDeliveryStatus,
  failureReason: string | null,
  failureDetail: string | null,
  decisionQuestion: string | null,
  worktrees: DraftPrWorktreeEvidence[]
): DraftPrDeliveryResult {
  return { status, failureReason, failureDetail, decisionQuestion, worktrees }
}

async function verifyCommitSnapshot(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  worktree: PreparedWorktree,
  commitSha: string
) {
  const record = worktree.input.record
  const committedDiff = await runGit(input, dependencies, record.worktreePath, [
    'diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--unified=3', record.baseSha, commitSha, '--'
  ])
  const committedPaths = await runGit(input, dependencies, record.worktreePath, [
    'diff', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--name-only', '-z', record.baseSha, commitSha, '--'
  ])
  const changedFiles = committedPaths.stdout.split('\0').filter((value) => value !== '').sort()
  const sections = splitGitDiffSections(committedDiff.stdout)
  const diffSha256 = sections === null ? null : hashGitDiffSnapshot(changedFiles, sections)

  if (
    committedDiff.exitCode !== 0 || committedPaths.exitCode !== 0 ||
    diffSha256 !== worktree.input.snapshotDiffSha256 ||
    JSON.stringify(changedFiles) !== JSON.stringify(worktree.input.snapshotChangedFiles)
  ) {
    throw createFailure('failed', 'draft_pr_failed', 'commit_verify', 'the committed tree does not match the verified snapshot')
  }
}

async function commitWorktree(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies,
  worktree: PreparedWorktree
) {
  const record = worktree.input.record
  const currentBranch = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'branch', message: 'the worktree branch changed after verification'
  })
  const currentHead = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--verify', 'HEAD'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'head', message: 'the worktree HEAD could not be checked'
  })

  if (currentBranch !== record.branch || currentHead !== worktree.input.headSha) {
    throw createFailure('failed', 'draft_pr_failed', 'verification_snapshot', 'the worktree changed after verification')
  }

  const status = await requireGitOutput(input, dependencies, record.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'status', message: 'the worktree status could not be checked'
  })
  const currentSnapshot = await worktree.input.readSnapshot()

  if (currentSnapshot.diffTruncated || currentSnapshot.snapshotSha256 !== worktree.input.snapshotSha256) {
    throw createFailure('failed', 'draft_pr_failed', 'verification_snapshot', 'the worktree changed after verification; delivery was skipped')
  }

  if (currentHead !== record.baseSha) {
    const parentSha = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--verify', 'HEAD^'], {
      status: 'failed', failureReason: 'draft_pr_failed', stage: 'commit_verify', message: 'the existing commit parent could not be verified'
    })
    const commitMessage = await requireGitOutput(input, dependencies, record.worktreePath, ['log', '-1', '--format=%B'], {
      status: 'failed', failureReason: 'draft_pr_failed', stage: 'commit_verify', message: 'the existing commit message could not be verified'
    })
    const arayaCommit = parentSha === record.baseSha && commitMessage.split('\n').some((line) => {
      return line.trim() === `Araya-Task: ${input.taskKey}`
    })

    if (!arayaCommit || status !== '') {
      throw createFailure('failed', 'draft_pr_failed', 'commit_verify', 'the worktree contains a commit not created by Araya for this Task')
    }

    await verifyCommitSnapshot(input, dependencies, worktree, currentHead)

    return currentHead
  }

  if (status === '') {
    throw createFailure('failed', 'draft_pr_failed', 'stage', 'the verified diff is no longer present in the worktree')
  }

  const added = await runGit(input, dependencies, record.worktreePath, ['add', '--all'])

  if (added.exitCode !== 0) {
    throw createFailure('failed', 'draft_pr_failed', 'stage', 'git add did not complete')
  }

  const stagedDiff = await runGit(input, dependencies, record.worktreePath, [
    'diff', '--cached', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--unified=3', record.baseSha, '--'
  ])
  const stagedPaths = await runGit(input, dependencies, record.worktreePath, [
    'diff', '--cached', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--name-only', '-z', record.baseSha, '--'
  ])
  const stagedChangedFiles = stagedPaths.stdout.split('\0').filter((value) => value !== '').sort()
  const stagedSections = splitGitDiffSections(stagedDiff.stdout)
  const stagedDiffSha256 = stagedSections === null ? null : hashGitDiffSnapshot(stagedChangedFiles, stagedSections)

  if (
    stagedDiff.exitCode !== 0 || stagedPaths.exitCode !== 0 ||
    stagedDiffSha256 !== worktree.input.snapshotDiffSha256 ||
    JSON.stringify(stagedChangedFiles) !== JSON.stringify(worktree.input.snapshotChangedFiles)
  ) {
    throw createFailure('failed', 'draft_pr_failed', 'stage', 'the staged tree does not match the verified snapshot')
  }

  const commit = await runGit(input, dependencies, record.worktreePath, [
    '-c', `user.name=${worktree.userName}`,
    '-c', `user.email=${worktree.userEmail}`,
    'commit',
    '-m', `Araya: ${input.taskKey}`,
    '-m', `Araya-Task: ${input.taskKey}`
  ])

  if (commit.exitCode !== 0) {
    throw createFailure('failed', 'draft_pr_failed', 'commit', 'git commit did not complete')
  }

  const commitSha = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--verify', 'HEAD'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'commit_verify', message: 'the new commit could not be verified'
  })
  const parentSha = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--verify', 'HEAD^'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'commit_verify', message: 'the new commit parent could not be verified'
  })
  const commitMessage = await requireGitOutput(input, dependencies, record.worktreePath, ['log', '-1', '--format=%B'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'commit_verify', message: 'the commit message could not be verified'
  })

  if (parentSha !== record.baseSha || !commitMessage.split('\n').some((line) => {
    return line.trim() === `Araya-Task: ${input.taskKey}`
  })) {
    throw createFailure('failed', 'draft_pr_failed', 'commit_verify', 'the commit does not match the expected Task and base revision')
  }

  await verifyCommitSnapshot(input, dependencies, worktree, commitSha)

  const cleanStatus = await requireGitOutput(input, dependencies, record.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], {
    status: 'failed', failureReason: 'draft_pr_failed', stage: 'commit_verify', message: 'the post-commit worktree status could not be checked'
  })

  if (cleanStatus !== '') {
    throw createFailure('failed', 'draft_pr_failed', 'commit_verify', 'the worktree is not clean after commit')
  }

  return commitSha
}

export async function deliverDraftPullRequests(
  input: DraftPrDeliveryInput,
  dependencies: DraftPrDeliveryDependencies
): Promise<DraftPrDeliveryResult> {
  const evidence = input.worktrees.map(newWorktreeEvidence)

  if (input.worktrees.length === 0) {
    return makeResult('completed', null, null, null, evidence)
  }

  const env = safeEnvironment(input.env)
  let ghExecutable: string

  try {
    ghExecutable = dependencies.ghExecutable ?? await findExecutable('gh', env)
  } catch (error) {
    if (!isDeliveryFailure(error)) {
      return makeResult('blocked', 'github_cli_unavailable', 'gh CLI could not be resolved', decisionFor('github_cli_unavailable'), evidence)
    }

    return makeResult('blocked', error.failureReason, error.message, decisionFor(error.failureReason), evidence)
  }

  const prepared: PreparedWorktree[] = []

  try {
    const auth = await runGh(input, dependencies, ghExecutable, input.worktrees[0]?.record.worktreePath ?? '.', ['auth', 'status', '--hostname', GITHUB_HOST])

    if (!auth.terminationConfirmed || auth.terminationReason !== undefined || auth.exitCode !== 0) {
      throw createFailure('blocked', 'github_auth_unavailable', 'auth', 'GitHub CLI authentication is unavailable')
    }

    for (const worktree of input.worktrees) {
      const { record } = worktree

      if (record.branch !== `araya/${input.taskKey}` || !validBranchName(record.branch)) {
        throw createFailure('blocked', 'github_remote_unsupported', 'branch', 'the worktree branch does not match this Task attempt')
      }

      const originUrl = await requireGitOutput(input, dependencies, record.worktreePath, ['config', '--local', '--get', 'remote.origin.url'], {
        status: 'blocked',
        failureReason: 'github_remote_unsupported',
        stage: 'origin',
        message: 'the worktree does not have a supported GitHub origin'
      })
      const pushUrlOutput = await requireGitOutput(input, dependencies, record.worktreePath, ['remote', 'get-url', '--push', '--all', 'origin'], {
        status: 'blocked',
        failureReason: 'github_remote_unsupported',
        stage: 'push_remote',
        message: 'the origin push URL is not a supported GitHub repository'
      })
      const pushUrls = pushUrlOutput.split('\n')
      const pushUrl = pushUrls.length === 1 ? pushUrls[0] : undefined
      const repositorySlug = parseGitHubRemote(originUrl)
      const pushRepositorySlug = pushUrl === undefined ? null : parseGitHubRemote(pushUrl)

      if (repositorySlug === null || pushUrl === undefined || pushRepositorySlug === null || repositorySlug.toLowerCase() !== pushRepositorySlug.toLowerCase()) {
        throw createFailure('blocked', 'github_remote_unsupported', 'origin', 'origin must point to the same github.com repository for fetch and push')
      }

      const rewriteConfiguration = await runGit(input, dependencies, record.worktreePath, [
        'config', '--null', '--get-regexp', '^url\\..*\\.(push)?insteadof$'
      ])
      const rewritePrefixes = parseUrlRewritePrefixes(rewriteConfiguration.stdout)

      if (
        (rewriteConfiguration.exitCode !== 0 && rewriteConfiguration.exitCode !== 1) ||
        (rewriteConfiguration.exitCode === 1 && rewriteConfiguration.stdout !== '') ||
        rewritePrefixes === null || rewritePrefixes.some((prefix) => pushUrl.startsWith(prefix))
      ) {
        throw createFailure('blocked', 'github_remote_unsupported', 'push_url_rewrite', 'the validated push URL is matched by a Git URL rewrite rule')
      }

      const repositoryArgument = `${GITHUB_HOST}/${repositorySlug}`
      const userName = await requireGitOutput(input, dependencies, record.worktreePath, ['config', '--local', '--get', 'user.name'], {
        status: 'blocked',
        failureReason: 'git_identity_unavailable',
        stage: 'git_identity',
        message: 'repository-local Git user.name is not configured'
      })
      const userEmail = await requireGitOutput(input, dependencies, record.worktreePath, ['config', '--local', '--get', 'user.email'], {
        status: 'blocked',
        failureReason: 'git_identity_unavailable',
        stage: 'git_identity',
        message: 'repository-local Git user.email is not configured'
      })

      if (userName === '' || userEmail === '' || /[\r\n]/u.test(userName) || /[\r\n]/u.test(userEmail)) {
        throw createFailure('blocked', 'git_identity_unavailable', 'git_identity', 'repository-local Git identity is invalid')
      }

      const repositoryResult = await runGh(input, dependencies, ghExecutable, record.worktreePath, [
        'repo', 'view', repositoryArgument, '--json', 'defaultBranchRef'
      ])

      if (!repositoryResult.terminationConfirmed || repositoryResult.terminationReason !== undefined || repositoryResult.exitCode !== 0) {
        throw createFailure('blocked', 'github_repository_unavailable', 'repository', 'GitHub repository metadata could not be read')
      }

      const baseBranch = parseDefaultBranch(repositoryResult.stdout)

      if (baseBranch === null) {
        throw createFailure('blocked', 'github_repository_unavailable', 'repository', 'GitHub did not return a valid default branch')
      }

      const validBase = await runGit(input, dependencies, record.worktreePath, ['check-ref-format', '--branch', baseBranch])

      if (validBase.exitCode !== 0) {
        throw createFailure('blocked', 'github_repository_unavailable', 'base_branch', 'GitHub returned an invalid default branch')
      }

      const preparedWorktree: PreparedWorktree = {
        input: worktree,
        repositorySlug,
        repositoryArgument,
        pushUrl,
        baseBranch,
        userName,
        userEmail,
        existingPullRequest: null
      }
      const existing = await listPullRequests(input, dependencies, ghExecutable, preparedWorktree, {
        status: 'blocked',
        failureReason: 'github_pr_lookup_failed',
        stage: 'existing_pr',
        message: 'existing pull requests could not be checked'
      })

      if (existing !== null && !isCompatibleDraft(existing, repositorySlug, record.branch, baseBranch)) {
        throw createFailure('blocked', 'draft_pr_conflict', 'existing_pr', 'an existing pull request is not an open draft for the default branch')
      }

      preparedWorktree.existingPullRequest = existing
      prepared.push(preparedWorktree)
    }
  } catch (error) {
    const failure = isDeliveryFailure(error)
      ? error
      : createFailure('blocked', 'github_repository_unavailable', 'preflight', 'GitHub delivery preflight failed')

    return makeResult('blocked', failure.failureReason, failure.message, decisionFor(failure.failureReason), evidence)
  }

  const title = input.redact(input.title).trim().replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 256)

  if (title === '') {
    return makeResult('blocked', 'invalid_pr_title', 'the redacted Task title is empty', 'Task title must contain publishable text before creating a Draft PR.', evidence)
  }

  try {
    for (const guard of input.preflightSnapshotGuards) {
      const current = await guard.readSnapshot()

      if (current.diffTruncated || current.snapshotSha256 !== guard.snapshotSha256) {
        return makeResult('failed', 'draft_pr_failed', 'verification_snapshot: a worktree changed after GitHub preflight; delivery was skipped', null, evidence)
      }
    }
  } catch {
    return makeResult('failed', 'draft_pr_failed', 'verification_snapshot: a worktree could not be revalidated after GitHub preflight; delivery was skipped', null, evidence)
  }

  for (const worktree of prepared) {
    const record = worktree.input.record
    const targetEvidence = evidence.find((entry) => entry.worktreePath === record.worktreePath)

    if (targetEvidence === undefined) {
      return makeResult('failed', 'draft_pr_failed', 'delivery evidence could not be associated with a worktree', null, evidence)
    }

    try {
      const commitSha = await commitWorktree(input, dependencies, worktree)
      targetEvidence.commitSha = commitSha
      targetEvidence.baseBranch = worktree.baseBranch
      targetEvidence.draftPrStatus = 'committed'
    } catch (error) {
      const failure = isDeliveryFailure(error)
        ? error
        : createFailure('failed', 'draft_pr_failed', 'commit', 'commit preparation failed')

      targetEvidence.draftPrStatus = 'failed'
      return makeResult('failed', 'draft_pr_failed', `${failure.stage}: ${failure.message}`, null, evidence)
    }
  }

  try {
    for (const guard of input.preflightSnapshotGuards) {
      const record = guard.record
      const committedEvidence = evidence.find((entry) => entry.worktreePath === record.worktreePath)

      if (committedEvidence === undefined) {
        const current = await guard.readSnapshot()

        if (current.diffTruncated || current.snapshotSha256 !== guard.snapshotSha256) {
          return makeResult('failed', 'draft_pr_failed', 'verification_snapshot: a worktree changed during commit preparation; remote delivery was skipped', null, evidence)
        }

        continue
      }

      const committedWorktree = prepared.find((worktree) => worktree.input.record.worktreePath === record.worktreePath)

      if (committedWorktree === undefined || committedEvidence.commitSha === null) {
        throw createFailure('failed', 'draft_pr_failed', 'verification_snapshot', 'committed worktree evidence is missing')
      }

      const currentBranch = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        status: 'failed', failureReason: 'draft_pr_failed', stage: 'verification_snapshot', message: 'the committed branch could not be revalidated'
      })
      const currentHead = await requireGitOutput(input, dependencies, record.worktreePath, ['rev-parse', '--verify', 'HEAD'], {
        status: 'failed', failureReason: 'draft_pr_failed', stage: 'verification_snapshot', message: 'the committed HEAD could not be revalidated'
      })
      const status = await requireGitOutput(input, dependencies, record.worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], {
        status: 'failed', failureReason: 'draft_pr_failed', stage: 'verification_snapshot', message: 'the committed worktree status could not be revalidated'
      })

      if (currentBranch !== record.branch || currentHead !== committedEvidence.commitSha || status !== '') {
        throw createFailure('failed', 'draft_pr_failed', 'verification_snapshot', 'a committed worktree changed during commit preparation')
      }

      await verifyCommitSnapshot(input, dependencies, committedWorktree, committedEvidence.commitSha)
    }
  } catch {
    return makeResult('failed', 'draft_pr_failed', 'verification_snapshot: a worktree could not be revalidated before remote delivery; remote delivery was skipped', null, evidence)
  }

  for (const worktree of prepared) {
    const record = worktree.input.record
    const targetEvidence = evidence.find((entry) => entry.worktreePath === record.worktreePath)

    if (targetEvidence === undefined || targetEvidence.commitSha === null) {
      return makeResult('failed', 'draft_pr_failed', 'committed evidence is missing', null, evidence)
    }

    try {
      targetEvidence.remoteSideEffectsUnconfirmed = true
      const pushed = await dependencies.runGit(dependencies.gitExecutable ?? '/usr/bin/git', [
        '-C', record.worktreePath,
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.pager=cat',
        'push', '--no-follow-tags', '--recurse-submodules=no', worktree.pushUrl, `${targetEvidence.commitSha}:refs/heads/${record.branch}`
      ], runOptions(input, record.worktreePath, GIT_TIMEOUT_MS, MAX_GIT_STDOUT_BYTES))

      if (!pushed.terminationConfirmed || pushed.terminationReason !== undefined || pushed.exitCode === null || pushed.exitCode !== 0) {
        throw createFailure('failed', 'draft_pr_failed', 'push', 'git push did not complete or its result is uncertain')
      }

      targetEvidence.remoteSideEffectsUnconfirmed = false
      targetEvidence.draftPrStatus = 'pushed'
      const afterPush = await listPullRequests(input, dependencies, ghExecutable, worktree, {
        status: 'failed',
        failureReason: 'draft_pr_failed',
        stage: 'pull_request_readback',
        message: 'the pull request state could not be read after push'
      })

      if (afterPush !== null) {
        if (!isCompatibleDraft(afterPush, worktree.repositorySlug, record.branch, worktree.baseBranch)) {
          throw createFailure('failed', 'draft_pr_failed', 'pull_request_readback', 'the existing pull request is not a matching open draft')
        }

        targetEvidence.draftPrStatus = 'reused'
        targetEvidence.draftPrUrl = afterPush.url
        continue
      }

      const body = [
        'Created by Araya after all registered verifications passed.',
        '',
        `Task: \`${input.taskKey}\``,
        `Registered verifications passed: ${worktree.input.verificationCount}.`
      ].join('\n')
      const created = await runGh(input, dependencies, ghExecutable, record.worktreePath, [
        'pr', 'create',
        '--repo', worktree.repositoryArgument,
        '--head', record.branch,
        '--base', worktree.baseBranch,
        '--draft',
        '--title', title,
        '--body-file', '-'
      ], body)

      // create の応答が失われても、GitHub の read-back で作成済み Draft PR を照合する。
      const readback = await listPullRequests(input, dependencies, ghExecutable, worktree, {
        status: 'failed',
        failureReason: 'draft_pr_failed',
        stage: 'pull_request_readback',
        message: 'the pull request state could not be verified'
      })

      if (readback === null || !isCompatibleDraft(readback, worktree.repositorySlug, record.branch, worktree.baseBranch)) {
        const stage = created.exitCode === 0 ? 'pull_request_readback' : 'create_pr'
        throw createFailure('failed', 'draft_pr_failed', stage, 'GitHub did not confirm an open draft pull request')
      }

      targetEvidence.draftPrStatus = created.exitCode === 0 ? 'created' : 'reused'
      targetEvidence.draftPrUrl = readback.url
    } catch (error) {
      const failure = isDeliveryFailure(error)
        ? error
        : createFailure('failed', 'draft_pr_failed', 'push_or_create', 'GitHub delivery did not complete')

      if (targetEvidence.draftPrStatus !== 'pushed' && targetEvidence.draftPrStatus !== 'created' && targetEvidence.draftPrStatus !== 'reused') {
        targetEvidence.draftPrStatus = 'failed'
      }

      return makeResult('failed', 'draft_pr_failed', `${failure.stage}: ${failure.message}`, null, evidence)
    }
  }

  return makeResult('completed', null, null, null, evidence)
}
