import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runBoundedCommand } from '../src/development-process.ts'
import {
  MAX_VERIFICATIONS_PER_TASK,
  MAX_WORKTREES_PER_TASK,
  createTaskState,
  createWorktreeService,
  readTaskState
} from '../src/development-worktrees.ts'
import type { VerificationRecord, WorktreeRecord } from '../src/development-worktrees.ts'

const FIXED_NOW = new Date('2026-10-23T00:00:00.000Z')

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function createFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-worktrees-test-')))
  const home = path.join(root, 'home')
  const gitConfig = path.join(home, 'gitconfig')
  const devRoot = path.join(root, 'dev')
  const taskKey = 'task-1-1-abcdef'
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.writeFile(gitConfig, '', 'utf8')
  const stateDir = await createTaskState(path.join(root, 'data'), taskKey)
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

  return { root, devRoot, stateDir, taskKey, gitConfig, env }
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

async function createRepository(fixture: Fixture, directory: string, files: Record<string, string> = {}) {
  const repositoryPath = path.isAbsolute(directory) ? directory : path.join(fixture.devRoot, directory)
  await fs.mkdir(repositoryPath, { recursive: true })
  git(fixture, repositoryPath, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# fixture\n', 'utf8')

  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repositoryPath, name)), { recursive: true })
    await fs.writeFile(path.join(repositoryPath, name), content, 'utf8')
  }

  git(fixture, repositoryPath, 'add', '--all')
  git(fixture, repositoryPath, 'commit', '-q', '-m', 'initial fixture')

  return repositoryPath
}

function createService(fixture: Fixture, overrides: { taskKey?: string; stateDir?: string } = {}) {
  return createWorktreeService({
    devRoot: fixture.devRoot,
    stateDir: overrides.stateDir ?? fixture.stateDir,
    taskKey: overrides.taskKey ?? fixture.taskKey,
    env: fixture.env,
    runGit: runBoundedCommand,
    now: () => {
      return FIXED_NOW
    }
  })
}

async function readLines(filePath: string) {
  try {
    return (await fs.readFile(filePath, 'utf8')).split('\n').filter((line) => {
      return line !== ''
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

function excludePath(repositoryPath: string) {
  return path.join(repositoryPath, '.git', 'info', 'exclude')
}

function errorCode(code: string) {
  return { message: new RegExp(`^${code}: .+`, 'u') }
}

function countWorktrees(fixture: Fixture, repositoryPath: string) {
  return git(fixture, repositoryPath, 'worktree', 'list', '--porcelain').split('\n').filter((line) => {
    return line.startsWith('worktree ')
  }).length
}

test('createWorktree appends /.worktree/ to info/exclude when the directory is not ignored', async () => {
  const fixture = await createFixture()

  try {
    const repositoryPath = await createRepository(fixture, 'app')
    await fs.writeFile(excludePath(repositoryPath), '# existing\n*.log', 'utf8')
    const head = git(fixture, repositoryPath, 'rev-parse', 'HEAD')

    const record = await createService(fixture).createWorktree({ repository: 'app' })

    const worktreePath = path.join(repositoryPath, '.worktree', `araya-${fixture.taskKey}`)
    assert.deepEqual(record, {
      repository: 'app',
      repositoryRoot: repositoryPath,
      worktreePath,
      branch: `araya/${fixture.taskKey}`,
      base: 'HEAD',
      baseSha: head,
      excludeAdded: true,
      createdAt: FIXED_NOW.toISOString()
    })
    assert.equal(await fs.readFile(excludePath(repositoryPath), 'utf8'), '# existing\n*.log\n/.worktree/\n')
    assert.equal(git(fixture, repositoryPath, 'rev-parse', '--verify', `refs/heads/araya/${fixture.taskKey}`), head)
    assert.equal(git(fixture, worktreePath, 'rev-parse', 'HEAD'), head)
    assert.equal(git(fixture, worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'), `araya/${fixture.taskKey}`)
    assert.equal(git(fixture, repositoryPath, 'status', '--porcelain', '--untracked-files=all'), '')

    const worktreesFile = path.join(fixture.stateDir, 'worktrees.jsonl')
    const lines = await readLines(worktreesFile)
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0] ?? ''), record)
    assert.equal((await fs.stat(worktreesFile)).mode & 0o777, 0o600)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree keeps exclude unchanged when .gitignore already ignores .worktree', async () => {
  const fixture = await createFixture()

  try {
    const repositoryPath = await createRepository(fixture, 'app', { '.gitignore': '.worktree/\n' })
    const before = await fs.readFile(excludePath(repositoryPath), 'utf8')

    const record = await createService(fixture).createWorktree({ repository: 'app' })

    assert.equal(record.excludeAdded, false)
    assert.equal(await fs.readFile(excludePath(repositoryPath), 'utf8'), before)
    assert.equal(git(fixture, repositoryPath, 'status', '--porcelain', '--untracked-files=all'), '')
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree keeps exclude unchanged when info/exclude already has /.worktree/', async () => {
  const fixture = await createFixture()

  try {
    const repositoryPath = await createRepository(fixture, 'app')
    await fs.writeFile(excludePath(repositoryPath), '# local\n/.worktree/\n', 'utf8')

    const record = await createService(fixture).createWorktree({ repository: 'app' })

    assert.equal(record.excludeAdded, false)
    assert.equal(await fs.readFile(excludePath(repositoryPath), 'utf8'), '# local\n/.worktree/\n')
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree keeps exclude unchanged when global excludes ignore .worktree', async () => {
  const fixture = await createFixture()

  try {
    const globalIgnore = path.join(fixture.root, 'home', 'global-ignore')
    await fs.writeFile(globalIgnore, '.worktree/\n', 'utf8')
    await fs.writeFile(fixture.gitConfig, `[core]\n\texcludesFile = ${globalIgnore}\n`, 'utf8')
    const repositoryPath = await createRepository(fixture, 'app')
    const before = await fs.readFile(excludePath(repositoryPath), 'utf8')

    const record = await createService(fixture).createWorktree({ repository: 'app' })

    assert.equal(record.excludeAdded, false)
    assert.equal(await fs.readFile(excludePath(repositoryPath), 'utf8'), before)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree resolves base from HEAD by default and from branch names or revisions', async () => {
  const fixture = await createFixture()

  try {
    const repositoryPath = await createRepository(fixture, 'app')
    const first = git(fixture, repositoryPath, 'rev-parse', 'HEAD')
    git(fixture, repositoryPath, 'branch', 'feature')
    await fs.writeFile(path.join(repositoryPath, 'README.md'), '# second\n', 'utf8')
    git(fixture, repositoryPath, 'commit', '-q', '-am', 'second commit')
    const second = git(fixture, repositoryPath, 'rev-parse', 'HEAD')
    const cases = [
      { label: 'default', base: undefined, expectedBase: 'HEAD', expectedSha: second },
      { label: 'branch', base: 'feature', expectedBase: 'feature', expectedSha: first },
      { label: 'revision', base: 'HEAD~1', expectedBase: 'HEAD~1', expectedSha: first }
    ]

    for (const [index, testCase] of cases.entries()) {
      const taskKey = `task-2-${index + 1}-abcdef`
      const stateDir = await createTaskState(path.join(fixture.root, 'data'), taskKey)
      const service = createService(fixture, { taskKey, stateDir })
      const record = await service.createWorktree(testCase.base === undefined
        ? { repository: 'app' }
        : { repository: 'app', base: testCase.base })

      assert.equal(record.base, testCase.expectedBase)
      assert.equal(record.baseSha, testCase.expectedSha)
      assert.equal(git(fixture, record.worktreePath, 'rev-parse', 'HEAD'), testCase.expectedSha)
    }

    const service = createService(fixture)
    await assert.rejects(service.createWorktree({ repository: 'app', base: '-x' }), errorCode('base_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'app', base: '' }), errorCode('base_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'app', base: 'main\nHEAD' }), errorCode('base_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'app', base: 'main\rHEAD' }), errorCode('base_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'app', base: 'main\0' }), errorCode('base_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'app', base: 'a'.repeat(201) }), errorCode('base_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'app', base: 'missing-ref' }), errorCode('base_not_found'))
    assert.deepEqual(await readLines(path.join(fixture.stateDir, 'worktrees.jsonl')), [])
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree rejects repositories that are not main working tree roots under the development root', async () => {
  const fixture = await createFixture()

  try {
    const repositoryPath = await createRepository(fixture, 'app', { 'src/index.ts': 'export {}\n' })
    git(fixture, repositoryPath, 'worktree', 'add', '-q', '-b', 'linked', path.join(fixture.devRoot, 'linked'))
    await createRepository(fixture, path.join('group', '.worktree', 'repo'))
    await fs.symlink(path.join('group', '.worktree', 'repo'), path.join(fixture.devRoot, 'hidden'))
    const outsideRepository = await createRepository(fixture, path.join(fixture.root, 'outside-repo'))
    await fs.symlink(outsideRepository, path.join(fixture.devRoot, 'outside'))
    await fs.mkdir(path.join(fixture.devRoot, 'plain'))
    const service = createService(fixture)
    const cases = [
      { repository: repositoryPath, code: 'repository_invalid' },
      { repository: '../outside-repo', code: 'repository_invalid' },
      { repository: 'app/../app', code: 'repository_invalid' },
      { repository: '', code: 'repository_invalid' },
      { repository: 'app\0', code: 'repository_invalid' },
      { repository: 'a'.repeat(201), code: 'repository_invalid' },
      { repository: 'missing', code: 'repository_not_found' },
      { repository: 'app/src', code: 'repository_not_git_root' },
      { repository: 'linked', code: 'repository_is_linked_worktree' },
      { repository: 'group/.worktree/repo', code: 'repository_in_worktree_directory' },
      { repository: 'hidden', code: 'repository_in_worktree_directory' },
      { repository: 'outside', code: 'repository_outside_dev_root' },
      { repository: 'plain', code: 'repository_not_git' },
      { repository: 'README.md', code: 'repository_not_found' },
      { repository: '.', code: 'repository_is_dev_root' },
      { repository: './', code: 'repository_is_dev_root' }
    ]
    await fs.writeFile(path.join(fixture.devRoot, 'file'), 'not a directory\n', 'utf8')
    cases.push({ repository: 'file', code: 'repository_not_directory' })

    for (const testCase of cases) {
      await assert.rejects(service.createWorktree({ repository: testCase.repository }), errorCode(testCase.code), testCase.repository)
    }

    assert.equal(await exists(path.join(repositoryPath, '.worktree')), false)
    assert.equal(await exists(path.join(fixture.stateDir, 'worktrees.jsonl')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree rejects repositories that track files under .worktree', async () => {
  const fixture = await createFixture()

  try {
    await createRepository(fixture, 'app', { '.worktree/keep': 'tracked\n' })

    await assert.rejects(createService(fixture).createWorktree({ repository: 'app' }), errorCode('worktree_directory_tracked'))
    assert.equal(await exists(path.join(fixture.stateDir, 'worktrees.jsonl')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree rejects a .worktree file or symlink', async () => {
  const fixture = await createFixture()

  try {
    const fileRepository = await createRepository(fixture, 'with-file')
    await fs.writeFile(path.join(fileRepository, '.worktree'), 'not a directory\n', 'utf8')
    const linkRepository = await createRepository(fixture, 'with-link')
    await fs.mkdir(path.join(fixture.root, 'elsewhere'))
    await fs.symlink(path.join(fixture.root, 'elsewhere'), path.join(linkRepository, '.worktree'))
    const service = createService(fixture)

    await assert.rejects(service.createWorktree({ repository: 'with-file' }), errorCode('worktree_directory_invalid'))
    await assert.rejects(service.createWorktree({ repository: 'with-link' }), errorCode('worktree_directory_invalid'))
    assert.deepEqual(await fs.readdir(path.join(fixture.root, 'elsewhere')), [])
    assert.equal(await exists(path.join(fixture.stateDir, 'worktrees.jsonl')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree returns the recorded worktree for the same repository, including symlink aliases', async () => {
  const fixture = await createFixture()

  try {
    const repositoryPath = await createRepository(fixture, 'app')
    await fs.symlink('app', path.join(fixture.devRoot, 'alias'))
    const service = createService(fixture)
    const first = await service.createWorktree({ repository: 'app' })
    const exclude = await fs.readFile(excludePath(repositoryPath), 'utf8')

    const again = await service.createWorktree({ repository: './app/', base: 'HEAD~0' })
    const viaAlias = await service.createWorktree({ repository: 'alias' })

    assert.deepEqual(again, first)
    assert.deepEqual(viaAlias, first)
    assert.equal(countWorktrees(fixture, repositoryPath), 2)
    assert.equal(git(fixture, repositoryPath, 'branch', '--list', 'araya/*').split('\n').length, 1)
    assert.equal(await fs.readFile(excludePath(repositoryPath), 'utf8'), exclude)
    assert.equal((await readLines(path.join(fixture.stateDir, 'worktrees.jsonl'))).length, 1)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree rejects an unrecorded existing task branch or worktree path', async () => {
  const fixture = await createFixture()

  try {
    const branchRepository = await createRepository(fixture, 'with-branch')
    git(fixture, branchRepository, 'branch', `araya/${fixture.taskKey}`)
    const branchExclude = await fs.readFile(excludePath(branchRepository), 'utf8')
    const pathRepository = await createRepository(fixture, 'with-path')
    await fs.mkdir(path.join(pathRepository, '.worktree', `araya-${fixture.taskKey}`), { recursive: true })
    const service = createService(fixture)

    await assert.rejects(service.createWorktree({ repository: 'with-branch' }), errorCode('worktree_branch_exists'))
    await assert.rejects(service.createWorktree({ repository: 'with-path' }), errorCode('worktree_path_exists'))
    assert.equal(await fs.readFile(excludePath(branchRepository), 'utf8'), branchExclude)
    assert.equal(countWorktrees(fixture, branchRepository), 1)
    assert.equal(countWorktrees(fixture, pathRepository), 1)
    assert.equal(await exists(path.join(fixture.stateDir, 'worktrees.jsonl')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree allows 16 repositories and rejects the 17th', async () => {
  const fixture = await createFixture()

  try {
    const service = createService(fixture)

    for (let index = 0; index < MAX_WORKTREES_PER_TASK + 1; index += 1) {
      await createRepository(fixture, `repo-${index}`)
    }

    for (let index = 0; index < MAX_WORKTREES_PER_TASK; index += 1) {
      await service.createWorktree({ repository: `repo-${index}` })
    }

    await assert.rejects(
      service.createWorktree({ repository: `repo-${MAX_WORKTREES_PER_TASK}` }),
      errorCode('worktree_limit_reached')
    )
    assert.deepEqual(await service.createWorktree({ repository: 'repo-0' }), (await readTaskState({
      devRoot: fixture.devRoot,
      stateDir: fixture.stateDir,
      taskKey: fixture.taskKey
    })).worktrees[0])
    assert.equal((await readLines(path.join(fixture.stateDir, 'worktrees.jsonl'))).length, MAX_WORKTREES_PER_TASK)
    assert.equal(await exists(path.join(fixture.devRoot, `repo-${MAX_WORKTREES_PER_TASK}`, '.worktree')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree serializes concurrent calls so both records are written as JSONL', async () => {
  const fixture = await createFixture()

  try {
    await createRepository(fixture, 'first')
    await createRepository(fixture, 'second')
    const service = createService(fixture)

    const records = await Promise.all([
      service.createWorktree({ repository: 'first' }),
      service.createWorktree({ repository: 'second' }),
      service.createWorktree({ repository: 'first' })
    ])

    assert.deepEqual(records[2], records[0])
    const lines = await readLines(path.join(fixture.stateDir, 'worktrees.jsonl'))
    assert.deepEqual(lines.map((line) => {
      return JSON.parse(line)
    }), [records[0], records[1]])
    const state = await readTaskState({ devRoot: fixture.devRoot, stateDir: fixture.stateDir, taskKey: fixture.taskKey })
    assert.deepEqual(state.worktrees.map((worktree) => {
      return worktree.repository
    }), ['first', 'second'])
  } finally {
    await removeFixture(fixture)
  }
})

test('registerVerification validates input, normalizes cwd, deduplicates and enforces the limit', async () => {
  const fixture = await createFixture()

  try {
    await createRepository(fixture, 'app')
    await createRepository(fixture, 'other')
    await fs.symlink('app', path.join(fixture.devRoot, 'alias'))
    const service = createService(fixture)
    await service.createWorktree({ repository: 'app' })
    const verificationsFile = path.join(fixture.stateDir, 'verifications.jsonl')

    await assert.rejects(service.registerVerification({ repository: 'other', command: ['npm', 'test'] }), errorCode('worktree_not_created'))
    await assert.rejects(service.registerVerification({ repository: 'missing', command: ['npm', 'test'] }), errorCode('repository_not_found'))
    await assert.rejects(service.registerVerification({ repository: '/app', command: ['npm', 'test'] }), errorCode('repository_invalid'))

    const invalidCommands = [
      [],
      Array.from({ length: 65 }, () => {
        return 'x'
      }),
      ['npm', 'te\0st'],
      ['a'.repeat(32_768), 'b'],
      JSON.parse('["npm", 1]'),
      JSON.parse('"npm test"')
    ]

    for (const command of invalidCommands) {
      await assert.rejects(service.registerVerification({ repository: 'app', command }), errorCode('command_invalid'))
    }

    for (const cwd of ['/tmp', '..', 'packages/../..', 'packages/..', 'pack\0ages']) {
      await assert.rejects(service.registerVerification({ repository: 'app', command: ['npm', 'test'], cwd }), errorCode('cwd_invalid'))
    }

    assert.equal(await exists(verificationsFile), false)

    const maxCommand = await service.registerVerification({ repository: 'app', command: ['a'.repeat(32_767), 'b'] })
    assert.equal(maxCommand.command.join('').length, 32_768)

    const root = await service.registerVerification({ repository: 'app', command: ['npm', 'test'] })
    assert.deepEqual(root, {
      repository: 'app',
      command: ['npm', 'test'],
      cwd: '',
      registeredAt: FIXED_NOW.toISOString()
    })
    assert.deepEqual(await service.registerVerification({ repository: 'alias', command: ['npm', 'test'], cwd: '.' }), root)
    assert.deepEqual(await service.registerVerification({ repository: 'app/', command: ['npm', 'test'], cwd: '' }), root)

    const nested = await service.registerVerification({ repository: 'app', command: ['npm', 'test'], cwd: './packages//araya/' })
    assert.equal(nested.cwd, 'packages/araya')
    assert.deepEqual(await service.registerVerification({ repository: 'app', command: ['npm', 'test'], cwd: 'packages/araya' }), nested)
    assert.equal((await readLines(verificationsFile)).length, 3)

    for (let index = 3; index < MAX_VERIFICATIONS_PER_TASK; index += 1) {
      await service.registerVerification({ repository: 'app', command: ['echo', String(index)] })
    }

    await assert.rejects(
      service.registerVerification({ repository: 'app', command: ['echo', 'one more'] }),
      errorCode('verification_limit_reached')
    )
    assert.deepEqual(await service.registerVerification({ repository: 'app', command: ['npm', 'test'] }), root)

    const lines = await readLines(verificationsFile)
    assert.equal(lines.length, MAX_VERIFICATIONS_PER_TASK)
    assert.equal((await fs.stat(verificationsFile)).mode & 0o777, 0o600)
    const state = await readTaskState({ devRoot: fixture.devRoot, stateDir: fixture.stateDir, taskKey: fixture.taskKey })
    assert.equal(state.verifications.length, MAX_VERIFICATIONS_PER_TASK)
    assert.deepEqual(state.verifications[1], root)
  } finally {
    await removeFixture(fixture)
  }
})

function createValidRecords(fixture: Fixture) {
  const repositoryRoot = path.join(fixture.devRoot, 'group', 'app')
  const worktree: WorktreeRecord = {
    repository: path.join('group', 'app'),
    repositoryRoot,
    worktreePath: path.join(repositoryRoot, '.worktree', `araya-${fixture.taskKey}`),
    branch: `araya/${fixture.taskKey}`,
    base: 'origin/main',
    baseSha: 'a'.repeat(40),
    excludeAdded: true,
    createdAt: FIXED_NOW.toISOString()
  }
  const verification: VerificationRecord = {
    repository: worktree.repository,
    command: ['npm', 'test'],
    cwd: 'packages/araya',
    registeredAt: FIXED_NOW.toISOString()
  }

  return { worktree, verification }
}

async function writeState(stateDir: string, worktrees: readonly unknown[], verifications: readonly unknown[]) {
  await fs.writeFile(path.join(stateDir, 'worktrees.jsonl'), worktrees.map((record) => {
    return `${typeof record === 'string' ? record : JSON.stringify(record)}\n`
  }).join(''), 'utf8')
  await fs.writeFile(path.join(stateDir, 'verifications.jsonl'), verifications.map((record) => {
    return `${typeof record === 'string' ? record : JSON.stringify(record)}\n`
  }).join(''), 'utf8')
}

test('readTaskState reads valid records and rejects tampered records', async () => {
  const fixture = await createFixture()

  try {
    const options = { devRoot: fixture.devRoot, stateDir: fixture.stateDir, taskKey: fixture.taskKey }
    assert.deepEqual(await readTaskState(options), { worktrees: [], verifications: [] })

    const { worktree, verification } = createValidRecords(fixture)
    const sha256Worktree = {
      ...worktree,
      repository: 'lib',
      repositoryRoot: path.join(fixture.devRoot, 'lib'),
      worktreePath: path.join(fixture.devRoot, 'lib', '.worktree', `araya-${fixture.taskKey}`),
      baseSha: 'b'.repeat(64)
    }
    await writeState(fixture.stateDir, [worktree, sha256Worktree], [verification])
    assert.deepEqual(await readTaskState(options), { worktrees: [worktree, sha256Worktree], verifications: [verification] })

    const outsideRoot = path.join(fixture.root, 'outside')
    const { repository: _repository, ...withoutRepository } = worktree
    const tamperedWorktrees = [
      {
        ...worktree,
        repository: path.relative(fixture.devRoot, outsideRoot),
        repositoryRoot: outsideRoot,
        worktreePath: path.join(outsideRoot, '.worktree', `araya-${fixture.taskKey}`)
      },
      { ...worktree, repository: '', repositoryRoot: fixture.devRoot, worktreePath: path.join(fixture.devRoot, '.worktree', `araya-${fixture.taskKey}`) },
      { ...worktree, repository: 'other' },
      { ...worktree, worktreePath: path.join(fixture.root, 'elsewhere') },
      { ...worktree, branch: 'main' },
      { ...worktree, baseSha: 'HEAD' },
      { ...worktree, excludeAdded: 'yes' },
      { ...worktree, extra: true },
      withoutRepository,
      '{"repository":',
      '["not", "an", "object"]'
    ]

    for (const tampered of tamperedWorktrees) {
      await writeState(fixture.stateDir, [tampered], [])
      await assert.rejects(readTaskState(options), errorCode('task_state_invalid'), JSON.stringify(tampered))
    }

    await writeState(fixture.stateDir, [worktree, worktree], [])
    await assert.rejects(readTaskState(options), errorCode('task_state_invalid'))

    const tamperedVerifications = [
      { ...verification, repository: 'other' },
      { ...verification, command: [] },
      { ...verification, command: ['npm', 1] },
      { ...verification, cwd: '../outside' },
      { ...verification, cwd: '/tmp' },
      { ...verification, extra: true },
      'not json'
    ]

    for (const tampered of tamperedVerifications) {
      await writeState(fixture.stateDir, [worktree], [tampered])
      await assert.rejects(readTaskState(options), errorCode('task_state_invalid'), JSON.stringify(tampered))
    }

    await writeState(fixture.stateDir, [worktree], Array.from({ length: MAX_VERIFICATIONS_PER_TASK + 1 }, (_value, index) => {
      return { ...verification, command: ['echo', String(index)] }
    }))
    await assert.rejects(readTaskState(options), errorCode('task_state_invalid'))
  } finally {
    await removeFixture(fixture)
  }
})

test('createWorktree refuses to continue from a tampered task state', async () => {
  const fixture = await createFixture()

  try {
    await createRepository(fixture, 'app')
    await fs.writeFile(path.join(fixture.stateDir, 'worktrees.jsonl'), '{"broken"\n', 'utf8')

    await assert.rejects(createService(fixture).createWorktree({ repository: 'app' }), errorCode('task_state_invalid'))
    assert.equal(await exists(path.join(fixture.devRoot, 'app', '.worktree')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('createTaskState creates a private directory and refuses to reuse an existing one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-worktrees-test-'))

  try {
    const dataDir = path.join(root, 'data')
    const taskKey = 'task-1-1-abcdef'
    const stateDir = await createTaskState(dataDir, taskKey)

    assert.equal(stateDir, path.join(dataDir, 'development', taskKey))
    assert.equal((await fs.stat(stateDir)).mode & 0o777, 0o700)
    await assert.rejects(createTaskState(dataDir, taskKey), errorCode('task_state_already_exists'))

    const fileKey = 'task-2-1-abcdef'
    await fs.writeFile(path.join(dataDir, 'development', fileKey), '', 'utf8')
    await assert.rejects(createTaskState(dataDir, fileKey), errorCode('task_state_already_exists'))

    const linkKey = 'task-3-1-abcdef'
    await fs.symlink(path.join(root, 'missing'), path.join(dataDir, 'development', linkKey))
    await assert.rejects(createTaskState(dataDir, linkKey), errorCode('task_state_already_exists'))
    assert.equal(await exists(path.join(root, 'missing')), false)

    await assert.rejects(createTaskState(dataDir, '../escape'), errorCode('task_key_invalid'))
    await assert.rejects(createTaskState(dataDir, 'development-0123456789abcdef0123'), errorCode('task_key_invalid'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
