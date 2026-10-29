import fs from 'node:fs/promises'
import path from 'node:path'

import type { BoundedProcessResult, GitCommandRunner } from '../infrastructure/process.ts'

export const MAX_WORKTREES_PER_TASK = 16
export const MAX_VERIFICATIONS_PER_TASK = 32

const MAX_REPOSITORY_LENGTH = 200
const MAX_BASE_LENGTH = 200
const MAX_COMMAND_ELEMENTS = 64
const MAX_COMMAND_LENGTH = 32_768
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_ERROR_DETAIL_LENGTH = 500
const GIT_TIMEOUT_MS = 60_000
const GIT_WORKTREE_ADD_TIMEOUT_MS = 10 * 60 * 1000
const GIT_CANDIDATES = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'] as const
// `-C` で指定した repository 以外を git に操作させる環境変数は引き継がない
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
const WORKTREE_DIRECTORY = '.worktree'
const EXCLUDE_LINE = '/.worktree/'
const TASK_KEY_PATTERN = /^task-[1-9][0-9]{0,15}-[1-9][0-9]{0,15}-[a-z2-7]{6}$/u
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const WORKTREE_RECORD_KEYS = [
  'base',
  'baseSha',
  'branch',
  'createdAt',
  'excludeAdded',
  'repository',
  'repositoryRoot',
  'worktreePath'
] as const
const VERIFICATION_RECORD_KEYS = ['command', 'cwd', 'registeredAt', 'repository'] as const
const DECISION_FILE = 'decision.json'
const DECISION_RECORD_KEYS = ['question', 'requestedAt'] as const
const MAX_DECISION_QUESTION_LENGTH = 2000
const MAX_DECISION_FILE_BYTES = 64 * 1024

export type WorktreeRecord = {
  repository: string
  repositoryRoot: string
  worktreePath: string
  branch: string
  base: string
  baseSha: string
  excludeAdded: boolean
  createdAt: string
}

export type VerificationRecord = {
  repository: string
  command: string[]
  cwd: string
  registeredAt: string
}

// SHIKI が araya_request_decision で記録した、人への質問（状態 directory の decision.json）
export type DecisionRecord = {
  question: string
  requestedAt: string
}

type GitContext = {
  executable: string
  env: Record<string, string | undefined>
  run: GitCommandRunner
}

type GitResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function createError(code: string, description: string) {
  return new Error(`${code}: ${description}`)
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStrictlyWithin(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)

  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length)}...` : value
}

function validateTaskKey(taskKey: string) {
  if (typeof taskKey !== 'string' || !TASK_KEY_PATTERN.test(taskKey)) {
    throw createError('task_key_invalid', 'taskKey must be "task-<Task ID>-<attempt number>-" followed by 6 characters of a-z and 2-7')
  }
}

export async function createTaskState(dataDir: string, taskKey: string) {
  validateTaskKey(taskKey)

  const parent = path.join(dataDir, 'development')
  const stateDir = path.join(parent, taskKey)
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })

  try {
    await fs.mkdir(stateDir, { mode: 0o700 })
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw createError('task_state_already_exists', `${stateDir} already exists; previous worktrees and branches are not reused`)
    }

    throw error
  }

  // umask に左右されないように mode を明示する
  await fs.chmod(stateDir, 0o700)

  return stateDir
}

function getWorktreeName(taskKey: string) {
  return `araya-${taskKey}`
}

function getBranchName(taskKey: string) {
  return `araya/${taskKey}`
}

function validateRepository(repository: unknown) {
  if (typeof repository !== 'string' || repository === '') {
    throw createError('repository_invalid', 'repository must be a non-empty path relative to the development root')
  }

  if (repository.includes('\0')) {
    throw createError('repository_invalid', 'repository must not contain NUL')
  }

  if (repository.length > MAX_REPOSITORY_LENGTH) {
    throw createError('repository_invalid', `repository must be at most ${MAX_REPOSITORY_LENGTH} characters`)
  }

  if (path.isAbsolute(repository)) {
    throw createError('repository_invalid', 'repository must be relative to the development root, not an absolute path')
  }

  if (repository.split('/').includes('..')) {
    throw createError('repository_invalid', 'repository must not contain ".." segments')
  }

  return repository
}

function validateBase(base: unknown) {
  if (typeof base !== 'string' || base === '') {
    throw createError('base_invalid', 'base must be a non-empty git revision')
  }

  if (base.startsWith('-')) {
    throw createError('base_invalid', 'base must not start with "-"')
  }

  if (/[\0\r\n]/u.test(base)) {
    throw createError('base_invalid', 'base must not contain NUL, CR or LF')
  }

  if (base.length > MAX_BASE_LENGTH) {
    throw createError('base_invalid', `base must be at most ${MAX_BASE_LENGTH} characters`)
  }

  return base
}

function validateCommand(command: unknown) {
  if (!Array.isArray(command)) {
    throw createError('command_invalid', 'command must be an array of strings')
  }

  if (command.length === 0 || command.length > MAX_COMMAND_ELEMENTS) {
    throw createError('command_invalid', `command must have 1 to ${MAX_COMMAND_ELEMENTS} elements`)
  }

  const validated: string[] = []
  let length = 0

  for (const argument of command) {
    if (typeof argument !== 'string') {
      throw createError('command_invalid', 'every command element must be a string')
    }

    if (argument.includes('\0')) {
      throw createError('command_invalid', 'command elements must not contain NUL')
    }

    length += argument.length
    validated.push(argument)
  }

  if (length > MAX_COMMAND_LENGTH) {
    throw createError('command_invalid', `command must be at most ${MAX_COMMAND_LENGTH} characters in total`)
  }

  return validated
}

function validateCwd(cwd: unknown) {
  if (cwd === undefined) {
    return ''
  }

  if (typeof cwd !== 'string') {
    throw createError('cwd_invalid', 'cwd must be a string relative to the worktree root')
  }

  if (cwd.includes('\0')) {
    throw createError('cwd_invalid', 'cwd must not contain NUL')
  }

  if (path.isAbsolute(cwd)) {
    throw createError('cwd_invalid', 'cwd must be relative to the worktree root, not an absolute path')
  }

  if (cwd.split('/').includes('..')) {
    throw createError('cwd_invalid', 'cwd must not contain ".." segments')
  }

  const normalized = path.posix.normalize(cwd).replace(/\/+$/u, '')

  return normalized === '.' ? '' : normalized
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

  throw createError('git_executable_unavailable', `git was not found in ${GIT_CANDIDATES.join(', ')}`)
}

function createGitEnv(env: Readonly<Record<string, string | undefined>>) {
  const gitEnv: Record<string, string | undefined> = { ...env, GIT_TERMINAL_PROMPT: '0' }

  for (const key of GIT_REPOSITORY_ENV_KEYS) {
    delete gitEnv[key]
  }

  return gitEnv
}

async function runGit(
  git: GitContext,
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; acceptedExitCodes?: readonly number[] } = {}
) {
  const acceptedExitCodes = options.acceptedExitCodes ?? [0]
  const description = `git ${truncate(args.join(' '), MAX_ERROR_DETAIL_LENGTH)}`
  let result: BoundedProcessResult

  try {
    result = await git.run(git.executable, ['-C', cwd, ...args], {
      env: git.env,
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
      // timeout と出力の上限では、猶予を置かずに SIGKILL まで進める
      terminationGraceMs: 0,
      stdout: { mode: 'strict', limitBytes: MAX_GIT_OUTPUT_BYTES },
      stderr: { mode: 'tail', limitBytes: MAX_GIT_OUTPUT_BYTES }
    })
  } catch (error) {
    throw createError('git_command_failed', `${description} failed (${error instanceof Error ? error.message : String(error)})`)
  }

  const { exitCode, signal, terminationReason, terminationConfirmed } = result

  if (terminationConfirmed && terminationReason === undefined && signal === null && exitCode !== null && acceptedExitCodes.includes(exitCode)) {
    const gitResult: GitResult = { exitCode, stdout: result.stdout, stderr: result.stderr }

    return gitResult
  }

  const reason = !terminationConfirmed
    ? 'termination could not be confirmed'
    : terminationReason === 'invalid_utf8'
      ? 'printed output that is not valid UTF-8'
      : terminationReason !== undefined
        ? 'was killed (timeout or output limit)'
        : exitCode !== null
          ? `exited with ${exitCode}`
          : `was killed by ${signal ?? 'a signal'}`
  const detail = result.stderr.trim() === '' ? '' : `: ${truncate(result.stderr.trim(), MAX_ERROR_DETAIL_LENGTH)}`

  throw createError('git_command_failed', `${description} ${reason}${detail}`)
}

async function resolveDevRoot(devRoot: string) {
  try {
    const devRootReal = await fs.realpath(devRoot)
    const stat = await fs.stat(devRootReal)

    if (stat.isDirectory()) {
      return devRootReal
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
      throw error
    }
  }

  throw createError('dev_root_missing', `development root ${devRoot} is not a directory`)
}

// repository の指定を開発 root 内の realpath に解決する
async function resolveRepositoryPath(devRootReal: string, repository: string) {
  let repositoryReal: string

  try {
    repositoryReal = await fs.realpath(path.resolve(devRootReal, repository))
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      throw createError('repository_not_found', `${repository} does not exist under the development root`)
    }

    throw error
  }

  if (repositoryReal === devRootReal) {
    throw createError('repository_is_dev_root', 'repository must be a repository under the development root, not the root itself')
  }

  if (!isStrictlyWithin(repositoryReal, devRootReal)) {
    throw createError('repository_outside_dev_root', `${repository} resolves to ${repositoryReal}, outside the development root`)
  }

  return repositoryReal
}

async function verifyMainWorkingTree(git: GitContext, repository: string, repositoryReal: string) {
  const stat = await fs.stat(repositoryReal)

  if (!stat.isDirectory()) {
    throw createError('repository_not_directory', `${repository} is not a directory`)
  }

  const toplevel = await runGit(git, repositoryReal, ['rev-parse', '--show-toplevel'], { acceptedExitCodes: [0, 128] })

  if (toplevel.exitCode !== 0) {
    throw createError('repository_not_git', `${repository} is not inside a git working tree`)
  }

  if (await fs.realpath(toplevel.stdout.trim()) !== repositoryReal) {
    throw createError('repository_not_git_root', `${repository} is not the root of a git working tree; use the repository root`)
  }

  const gitDir = await runGit(git, repositoryReal, ['rev-parse', '--absolute-git-dir'])
  const commonDir = await runGit(git, repositoryReal, ['rev-parse', '--git-common-dir'])
  const gitDirReal = await fs.realpath(gitDir.stdout.trim())
  const commonDirReal = await fs.realpath(path.resolve(repositoryReal, commonDir.stdout.trim()))

  if (gitDirReal !== commonDirReal) {
    throw createError('repository_is_linked_worktree', `${repository} is a linked worktree; use the main clone of the repository`)
  }
}

async function resolveBaseSha(git: GitContext, repositoryReal: string, base: string) {
  const result = await runGit(git, repositoryReal, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
    acceptedExitCodes: [0, 1]
  })
  const sha = result.stdout.trim()

  if (result.exitCode !== 0 || sha === '') {
    throw createError('base_not_found', `base ${JSON.stringify(base)} does not resolve to a commit; fetch it first or use another ref`)
  }

  if (!SHA_PATTERN.test(sha)) {
    throw createError('base_not_found', `base ${JSON.stringify(base)} resolved to an unexpected value`)
  }

  return sha
}

async function pathExists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return false
    }

    throw error
  }
}

// `.worktree` があれば実体の directory であることを確かめ、存在するかを返す
async function inspectWorktreeDirectory(repositoryReal: string) {
  const directory = path.join(repositoryReal, WORKTREE_DIRECTORY)
  let stat

  try {
    stat = await fs.lstat(directory)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return false
    }

    throw error
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw createError('worktree_directory_invalid', `${directory} exists but is not a real directory (symlink or file)`)
  }

  return true
}

async function isWorktreeIgnored(git: GitContext, repositoryReal: string, worktreeName: string) {
  const result = await runGit(git, repositoryReal, ['check-ignore', '-q', `${WORKTREE_DIRECTORY}/${worktreeName}`], {
    acceptedExitCodes: [0, 1]
  })

  return result.exitCode === 0
}

async function appendExcludeLine(git: GitContext, repositoryReal: string) {
  const result = await runGit(git, repositoryReal, ['rev-parse', '--git-path', 'info/exclude'])
  const excludePath = path.resolve(repositoryReal, result.stdout.trim())
  let existing = ''

  try {
    existing = await fs.readFile(excludePath, 'utf8')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  await fs.mkdir(path.dirname(excludePath), { recursive: true })
  const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
  await fs.appendFile(excludePath, `${separator}${EXCLUDE_LINE}\n`, 'utf8')
}

async function readJsonLines(filePath: string) {
  let content: string

  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return []
    }

    throw error
  }

  const name = path.basename(filePath)
  const lines = content.split('\n')

  if (lines.at(-1) === '') {
    lines.pop()
  }

  const values: unknown[] = []

  for (const [index, line] of lines.entries()) {
    try {
      values.push(JSON.parse(line))
    } catch {
      throw createError('task_state_invalid', `${name} line ${index + 1} is not valid JSON`)
    }
  }

  return values
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()

  return actual.length === expected.length && actual.every((key, index) => {
    return key === expected[index]
  })
}

function parseWorktreeRecord(value: unknown, devRootReal: string, taskKey: string, line: number) {
  const where = `worktrees.jsonl line ${line}`

  if (!isRecord(value) || !hasExactKeys(value, WORKTREE_RECORD_KEYS)) {
    throw createError('task_state_invalid', `${where} does not have the worktree record keys`)
  }

  const { repository, repositoryRoot, worktreePath, branch, base, baseSha, excludeAdded, createdAt } = value

  if (
    typeof repository !== 'string' ||
    typeof repositoryRoot !== 'string' ||
    typeof worktreePath !== 'string' ||
    typeof branch !== 'string' ||
    typeof base !== 'string' ||
    typeof baseSha !== 'string' ||
    typeof excludeAdded !== 'boolean' ||
    typeof createdAt !== 'string'
  ) {
    throw createError('task_state_invalid', `${where} has a value of the wrong type`)
  }

  if (
    !path.isAbsolute(repositoryRoot) ||
    path.resolve(repositoryRoot) !== repositoryRoot ||
    !isStrictlyWithin(repositoryRoot, devRootReal)
  ) {
    throw createError('task_state_invalid', `${where} repositoryRoot is not inside the development root`)
  }

  if (repository !== path.relative(devRootReal, repositoryRoot)) {
    throw createError('task_state_invalid', `${where} repository does not match repositoryRoot`)
  }

  if (worktreePath !== path.join(repositoryRoot, WORKTREE_DIRECTORY, getWorktreeName(taskKey))) {
    throw createError('task_state_invalid', `${where} worktreePath is not the task worktree path`)
  }

  if (branch !== getBranchName(taskKey)) {
    throw createError('task_state_invalid', `${where} branch is not the task branch`)
  }

  if (!SHA_PATTERN.test(baseSha)) {
    throw createError('task_state_invalid', `${where} baseSha is not a commit SHA`)
  }

  const record: WorktreeRecord = {
    repository,
    repositoryRoot,
    worktreePath,
    branch,
    base,
    baseSha,
    excludeAdded,
    createdAt
  }

  return record
}

function parseVerificationRecord(value: unknown, worktrees: readonly WorktreeRecord[], line: number) {
  const where = `verifications.jsonl line ${line}`

  if (!isRecord(value) || !hasExactKeys(value, VERIFICATION_RECORD_KEYS)) {
    throw createError('task_state_invalid', `${where} does not have the verification record keys`)
  }

  const { repository, command, cwd, registeredAt } = value

  if (typeof repository !== 'string' || typeof cwd !== 'string' || typeof registeredAt !== 'string') {
    throw createError('task_state_invalid', `${where} has a value of the wrong type`)
  }

  if (!worktrees.some((worktree) => {
    return worktree.repository === repository
  })) {
    throw createError('task_state_invalid', `${where} refers to a repository without a recorded worktree`)
  }

  let validatedCommand: string[]

  try {
    validatedCommand = validateCommand(command)
    validateCwd(cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw createError('task_state_invalid', `${where} is invalid (${message})`)
  }

  const record: VerificationRecord = { repository, command: validatedCommand, cwd, registeredAt }

  return record
}

// 記録した path が symlink を経由して別の場所（開発 root の外を含む）を指していないことを確かめる。
// 本当に消えた path だけは、ここでは扱わず差分の収集で evidence_collection_failed にする
async function verifyRecordedPath(target: string, where: string) {
  let real: string

  try {
    real = await fs.realpath(target)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      await verifyMissingPath(target, where)
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    throw createError('task_state_invalid', `${where} ${target} cannot be resolved (${message})`)
  }

  if (real !== target) {
    throw createError('task_state_invalid', `${where} ${target} resolves to ${real}; recorded paths must not go through symlinks`)
  }
}

async function lstatIfExists(target: string) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      return undefined
    }

    throw error
  }
}

// realpath が解決できない path は、存在する最も近い祖先が symlink を経由しない実体の directory のときだけ「消えた」とみなす。
// 壊れた symlink や、directory を置き換えた file は記録の改ざんとして扱う
async function verifyMissingPath(target: string, where: string) {
  let current = target
  let stat = await lstatIfExists(current)

  while (stat === undefined && path.dirname(current) !== current) {
    current = path.dirname(current)
    stat = await lstatIfExists(current)
  }

  const real = await fs.realpath(current).catch(() => {
    return undefined
  })

  if (stat === undefined || !stat.isDirectory() || real !== current) {
    throw createError('task_state_invalid', `${where} ${target} cannot be resolved, and ${current} is not a real directory (for example, a dangling symlink)`)
  }
}

async function readValidatedState(devRootReal: string, stateDir: string, taskKey: string) {
  const worktrees: WorktreeRecord[] = []
  const repositoryRoots = new Set<string>()

  for (const [index, value] of (await readJsonLines(path.join(stateDir, 'worktrees.jsonl'))).entries()) {
    const record = parseWorktreeRecord(value, devRootReal, taskKey, index + 1)

    if (repositoryRoots.has(record.repositoryRoot)) {
      throw createError('task_state_invalid', `worktrees.jsonl line ${index + 1} duplicates repositoryRoot ${record.repositoryRoot}`)
    }

    await verifyRecordedPath(record.repositoryRoot, `worktrees.jsonl line ${index + 1} repositoryRoot`)
    await verifyRecordedPath(record.worktreePath, `worktrees.jsonl line ${index + 1} worktreePath`)
    repositoryRoots.add(record.repositoryRoot)
    worktrees.push(record)
  }

  if (worktrees.length > MAX_WORKTREES_PER_TASK) {
    throw createError('task_state_invalid', `worktrees.jsonl has more than ${MAX_WORKTREES_PER_TASK} records`)
  }

  const verifications: VerificationRecord[] = []

  for (const [index, value] of (await readJsonLines(path.join(stateDir, 'verifications.jsonl'))).entries()) {
    verifications.push(parseVerificationRecord(value, worktrees, index + 1))
  }

  if (verifications.length > MAX_VERIFICATIONS_PER_TASK) {
    throw createError('task_state_invalid', `verifications.jsonl has more than ${MAX_VERIFICATIONS_PER_TASK} records`)
  }

  return { worktrees, verifications }
}

export async function readTaskState(options: { devRoot: string; stateDir: string; taskKey: string }) {
  validateTaskKey(options.taskKey)

  return readValidatedState(await resolveDevRoot(options.devRoot), options.stateDir, options.taskKey)
}

export function validateDecisionQuestion(question: unknown) {
  if (
    typeof question !== 'string' ||
    !/\S/u.test(question) ||
    question.length > MAX_DECISION_QUESTION_LENGTH ||
    question.includes('\0')
  ) {
    throw createError('question_invalid', `question must be a string of at most ${MAX_DECISION_QUESTION_LENGTH} characters with a non-whitespace character and without NUL`)
  }

  return question
}

// 人への質問を decision.json に記録する。2回目以降は失敗にして、最初の質問を残す。
// 一時 file に書いてから link するので、書きかけの decision.json は残らない
export async function recordDecision(stateDir: string, question: unknown, now: Date) {
  const record: DecisionRecord = { question: validateDecisionQuestion(question), requestedAt: now.toISOString() }
  const target = path.join(stateDir, DECISION_FILE)
  const temporary = path.join(stateDir, `.${DECISION_FILE}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })

  try {
    await fs.link(temporary, target)
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw createError('decision_already_requested', 'a question has already been recorded for this task; the first question is kept')
    }

    throw error
  } finally {
    await fs.rm(temporary, { force: true })
  }

  return record
}

// decision.json を読む。無ければ null。形式が不正なら task_state_invalid
export async function readDecision(stateDir: string) {
  const target = path.join(stateDir, DECISION_FILE)
  let stat

  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null
    }

    throw error
  }

  if (!stat.isFile() || stat.size > MAX_DECISION_FILE_BYTES) {
    throw createError('task_state_invalid', `${DECISION_FILE} must be a regular file of at most ${MAX_DECISION_FILE_BYTES} bytes`)
  }

  let value: unknown

  try {
    value = JSON.parse(await fs.readFile(target, 'utf8'))
  } catch {
    throw createError('task_state_invalid', `${DECISION_FILE} is not valid JSON`)
  }

  if (!isRecord(value) || !hasExactKeys(value, DECISION_RECORD_KEYS) || typeof value.requestedAt !== 'string') {
    throw createError('task_state_invalid', `${DECISION_FILE} must have exactly ${DECISION_RECORD_KEYS.join(', ')}`)
  }

  try {
    const record: DecisionRecord = { question: validateDecisionQuestion(value.question), requestedAt: value.requestedAt }

    return record
  } catch {
    throw createError('task_state_invalid', `${DECISION_FILE} has an invalid question`)
  }
}

async function appendRecord(filePath: string, record: WorktreeRecord | VerificationRecord) {
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function sameCommand(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((argument, index) => {
    return argument === right[index]
  })
}

export function createWorktreeService(options: {
  devRoot: string
  stateDir: string
  taskKey: string
  env: Readonly<Record<string, string | undefined>>
  // git を起動する関数。runner は試行の scope の中で起動する関数を渡す
  runGit: GitCommandRunner
  now?: () => Date
}) {
  validateTaskKey(options.taskKey)

  const { stateDir, taskKey } = options
  const now = options.now ?? (() => {
    return new Date()
  })
  const gitEnv = createGitEnv(options.env)
  const worktreeName = getWorktreeName(taskKey)
  const branch = getBranchName(taskKey)
  let gitExecutable: Promise<string> | undefined
  let tail: Promise<void> = Promise.resolve()

  // agent が tool を並列に呼んでも記録の読み書きが重ならないように直列化する
  function runExclusive<T>(task: () => Promise<T>) {
    const result = tail.then(task)
    tail = result.then(() => {}, () => {})
    return result
  }

  async function getGit() {
    gitExecutable ??= findGitExecutable()

    try {
      const git: GitContext = { executable: await gitExecutable, env: gitEnv, run: options.runGit }

      return git
    } catch (error) {
      gitExecutable = undefined
      throw error
    }
  }

  async function createWorktree(input: { repository: string; base?: string }) {
    const repository = validateRepository(input.repository)
    const base = validateBase(input.base ?? 'HEAD')
    const devRootReal = await resolveDevRoot(options.devRoot)
    const repositoryReal = await resolveRepositoryPath(devRootReal, repository)
    const state = await readValidatedState(devRootReal, stateDir, taskKey)
    const recorded = state.worktrees.find((worktree) => {
      return worktree.repositoryRoot === repositoryReal
    })

    if (recorded !== undefined) {
      return recorded
    }

    const relative = path.relative(devRootReal, repositoryReal)

    if (repository.split('/').includes(WORKTREE_DIRECTORY) || repositoryReal.split(path.sep).includes(WORKTREE_DIRECTORY)) {
      throw createError('repository_in_worktree_directory', `${repository} is inside a ${WORKTREE_DIRECTORY} directory; use the main clone`)
    }

    if (state.worktrees.length >= MAX_WORKTREES_PER_TASK) {
      throw createError('worktree_limit_reached', `this task already has ${MAX_WORKTREES_PER_TASK} worktrees`)
    }

    const git = await getGit()
    await verifyMainWorkingTree(git, repository, repositoryReal)
    const baseSha = await resolveBaseSha(git, repositoryReal, base)
    const tracked = await runGit(git, repositoryReal, ['ls-files', '-z', '--', WORKTREE_DIRECTORY])

    if (tracked.stdout !== '') {
      throw createError('worktree_directory_tracked', `${relative} tracks files under ${WORKTREE_DIRECTORY}/, so it cannot hold task worktrees`)
    }

    const worktreeDirectoryExists = await inspectWorktreeDirectory(repositoryReal)
    const worktreePath = path.join(repositoryReal, WORKTREE_DIRECTORY, worktreeName)

    if (worktreeDirectoryExists && await pathExists(worktreePath)) {
      throw createError('worktree_path_exists', `${worktreePath} already exists but is not recorded for this task; it is not reused`)
    }

    const branchRef = await runGit(git, repositoryReal, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      acceptedExitCodes: [0, 1]
    })

    if (branchRef.exitCode === 0) {
      throw createError('worktree_branch_exists', `branch ${branch} already exists in ${relative} but is not recorded for this task; it is not reused`)
    }

    if (!worktreeDirectoryExists) {
      await fs.mkdir(path.join(repositoryReal, WORKTREE_DIRECTORY))
    }

    let excludeAdded = false

    if (!await isWorktreeIgnored(git, repositoryReal, worktreeName)) {
      await appendExcludeLine(git, repositoryReal)
      excludeAdded = true

      if (!await isWorktreeIgnored(git, repositoryReal, worktreeName)) {
        throw createError('worktree_directory_not_ignored', `${WORKTREE_DIRECTORY}/ is still not ignored in ${relative} after adding ${EXCLUDE_LINE} to info/exclude`)
      }
    }

    await runGit(git, repositoryReal, ['worktree', 'add', '-b', branch, worktreePath, baseSha], {
      timeoutMs: GIT_WORKTREE_ADD_TIMEOUT_MS
    })

    const record: WorktreeRecord = {
      repository: relative,
      repositoryRoot: repositoryReal,
      worktreePath,
      branch,
      base,
      baseSha,
      excludeAdded,
      createdAt: now().toISOString()
    }
    await appendRecord(path.join(stateDir, 'worktrees.jsonl'), record)

    return record
  }

  async function registerVerification(input: { repository: string; command: string[]; cwd?: string }) {
    const repository = validateRepository(input.repository)
    const command = validateCommand(input.command)
    const cwd = validateCwd(input.cwd)
    const devRootReal = await resolveDevRoot(options.devRoot)
    const repositoryReal = await resolveRepositoryPath(devRootReal, repository)
    const state = await readValidatedState(devRootReal, stateDir, taskKey)
    const worktree = state.worktrees.find((candidate) => {
      return candidate.repositoryRoot === repositoryReal
    })

    if (worktree === undefined) {
      throw createError('worktree_not_created', `no worktree was created for ${repository} in this task; call araya_create_worktree first`)
    }

    const duplicate = state.verifications.find((verification) => {
      return verification.repository === worktree.repository &&
        verification.cwd === cwd &&
        sameCommand(verification.command, command)
    })

    if (duplicate !== undefined) {
      return duplicate
    }

    if (state.verifications.length >= MAX_VERIFICATIONS_PER_TASK) {
      throw createError('verification_limit_reached', `this task already has ${MAX_VERIFICATIONS_PER_TASK} verification commands`)
    }

    const record: VerificationRecord = {
      repository: worktree.repository,
      command,
      cwd,
      registeredAt: now().toISOString()
    }
    await appendRecord(path.join(stateDir, 'verifications.jsonl'), record)

    return record
  }

  return {
    createWorktree: (input: { repository: string; base?: string }) => {
      return runExclusive(() => {
        return createWorktree(input)
      })
    },
    registerVerification: (input: { repository: string; command: string[]; cwd?: string }) => {
      return runExclusive(() => {
        return registerVerification(input)
      })
    }
  }
}
