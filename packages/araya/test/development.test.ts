import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildWorktreeOnlyEvidence, collectDevelopmentResult, type AgentOutcome } from '../src/development/result.ts'
import {
  runBoundedCommand,
  runVerificationCommand,
  VERIFICATION_OUTPUT_BYTES,
  type GitCommandRunner,
  type VerificationCommandInput,
  type VerificationCommandResult
} from '../src/infrastructure/process.ts'
import { createTaskState, createWorktreeService, recordDecision } from '../src/development/worktrees.ts'
import { createRedactor, type Redactor } from '../src/infrastructure/redaction.ts'

const TASK_KEY = 'task-1-1-abcdef'
const PASS_COMMAND = [process.execPath, '-e', "console.log('verified')"]
const FAIL_COMMAND = [process.execPath, '-e', "console.error('broken'); process.exit(1)"]
const AGENT_MODEL = { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'medium', source: 'pi-settings' } as const

type Fixture = Awaited<ReturnType<typeof createFixture>>

// SHIKI の作業に渡る値
type WorkInput = {
  devRoot: string
  stateDir: string
  taskKey: string
  env: Readonly<Record<string, string | undefined>>
}

async function createFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-test-')))
  const home = path.join(root, 'home')
  const gitConfig = path.join(home, 'gitconfig')
  const devRoot = path.join(root, 'dev')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.writeFile(gitConfig, '', 'utf8')
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Araya Test',
    GIT_AUTHOR_EMAIL: 'araya-test@example.invalid',
    GIT_COMMITTER_NAME: 'Araya Test',
    GIT_COMMITTER_EMAIL: 'araya-test@example.invalid'
  }

  return { root, devRoot, dataDir, env }
}

async function removeFixture(fixture: Fixture) {
  await fs.rm(fixture.root, { recursive: true, force: true })
}

function git(fixture: Fixture, cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createRepository(fixture: Fixture, name: string) {
  const repositoryPath = path.join(fixture.devRoot, name)
  await fs.mkdir(repositoryPath)
  git(fixture, repositoryPath, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# fixture\n', 'utf8')
  git(fixture, repositoryPath, 'add', '--all')
  git(fixture, repositoryPath, 'commit', '-q', '-m', 'initial fixture')

  return repositoryPath
}

function completed(summary: string) {
  const agent: AgentOutcome = { status: 'completed', summary, model: AGENT_MODEL }

  return agent
}

// 状態 directory を作り、SHIKI の作業（work）を再現してから、差分を集めて判定する
async function runTask(
  fixture: Fixture,
  work: (input: WorkInput) => Promise<AgentOutcome>,
  options: {
    verificationTimeoutMs?: number
    runVerification?: (input: VerificationCommandInput & { index: number }) => Promise<VerificationCommandResult>
    gitExecutable?: string
    signal?: AbortSignal
    redactor?: Pick<Redactor, 'redact' | 'redactTruncated'>
    draftPrDelivery?: boolean
    runDeliveryGit?: GitCommandRunner
    runGitHub?: GitCommandRunner
  } = {}
) {
  const stateDir = await createTaskState(fixture.dataDir, TASK_KEY)
  const agent = await work({ devRoot: fixture.devRoot, stateDir, taskKey: TASK_KEY, env: fixture.env })

  return collectDevelopmentResult({
    taskKey: TASK_KEY,
    title: 'fixture Task',
    draftPrDelivery: options.draftPrDelivery ?? false,
    devRoot: fixture.devRoot,
    stateDir,
    agent,
    env: fixture.env,
    verificationTimeoutMs: options.verificationTimeoutMs ?? 10_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    redact: options.redactor?.redact ?? noRedaction,
    redactTruncated: options.redactor?.redactTruncated ?? noRedaction
  }, {
    runGit: runBoundedCommand,
    runVerification: options.runVerification ?? runVerificationCommand,
    ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable }),
    ...(options.runDeliveryGit === undefined ? {} : { runDeliveryGit: options.runDeliveryGit }),
    ...(options.runGitHub === undefined ? {} : { runGitHub: options.runGitHub })
  })
}

// 秘密の置き換えは runner の test で確かめる。ここでは置き換えない
function noRedaction(text: string) {
  return text
}

function serviceFor(input: WorkInput) {
  return createWorktreeService({
    devRoot: input.devRoot,
    stateDir: input.stateDir,
    taskKey: input.taskKey,
    env: input.env,
    runGit: runBoundedCommand
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecords(value: unknown, name: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is not an array`)
  }

  const records: Record<string, unknown>[] = []

  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error(`${name} contains a non-object`)
    }

    records.push(item)
  }

  return records
}

function readWorktrees(evidence: Record<string, unknown>) {
  return readRecords(evidence.worktrees, 'worktrees')
}

function findWorktree(evidence: Record<string, unknown>, repository: string) {
  const worktree = readWorktrees(evidence).find((candidate) => {
    return candidate.repository === repository
  })

  if (worktree === undefined) {
    throw new Error(`no evidence for ${repository}`)
  }

  return worktree
}

function readVerifications(worktree: Record<string, unknown>) {
  return readRecords(worktree.verifications, 'verifications')
}

function worktreePathOf(repositoryPath: string) {
  return path.join(repositoryPath, '.worktree', `araya-${TASK_KEY}`)
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

async function assertWorktreeKept(fixture: Fixture, repositoryPath: string) {
  assert.equal(git(fixture, repositoryPath, 'rev-parse', '--verify', '--quiet', `refs/heads/araya/${TASK_KEY}`).length > 0, true)
  assert.equal(git(fixture, repositoryPath, 'worktree', 'list', '--porcelain').includes(worktreePathOf(repositoryPath)), true)
}

// worktree を作り、README を書き換えて、検証を登録する偽の SHIKI の手順
async function changeRepository(input: WorkInput, repository: string, options: { command?: string[]; cwd?: string } = {}) {
  const service = serviceFor(input)
  const record = await service.createWorktree({ repository })
  await fs.appendFile(path.join(record.worktreePath, 'README.md'), `${repository} changed\n`, 'utf8')

  if (options.command !== undefined) {
    await service.registerVerification({
      repository,
      command: options.command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    })
  }

  return record
}

test('collectDevelopmentResult: 検証が作業 tree を変えた場合は delivery を止める', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  let deliveryCalls = 0

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })

      return completed('変更しました。')
    }, {
      draftPrDelivery: true,
      runVerification: async ({ cwd }) => {
        await fs.appendFile(path.join(cwd, 'README.md'), 'verification mutation\n', 'utf8')

        return {
          status: 'passed',
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          terminationConfirmed: true
        }
      },
      runGitHub: async () => {
        deliveryCalls += 1
        throw new Error('delivery must not start')
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.equal(result.evidence.failureDetail, 'the worktree changed during verification or its final diff could not be captured completely; delivery was skipped')
    assert.equal(deliveryCalls, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 検証が当初 clean な別 repository を変更した場合は delivery を止める', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  let cleanWorktreePath = ''
  let deliveryCalls = 0

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      const clean = await serviceFor(input).createWorktree({ repository: 'repo-b' })
      cleanWorktreePath = clean.worktreePath

      return completed('repo-a を変更しました。')
    }, {
      draftPrDelivery: true,
      runVerification: async () => {
        await fs.writeFile(path.join(cleanWorktreePath, 'verification-output.txt'), 'unverified change\n', 'utf8')

        return {
          status: 'passed',
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          terminationConfirmed: true
        }
      },
      runGitHub: async () => {
        deliveryCalls += 1
        throw new Error('delivery must not start')
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.equal(result.evidence.failureDetail, 'the worktree changed during verification or its final diff could not be captured completely; delivery was skipped')
    assert.deepEqual(findWorktree(result.evidence, 'repo-b').changedFiles, [])
    assert.equal(await fs.readFile(path.join(cleanWorktreePath, 'verification-output.txt'), 'utf8'), 'unverified change\n')
    assert.equal(deliveryCalls, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: GitHub preflight 中に clean worktree が変わった場合は delivery を止める', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  const cleanWorktreePath = worktreePathOf(path.join(fixture.devRoot, 'repo-b'))
  const deliveryWrites: string[][] = []
  let preflightMutationCount = 0
  const response = (stdout = '') => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true
  })

  git(fixture, repoA, 'config', '--local', 'user.name', 'Araya Test')
  git(fixture, repoA, 'config', '--local', 'user.email', 'araya-test@example.invalid')
  git(fixture, repoA, 'remote', 'add', 'origin', 'https://github.com/example/repo.git')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      const clean = await serviceFor(input).createWorktree({ repository: 'repo-b' })
      assert.equal(clean.worktreePath, cleanWorktreePath)
      return completed('repo-a を変更しました。')
    }, {
      draftPrDelivery: true,
      runGitHub: async (_command, args) => {
        if (args[0] === 'auth' && args[1] === 'status') {
          await fs.writeFile(path.join(cleanWorktreePath, 'preflight-output.txt'), 'unverified change\n', 'utf8')
          preflightMutationCount += 1
          return response()
        }

        if (args[0] === 'repo' && args[1] === 'view') {
          return response(JSON.stringify({ defaultBranchRef: { name: 'main' } }))
        }

        if (args[0] === 'pr' && args[1] === 'list') {
          return response('[]')
        }

        return response()
      },
      runDeliveryGit: async (command, args, options) => {
        if (args.includes('commit') || args.includes('push')) {
          deliveryWrites.push([...args])
          return response()
        }

        return runBoundedCommand(command, args, options)
      }
    })

    assert.equal(preflightMutationCount, 1)
    assert.equal(result.status, 'failed')
    assert.equal(await fs.readFile(path.join(cleanWorktreePath, 'preflight-output.txt'), 'utf8'), 'unverified change\n')
    assert.equal(deliveryWrites.length, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: another clean worktree changes during commit preparation, so no push starts', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  const cleanWorktreePath = worktreePathOf(path.join(fixture.devRoot, 'repo-b'))
  const deliveryWrites: string[][] = []
  let commitMutationCount = 0
  const response = (stdout = '') => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true
  })

  git(fixture, repoA, 'config', '--local', 'user.name', 'Araya Test')
  git(fixture, repoA, 'config', '--local', 'user.email', 'araya-test@example.invalid')
  git(fixture, repoA, 'remote', 'add', 'origin', 'https://github.com/example/repo.git')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      const clean = await serviceFor(input).createWorktree({ repository: 'repo-b' })
      assert.equal(clean.worktreePath, cleanWorktreePath)
      return completed('repo-a を変更しました。')
    }, {
      draftPrDelivery: true,
      runGitHub: async (_command, args) => {
        if (args[0] === 'repo' && args[1] === 'view') {
          return response(JSON.stringify({ defaultBranchRef: { name: 'main' } }))
        }

        if (args[0] === 'pr' && args[1] === 'list') {
          return response('[]')
        }

        return response()
      },
      runDeliveryGit: async (command, args, options) => {
        if (args.includes('commit')) {
          await fs.writeFile(path.join(cleanWorktreePath, 'commit-output.txt'), 'unverified change\n', 'utf8')
          commitMutationCount += 1
        }

        if (args.includes('push')) {
          deliveryWrites.push([...args])
          return response()
        }

        return runBoundedCommand(command, args, options)
      }
    })

    assert.equal(commitMutationCount, 1)
    assert.equal(result.status, 'failed')
    assert.equal(await fs.readFile(path.join(cleanWorktreePath, 'commit-output.txt'), 'utf8'), 'unverified change\n')
    assert.equal(deliveryWrites.length, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: diff.ignoreSubmodules=all の verifier が gitlink を変えても見落とさない', async () => {
  const fixture = await createFixture()
  const repository = await createRepository(fixture, 'repo-a')
  const submoduleRepository = path.join(fixture.root, 'submodule-source')
  await fs.mkdir(submoduleRepository)
  git(fixture, submoduleRepository, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(submoduleRepository, 'README.md'), 'submodule base\n', 'utf8')
  git(fixture, submoduleRepository, 'add', '--all')
  git(fixture, submoduleRepository, 'commit', '-q', '-m', 'submodule base')
  const initialSubmoduleSha = git(fixture, submoduleRepository, 'rev-parse', 'HEAD')
  await fs.appendFile(path.join(submoduleRepository, 'README.md'), 'submodule later\n', 'utf8')
  git(fixture, submoduleRepository, 'add', '--all')
  git(fixture, submoduleRepository, 'commit', '-q', '-m', 'submodule later')
  git(fixture, repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleRepository, 'vendor')
  git(fixture, repository, 'add', '--all')
  git(fixture, repository, 'commit', '-q', '-m', 'add submodule fixture')
  git(fixture, repository, 'config', '--local', 'diff.ignoreSubmodules', 'all')
  let deliveryCalls = 0
  let stagedSubmoduleHidden = false

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return completed('通常 file と submodule を変更しました。')
    }, {
      draftPrDelivery: true,
      runVerification: async ({ cwd }) => {
        git(fixture, cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet', 'vendor')
        git(fixture, path.join(cwd, 'vendor'), 'checkout', initialSubmoduleSha)
        git(fixture, cwd, 'add', 'vendor')
        stagedSubmoduleHidden = git(fixture, cwd, 'diff', '--cached', '--name-only').length === 0

        return {
          status: 'passed',
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          terminationConfirmed: true
        }
      },
      runGitHub: async () => {
        deliveryCalls += 1
        throw new Error('delivery must not start')
      }
    })

    assert.equal(stagedSubmoduleHidden, true)
    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.equal(result.evidence.failureDetail, 'the worktree changed during verification or its final diff could not be captured completely; delivery was skipped')
    assert.equal(deliveryCalls, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 2つの repository にまたがる課題が completed になり、差分と検証結果を残す', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const repoB = await createRepository(fixture, 'repo-b')
  const baseA = git(fixture, repoA, 'rev-parse', 'HEAD')

  try {
    const result = await runTask(fixture, async (input) => {
      const service = serviceFor(input)
      const a = await service.createWorktree({ repository: 'repo-a' })
      const b = await service.createWorktree({ repository: 'repo-b', base: 'main' })
      await fs.writeFile(path.join(a.worktreePath, 'README.md'), '# fixture revised\n', 'utf8')
      await fs.mkdir(path.join(b.worktreePath, 'sub'))
      await fs.writeFile(path.join(b.worktreePath, 'sub', 'feature.txt'), 'feature\n', 'utf8')
      await service.registerVerification({
        repository: 'repo-a',
        command: [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('README.md', 'utf8').includes('revised') ? 0 : 1)"]
      })
      await service.registerVerification({
        repository: 'repo-b',
        command: [process.execPath, '-e', "console.log(require('node:fs').readFileSync('feature.txt', 'utf8').trim())"],
        cwd: 'sub'
      })

      return completed('repo-a と repo-b を変更しました。')
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.evidence.outcome, 'completed')
    assert.equal(result.evidence.taskKey, TASK_KEY)
    assert.equal(result.evidence.devRoot, fixture.devRoot)
    assert.equal(result.evidence.summary, 'repo-a と repo-b を変更しました。')
    assert.equal('failureReason' in result.evidence, false)
    assert.deepEqual(result.evidence.agent, { model: AGENT_MODEL })
    assert.equal('model' in result.evidence, false)

    const a = findWorktree(result.evidence, 'repo-a')
    assert.equal(a.worktreePath, worktreePathOf(repoA))
    assert.equal(a.branch, `araya/${TASK_KEY}`)
    assert.equal(a.base, 'HEAD')
    assert.equal(a.baseSha, baseA)
    assert.equal(a.headSha, baseA)
    assert.equal(a.headMoved, false)
    assert.equal(a.excludeAdded, true)
    assert.deepEqual(a.changedFiles, ['README.md'])
    assert.deepEqual(a.diffStat, { files: 1, insertions: 1, deletions: 1, truncated: false })
    assert.match(String(a.diff), /\+# fixture revised/u)
    assert.equal(a.diffTruncated, false)
    assert.deepEqual(readVerifications(a).map(({ status, exitCode, cwd }) => {
      return { status, exitCode, cwd }
    }), [{ status: 'passed', exitCode: 0, cwd: '' }])

    const b = findWorktree(result.evidence, 'repo-b')
    assert.equal(b.base, 'main')
    assert.deepEqual(b.changedFiles, ['sub/feature.txt'])
    assert.match(String(b.diff), /\+feature/u)
    const [verificationB] = readVerifications(b)
    assert.equal(verificationB?.status, 'passed')
    assert.equal(verificationB?.cwd, 'sub')
    assert.equal(verificationB?.stdout, 'feature\n')
    assert.equal(verificationB?.stderr, '')
    assert.equal(verificationB?.signal, null)

    // main checkout は変わらない
    assert.equal(git(fixture, repoA, 'status', '--porcelain'), '')
    assert.equal(await fs.readFile(path.join(repoA, 'README.md'), 'utf8'), '# fixture\n')
    await assertWorktreeKept(fixture, repoA)
    await assertWorktreeKept(fixture, repoB)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 差分が無ければ no_changes で、検証は not_run', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const marker = path.join(fixture.root, 'verification-ran')

  try {
    const result = await runTask(fixture, async (input) => {
      const service = serviceFor(input)
      await service.createWorktree({ repository: 'repo-a' })
      await service.registerVerification({
        repository: 'repo-a',
        command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker]
      })

      return completed('変更はありません。')
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'no_changes')
    assert.equal(result.evidence.summary, '変更はありません。')
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.deepEqual(worktree.changedFiles, [])
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'no_changes' }])
    assert.equal(await exists(marker), false)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: worktree を作らなかった課題は no_changes', async () => {
  const fixture = await createFixture()

  try {
    const result = await runTask(fixture, async () => {
      return completed('何もしませんでした。')
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'no_changes')
    assert.deepEqual(result.evidence.worktrees, [])
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 検証の無い worktree があれば verification_missing だが、ほかの検証は実行する', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const repoB = await createRepository(fixture, 'repo-b')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await changeRepository(input, 'repo-b')
      return completed('変更しました。')
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_missing')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, stdout }) => {
      return { status, stdout }
    }), [{ status: 'passed', stdout: 'verified\n' }])
    assert.deepEqual(findWorktree(result.evidence, 'repo-b').verifications, [])
    await assertWorktreeKept(fixture, repoA)
    await assertWorktreeKept(fixture, repoB)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: exit 1 の検証は verification_failed', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await runTask(fixture, async (input) => {
      const service = serviceFor(input)
      await changeRepository(input, 'repo-a', { command: FAIL_COMMAND })
      await service.registerVerification({ repository: 'repo-a', command: PASS_COMMAND })
      return completed('変更しました。')
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, exitCode, stderr }) => {
      return { status, exitCode, stderr }
    }), [
      { status: 'failed', exitCode: 1, stderr: 'broken\n' },
      { status: 'passed', exitCode: 0, stderr: '' }
    ])
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: timeout した検証は verification_failed', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
      return completed('変更しました。')
    }, { verificationTimeoutMs: 1000 })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.equal(readVerifications(findWorktree(result.evidence, 'repo-a'))[0]?.status, 'timeout')
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: cwd が無い検証は失敗として扱う', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND, cwd: 'missing/dir' })
      return completed('変更しました。')
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, reason, cwd }) => {
      return { status, reason, cwd }
    }), [{ status: 'failed', reason: 'cwd_missing', cwd: 'missing/dir' }])
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: agent の失敗では差分を集め、検証は not_run にする', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const marker = path.join(fixture.root, 'verification-ran')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', {
        command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker]
      })
      return { status: 'failed', error: 'model_error' }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'agent_failed')
    assert.deepEqual(result.evidence.agent, { error: 'model_error' })
    assert.equal('summary' in result.evidence, false)
    assert.equal('agentError' in result.evidence, false)
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.deepEqual(worktree.changedFiles, ['README.md'])
    assert.match(String(worktree.diff), /\+repo-a changed/u)
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'agent_failed' }])
    assert.equal(await exists(marker), false)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: agent の timeout は agent_timeout で、差分は残す', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return { status: 'timeout', error: 'agent_timeout' }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'agent_timeout')
    assert.deepEqual(result.evidence.agent, { error: 'agent_timeout' })
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.deepEqual(worktree.changedFiles, ['README.md'])
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'agent_timeout' }])
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: summary は 4000 文字に切り詰め、失敗でも渡された model を記録する', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')

  try {
    const done = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return completed('あ'.repeat(5000))
    })

    assert.equal(done.status, 'completed')
    assert.equal(done.evidence.summary, 'あ'.repeat(4000))
  } finally {
    await removeFixture(fixture)
  }

  const failedFixture = await createFixture()

  try {
    const failed = await runTask(failedFixture, async () => {
      return { status: 'failed', error: 'model_error', model: AGENT_MODEL }
    })

    assert.equal(failed.status, 'failed')
    assert.equal(failed.evidence.failureReason, 'agent_failed')
    assert.deepEqual(failed.evidence.agent, { error: 'model_error', model: AGENT_MODEL })
  } finally {
    await removeFixture(failedFixture)
  }
})

test('collectDevelopmentResult: 検証の timeout が範囲外なら throw する', async () => {
  const fixture = await createFixture()

  try {
    await assert.rejects(runTask(fixture, async () => {
      return completed('変更はありません。')
    }, { verificationTimeoutMs: 999 }), /verificationTimeoutMs must be between 1000 and 3600000 milliseconds/u)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 記録 file が壊れていれば task_state_invalid で、検証を実行しない', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.appendFile(path.join(input.stateDir, 'worktrees.jsonl'), '{broken\n', 'utf8')
      return completed('変更しました。')
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'task_state_invalid')
    assert.equal(result.evidence.summary, '変更しました。')
    assert.match(String(result.evidence.failureDetail), /worktrees\.jsonl line 2/u)
    assert.deepEqual(result.evidence.worktrees, [])
    assert.equal(verificationCalls.length, 0)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: worktree が消えていれば evidence_collection_failed', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.rm(record.worktreePath, { recursive: true, force: true })
      return completed('変更しました。')
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'evidence_collection_failed')
    assert.deepEqual(readWorktrees(result.evidence).map(({ repository, worktreePath }) => {
      return { repository, worktreePath }
    }), [{ repository: 'repo-a', worktreePath: worktreePathOf(repoA) }])
    assert.equal(verificationCalls.length, 0)
    assert.equal(git(fixture, repoA, 'rev-parse', '--verify', '--quiet', `refs/heads/araya/${TASK_KEY}`).length > 0, true)
  } finally {
    await removeFixture(fixture)
  }
})

function runPassed() {
  const result: VerificationCommandResult = {
    status: 'passed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    terminationConfirmed: true
  }

  return result
}

test('collectDevelopmentResult: worktree の path が symlink で別の場所を指していれば task_state_invalid で、差分も検証も扱わない', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  // 開発 root の外にある別の repository
  const outside = path.join(fixture.root, 'outside')
  await fs.mkdir(outside)
  git(fixture, outside, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(outside, 'README.md'), '# outside\n', 'utf8')
  git(fixture, outside, 'add', '--all')
  git(fixture, outside, 'commit', '-q', '-m', 'outside fixture')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.rm(record.worktreePath, { recursive: true, force: true })
      await fs.symlink(outside, record.worktreePath)
      return completed('変更しました。')
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'task_state_invalid')
    assert.match(String(result.evidence.failureDetail), /symlinks/u)
    assert.deepEqual(result.evidence.worktrees, [])
    assert.equal(verificationCalls.length, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 記録した path が壊れた symlink や symlink の下にあれば task_state_invalid で、差分も検証も扱わない', async () => {
  const cases = [
    {
      name: 'worktree が壊れた symlink',
      tamper: async (worktreePath: string, fixture: Fixture) => {
        await fs.rm(worktreePath, { recursive: true, force: true })
        await fs.symlink(path.join(fixture.root, 'missing-target'), worktreePath)
      }
    },
    {
      name: '.worktree が別の場所への symlink',
      tamper: async (worktreePath: string, fixture: Fixture) => {
        const empty = path.join(fixture.root, 'empty')
        await fs.mkdir(empty)
        await fs.rm(path.dirname(worktreePath), { recursive: true, force: true })
        await fs.symlink(empty, path.dirname(worktreePath))
      }
    }
  ]

  for (const { name, tamper } of cases) {
    const fixture = await createFixture()
    await createRepository(fixture, 'repo-a')
    const verificationCalls: VerificationCommandInput[] = []

    try {
      const result = await runTask(fixture, async (input) => {
        const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
        await tamper(record.worktreePath, fixture)
        return completed('変更しました。')
      }, {
        runVerification: async (input) => {
          verificationCalls.push(input)
          return runPassed()
        }
      })

      assert.equal(result.status, 'failed', name)
      assert.equal(result.evidence.failureReason, 'task_state_invalid', name)
      assert.match(String(result.evidence.failureDetail), /is not a real directory/u, name)
      assert.deepEqual(result.evidence.worktrees, [], name)
      assert.equal(verificationCalls.length, 0, name)
    } finally {
      await removeFixture(fixture)
    }
  }
})

test('collectDevelopmentResult: 差分の収集に使う git の終了を確認できなければ evidence_collection_failed', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const holderPidFile = path.join(fixture.root, 'holder.pid')
  const fakeGitScript = path.join(fixture.root, 'fake-git.cjs')
  const fakeGit = path.join(fixture.root, 'fake-git')
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: fixture.env, encoding: 'utf8' }).trim()
  // 差分の本体を出す git diff（--binary）だけ、別 session の子 process に stdout を開いたまま残させ、親が kill されても pipe が閉じないようにする
  await fs.writeFile(fakeGitScript, [
    "const { spawn, spawnSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    'const args = process.argv.slice(2)',
    "if (!args.includes('--binary')) {",
    `  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })`,
    '  process.exit(result.status ?? 1)',
    '}',
    "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })",
    `fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(holder.pid))`,
    'holder.unref()',
    "process.stdout.write('x'.repeat(1024 * 1024))",
    'setInterval(() => {}, 1000)'
  ].join('\n'), 'utf8')
  await fs.writeFile(fakeGit, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGitScript)} "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return completed('変更しました。')
    }, {
      gitExecutable: fakeGit,
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'evidence_collection_failed')
    assert.match(String(result.evidence.failureDetail), /termination could not be confirmed/u)
    assert.equal(verificationCalls.length, 0)
  } finally {
    const holderPid = Number(await fs.readFile(holderPidFile, 'utf8').catch(() => {
      return ''
    }))

    if (Number.isInteger(holderPid) && holderPid > 0) {
      try {
        process.kill(holderPid, 'SIGKILL')
      } catch {
        // 既に終了している
      }
    }

    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 検証の cwd が symlink で worktree の外を指していれば、その検証は実行せず失敗にする', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const outside = path.join(fixture.root, 'outside-cwd')
  await fs.mkdir(outside)
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND, cwd: 'linked' })
      await fs.symlink(outside, path.join(record.worktreePath, 'linked'))
      return completed('変更しました。')
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'failed', reason: 'cwd_outside_worktree' }])
    assert.equal(verificationCalls.length, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 検証の終了を確認できなければ残りの検証を実行しない', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  const verificationCalls: string[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      const service = serviceFor(input)
      await changeRepository(input, 'repo-a', { command: ['first'] })
      await service.registerVerification({ repository: 'repo-a', command: ['second'] })
      await changeRepository(input, 'repo-b', { command: ['third'] })
      return completed('変更しました。')
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input.command.join(' '))
        return input.command[0] === 'first'
          ? { ...runPassed(), status: 'timeout', exitCode: null, signal: 'SIGKILL', terminationConfirmed: false, reason: 'termination_unconfirmed' }
          : runPassed()
      }
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'termination_unconfirmed')
    assert.equal(result.evidence.terminationConfirmed, false)
    assert.deepEqual(verificationCalls, ['first'])
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, reason }) => {
      return { status, reason }
    }), [
      { status: 'timeout', reason: 'termination_unconfirmed' },
      { status: 'not_run', reason: 'previous_termination_unconfirmed' }
    ])
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-b')).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'previous_termination_unconfirmed' }])
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: agent が commit すると headMoved を記録し、commit 済みの差分も含める', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const baseSha = git(fixture, repoA, 'rev-parse', 'HEAD')

  try {
    const result = await runTask(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.writeFile(path.join(record.worktreePath, 'committed.txt'), 'committed\n', 'utf8')
      git(fixture, record.worktreePath, 'add', 'committed.txt')
      git(fixture, record.worktreePath, 'commit', '-q', '-m', 'agent commit')
      return completed('変更しました。')
    })

    assert.equal(result.status, 'completed')
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.equal(worktree.baseSha, baseSha)
    assert.equal(worktree.headMoved, true)
    assert.notEqual(worktree.headSha, baseSha)
    assert.equal(worktree.headSha, git(fixture, worktreePathOf(repoA), 'rev-parse', 'HEAD'))
    assert.deepEqual(worktree.changedFiles, ['README.md', 'committed.txt'])
    assert.match(String(worktree.diff), /\+committed/u)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: diff は全 worktree の合計で上限を超えると diffTruncated になる', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')

  try {
    const result = await runTask(fixture, async (input) => {
      const a = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.writeFile(path.join(a.worktreePath, 'README.md'), `${'large line\n'.repeat(30_000)}`, 'utf8')
      await changeRepository(input, 'repo-b', { command: PASS_COMMAND })
      return completed('変更しました。')
    })

    assert.equal(result.status, 'completed')
    const a = findWorktree(result.evidence, 'repo-a')
    const b = findWorktree(result.evidence, 'repo-b')
    const totalBytes = Buffer.byteLength(String(a.diff)) + Buffer.byteLength(String(b.diff))

    assert.equal(a.diffTruncated, true)
    assert.equal(b.diffTruncated, true)
    assert.deepEqual(b.changedFiles, ['README.md'])
    assert.ok(totalBytes <= 256 * 1024)
    assert.match(String(a.diff), /\[diff truncated: the evidence limit is 262144 bytes across all worktrees\]\n$/u)
    // 上限を使い切った後の worktree は、印も入らないため diff を残さない
    assert.equal(b.diff, '')
    assert.equal(readVerifications(b)[0]?.status, 'passed')
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: untracked の分で上限を超えても、切り詰めの印を含めて上限に収める', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')

  try {
    const result = await runTask(fixture, async (input) => {
      const a = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      // tracked の diff は上限の少し手前に収め、untracked の file で上限を超えさせる
      await fs.writeFile(path.join(a.worktreePath, 'README.md'), `${'large line\n'.repeat(21_000)}`, 'utf8')
      await fs.writeFile(path.join(a.worktreePath, 'extra.txt'), `${'extra line\n'.repeat(2000)}`, 'utf8')
      return completed('変更しました。')
    })

    assert.equal(result.status, 'completed')
    const a = findWorktree(result.evidence, 'repo-a')

    assert.deepEqual(a.changedFiles, ['README.md', 'extra.txt'])
    assert.equal(a.diffTruncated, true)
    assert.ok(Buffer.byteLength(String(a.diff)) <= 256 * 1024)
    assert.match(String(a.diff), /\[diff truncated: the evidence limit is 262144 bytes across all worktrees\]\n$/u)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 切っていない差分と検証の出力は境界の部分を置き換えず、先頭を切った検証の出力だけ境界を置き換える', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const redactor = createRedactor(['Zq8kW3mX9pL2vN7r'])
  // 1つ目は上限以内、2つ目は上限を超えて先頭を切った出力。どちらも先頭が秘密の値の末尾の部分と userinfo の途中から始まる
  const outputs = [
    { stdout: 'L2vN7r ok', stdoutBytes: 9, stderr: 'er:pass@example.invalid', stderrBytes: 23 },
    { stdout: 'L2vN7r ok', stdoutBytes: VERIFICATION_OUTPUT_BYTES + 1, stderr: 'er:pass@example.invalid', stderrBytes: VERIFICATION_OUTPUT_BYTES + 1 }
  ]

  try {
    const result = await runTask(fixture, async (input) => {
      const service = serviceFor(input)
      const a = await service.createWorktree({ repository: 'repo-a' })
      await fs.appendFile(path.join(a.worktreePath, 'README.md'), 'tail Zq8kW3\n', 'utf8')
      await service.registerVerification({ repository: 'repo-a', command: ['first'] })
      await service.registerVerification({ repository: 'repo-a', command: ['second'] })
      return completed('変更しました。')
    }, {
      redactor,
      runVerification: async (input) => {
        return { ...runPassed(), ...(outputs[input.index] ?? {}) }
      }
    })

    assert.equal(result.status, 'completed')
    const a = findWorktree(result.evidence, 'repo-a')
    const verifications = readVerifications(a)

    assert.equal(a.diffTruncated, false)
    assert.match(String(a.diff), /\+tail Zq8kW3\n$/u)
    assert.deepEqual(verifications.map((verification) => [verification.stdout, verification.stderr]), [
      ['L2vN7r ok', 'er:pass@example.invalid'],
      ['[REDACTED] ok', '[REDACTED]@example.invalid']
    ])
    assert.equal(redactor.count, 2)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: 検証の実行に verifications.jsonl の中の登録の順番と中止の signal を渡す', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  const controller = new AbortController()
  const calls: { command: readonly string[]; index: number; signal: AbortSignal | undefined }[] = []

  try {
    const result = await runTask(fixture, async (input) => {
      const service = serviceFor(input)
      const a = await service.createWorktree({ repository: 'repo-a' })
      const b = await service.createWorktree({ repository: 'repo-b' })
      await fs.appendFile(path.join(a.worktreePath, 'README.md'), 'a\n', 'utf8')
      await fs.appendFile(path.join(b.worktreePath, 'README.md'), 'b\n', 'utf8')
      await service.registerVerification({ repository: 'repo-a', command: ['a-first'] })
      await service.registerVerification({ repository: 'repo-b', command: ['b-first'] })
      await service.registerVerification({ repository: 'repo-a', command: ['a-second'] })
      return completed('変更しました。')
    }, {
      signal: controller.signal,
      runVerification: async (input) => {
        calls.push({ command: input.command, index: input.index, signal: input.signal })
        return runPassed()
      }
    })

    assert.equal(result.status, 'completed')
    assert.deepEqual(calls.map(({ command, index }) => [command[0], index]), [['a-first', 0], ['a-second', 2], ['b-first', 1]])
    assert.ok(calls.every((call) => call.signal === controller.signal))
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: SHIKI が成功で終わって判断を求めていれば blocked で、差分を集め、検証は decision_requested で実行しない', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  const marker = path.join(fixture.root, 'verification-ran')

  try {
    const result = await runTask(fixture, async (input) => {
      await changeRepository(input, 'repo-a', {
        command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker]
      })
      // 差分の無い worktree と検証の無い worktree も失敗にしない
      await serviceFor(input).createWorktree({ repository: 'repo-b' })
      await recordDecision(input.stateDir, 'どちらの API を使いますか', new Date('2026-01-01T00:00:00.000Z'))
      return completed('質問しました。')
    })

    assert.equal(result.status, 'blocked')
    assert.equal(result.decisionQuestion, 'どちらの API を使いますか')
    assert.equal(result.collected, true)
    assert.equal(result.evidence.outcome, 'blocked')
    assert.equal('failureReason' in result.evidence, false)
    assert.equal(result.evidence.decisionQuestion, 'どちらの API を使いますか')
    assert.equal(result.evidence.summary, '質問しました。')
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.match(String(worktree.diff), /\+repo-a changed/u)
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'decision_requested' }])
    assert.deepEqual(findWorktree(result.evidence, 'repo-b').changedFiles, [])
    assert.equal(await exists(marker), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('collectDevelopmentResult: SHIKI が timeout や失敗で終われば、判断を求めていても failed で、質問は残す', async () => {
  for (const agent of [
    { status: 'timeout', error: 'agent_timeout' },
    { status: 'failed', error: 'model_error', errorMessage: 'provider exploded' }
  ] satisfies AgentOutcome[]) {
    const fixture = await createFixture()
    await createRepository(fixture, 'repo-a')

    try {
      const result = await runTask(fixture, async (input) => {
        await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
        await recordDecision(input.stateDir, '続けてよいですか', new Date())
        return agent
      })

      assert.equal(result.status, 'failed')
      assert.equal(result.evidence.failureReason, agent.status === 'timeout' ? 'agent_timeout' : 'agent_failed')
      assert.equal(result.decisionQuestion, '続けてよいですか')
      assert.equal(result.evidence.decisionQuestion, '続けてよいですか')
      assert.deepEqual(result.evidence.agent, agent.status === 'timeout'
        ? { error: 'agent_timeout' }
        : { error: 'model_error', errorMessage: 'provider exploded' })
    } finally {
      await removeFixture(fixture)
    }
  }
})

test('collectDevelopmentResult: decision.json の形式が不正なら task_state_invalid', async () => {
  for (const content of ['{', '{"question":"q"}', '{"question":"  ","requestedAt":"x"}', '{"question":"q","requestedAt":"x","extra":1}']) {
    const fixture = await createFixture()
    await createRepository(fixture, 'repo-a')

    try {
      const result = await runTask(fixture, async (input) => {
        await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
        await fs.writeFile(path.join(input.stateDir, 'decision.json'), content, 'utf8')
        return completed('done')
      })

      assert.equal(result.status, 'failed', content)
      assert.equal(result.evidence.failureReason, 'task_state_invalid', content)
      assert.match(String(result.evidence.failureDetail), /decision\.json/u)
      assert.equal(result.collected, false)
    } finally {
      await removeFixture(fixture)
    }
  }
})

test('buildWorktreeOnlyEvidence: worktrees.jsonl の path と branch だけを残し、無ければ空、読めなければ空にして理由を返す', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const stateDir = await createTaskState(fixture.dataDir, TASK_KEY)
    const missing = await buildWorktreeOnlyEvidence({ taskKey: TASK_KEY, devRoot: fixture.devRoot, stateDir, redact: noRedaction })
    assert.deepEqual(missing, {
      evidence: { taskKey: TASK_KEY, devRoot: fixture.devRoot, stateDir, worktrees: [], bodiesStored: false },
      detail: null
    })

    await serviceFor({ devRoot: fixture.devRoot, stateDir, taskKey: TASK_KEY, env: fixture.env }).createWorktree({ repository: 'repo-a' })
    const recorded = await buildWorktreeOnlyEvidence({ taskKey: TASK_KEY, devRoot: fixture.devRoot, stateDir, redact: noRedaction })
    assert.deepEqual(recorded.evidence.worktrees, [{ worktreePath: worktreePathOf(repoA), branch: `araya/${TASK_KEY}` }])
    assert.equal(recorded.detail, null)

    await fs.appendFile(path.join(stateDir, 'worktrees.jsonl'), 'not json\n', 'utf8')
    const broken = await buildWorktreeOnlyEvidence({ taskKey: TASK_KEY, devRoot: fixture.devRoot, stateDir, redact: noRedaction })
    assert.deepEqual(broken.evidence.worktrees, [])
    assert.match(String(broken.detail), /worktrees\.jsonl could not be read/u)

    const noState = await buildWorktreeOnlyEvidence({ taskKey: TASK_KEY, devRoot: fixture.devRoot, stateDir: null, redact: noRedaction })
    assert.deepEqual(noState.evidence, { taskKey: TASK_KEY, devRoot: fixture.devRoot, stateDir: null, worktrees: [], bodiesStored: false })
  } finally {
    await removeFixture(fixture)
  }
})
