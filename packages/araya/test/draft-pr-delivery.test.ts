import assert from 'node:assert/strict'
import test from 'node:test'

import type { BoundedProcessResult, GitCommandRunner } from '../src/infrastructure/process.ts'
import { deliverDraftPullRequests } from '../src/development/draft-pr/delivery.ts'
import type { WorktreeRecord } from '../src/development/worktrees.ts'

function result(stdout = '', exitCode = 0): BoundedProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true
  }
}

test('Draft PR delivery refuses multiple origin push URLs before any commit or push', async () => {
  const taskKey = 'task-1-1-abcdef'
  const calls: { command: string; args: string[] }[] = []
  const runGit: GitCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url')) {
      return result('https://github.com/example/repo.git\n')
    }

    if (args.includes('get-url')) {
      assert.ok(args.includes('--all'))

      return result('https://github.com/example/repo.git\nhttps://mirror.example.invalid/other/repo.git\n')
    }

    return result('', 1)
  }
  const runGitHub: GitCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })

    return result()
  }
  const record: WorktreeRecord = {
    repository: 'repo',
    repositoryRoot: '/dev/repo',
    worktreePath: '/dev/repo/.worktree/delivery-test',
    branch: `araya/${taskKey}`,
    base: 'HEAD',
    baseSha: 'a'.repeat(40),
    excludeAdded: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const delivered = await deliverDraftPullRequests({
    taskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha: record.baseSha,
      verificationCount: 1,
      snapshotSha256: 'b'.repeat(64),
      snapshotDiffSha256: 'c'.repeat(64),
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => ({ snapshotSha256: 'b'.repeat(64), diffTruncated: false })
    }],
    preflightSnapshotGuards: [],
    env: { PATH: '/usr/bin' },
    redact: (text) => text
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'blocked')
  assert.equal(delivered.failureReason, 'github_remote_unsupported')
  assert.equal(calls.some((call) => call.args.includes('push') || call.args.includes('commit')), false)
  assert.deepEqual(calls.filter((call) => call.args.includes('get-url')).map((call) => call.args.slice(-4)), [
    ['get-url', '--push', '--all', 'origin']
  ])
})

test('Draft PR delivery rechecks the verified snapshot before committing', async () => {
  const taskKey = 'task-1-1-abcdef'
  const baseSha = 'a'.repeat(40)
  const calls: { command: string; args: string[] }[] = []
  let snapshotReads = 0
  const runGit: GitCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('get-url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('user.name')) {
      return result('Araya Test')
    }

    if (args.includes('user.email')) {
      return result('araya@example.invalid')
    }

    if (args.includes('check-ref-format')) {
      return result()
    }

    if (args.includes('--abbrev-ref')) {
      return result(`araya/${taskKey}`)
    }

    if (args.includes('--verify')) {
      return result(`${baseSha}`)
    }

    if (args.includes('status')) {
      return result(' M README.md')
    }

    return result('', 1)
  }
  const runGitHub: GitCommandRunner = async (_command, args) => {
    calls.push({ command: 'gh', args: [...args] })

    if (args[0] === 'repo') {
      return result(JSON.stringify({ defaultBranchRef: { name: 'main' } }))
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      return result('[]')
    }

    return result()
  }
  const snapshotSha256 = 'b'.repeat(64)
  const record: WorktreeRecord = {
    repository: 'repo',
    repositoryRoot: '/dev/repo',
    worktreePath: '/dev/repo/.worktree/delivery-test',
    branch: `araya/${taskKey}`,
    base: 'HEAD',
    baseSha,
    excludeAdded: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const delivered = await deliverDraftPullRequests({
    taskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha: baseSha,
      verificationCount: 1,
      snapshotSha256,
      snapshotDiffSha256: 'd'.repeat(64),
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => {
        snapshotReads += 1

        return { snapshotSha256: 'c'.repeat(64), diffTruncated: false }
      }
    }],
    preflightSnapshotGuards: [],
    env: { PATH: '/usr/bin' },
    redact: (text) => text
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'failed')
  assert.equal(delivered.failureReason, 'draft_pr_failed')
  assert.equal(snapshotReads, 1)
  assert.equal(calls.some((call) => call.args.some((argument) => argument === 'add' || argument === 'commit' || argument === 'push')), false)
})

test('Draft PR delivery rejects a validated push URL that matches a Git URL rewrite rule', async () => {
  const taskKey = 'task-1-1-abcdef'
  const calls: { command: string; args: string[] }[] = []
  const runGit: GitCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('get-url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('--get-regexp')) {
      return result('url.https://mirror.example.invalid/.insteadof\nhttps://github.com/\0')
    }

    return result('', 1)
  }
  const runGitHub: GitCommandRunner = async (_command, args) => {
    calls.push({ command: 'gh', args: [...args] })

    if (args[0] === 'repo' && args[1] === 'view') {
      return result(JSON.stringify({ defaultBranchRef: { name: 'main' } }))
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      return result('[]')
    }

    return result()
  }
  const record: WorktreeRecord = {
    repository: 'repo',
    repositoryRoot: '/dev/repo',
    worktreePath: '/dev/repo/.worktree/delivery-test',
    branch: `araya/${taskKey}`,
    base: 'HEAD',
    baseSha: 'a'.repeat(40),
    excludeAdded: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const delivered = await deliverDraftPullRequests({
    taskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha: record.baseSha,
      verificationCount: 1,
      snapshotSha256: 'b'.repeat(64),
      snapshotDiffSha256: 'c'.repeat(64),
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => ({ snapshotSha256: 'b'.repeat(64), diffTruncated: false })
    }],
    preflightSnapshotGuards: [],
    env: { PATH: '/usr/bin' },
    redact: (text) => text
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'blocked')
  assert.equal(delivered.failureReason, 'github_remote_unsupported')
  assert.equal(calls.some((call) => call.args.some((argument) => argument === 'commit' || argument === 'push')), false)
})

test('Draft PR delivery rejects a pushInsteadOf rewrite for the verified push URL', async () => {
  const taskKey = 'task-1-1-abcdef'
  const calls: { command: string; args: string[] }[] = []
  const runGit: GitCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('get-url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('--get-regexp')) {
      if (args.at(-1)?.includes('push')) {
        return result('url.https://mirror.example.invalid/.pushinsteadof\nhttps://github.com/\0')
      }

      return result('', 1)
    }

    return result('', 1)
  }
  const runGitHub: GitCommandRunner = async (_command, args) => {
    calls.push({ command: 'gh', args: [...args] })

    if (args[0] === 'repo' && args[1] === 'view') {
      return result(JSON.stringify({ defaultBranchRef: { name: 'main' } }))
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      return result('[]')
    }

    return result()
  }
  const record: WorktreeRecord = {
    repository: 'repo',
    repositoryRoot: '/dev/repo',
    worktreePath: '/dev/repo/.worktree/delivery-test',
    branch: `araya/${taskKey}`,
    base: 'HEAD',
    baseSha: 'a'.repeat(40),
    excludeAdded: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const delivered = await deliverDraftPullRequests({
    taskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha: record.baseSha,
      verificationCount: 1,
      snapshotSha256: 'b'.repeat(64),
      snapshotDiffSha256: 'c'.repeat(64),
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => ({ snapshotSha256: 'b'.repeat(64), diffTruncated: false })
    }],
    preflightSnapshotGuards: [],
    env: { PATH: '/usr/bin' },
    redact: (text) => text
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'blocked')
  assert.equal(delivered.failureReason, 'github_remote_unsupported')
  assert.equal(calls.some((call) => call.args.includes('--get-regexp') && call.args.at(-1)?.includes('push')), true)
  assert.equal(calls.some((call) => call.args.some((argument) => argument === 'commit' || argument === 'push')), false)
})

test('Draft PR delivery refuses to commit when the staged tree differs from the verified snapshot', async () => {
  const taskKey = 'task-1-1-abcdef'
  const baseSha = 'a'.repeat(40)
  const snapshotSha256 = 'b'.repeat(64)
  const calls: { command: string; args: string[] }[] = []
  const runGit: GitCommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('get-url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('--get-regexp')) {
      return result('', 1)
    }

    if (args.includes('user.name')) {
      return result('Araya Test')
    }

    if (args.includes('user.email')) {
      return result('araya@example.invalid')
    }

    if (args.includes('check-ref-format')) {
      return result()
    }

    if (args.includes('--abbrev-ref')) {
      return result(`araya/${taskKey}`)
    }

    if (args.includes('--verify')) {
      return result(baseSha)
    }

    if (args.includes('status')) {
      return result(' M README.md')
    }

    if (args.includes('--cached') && args.includes('--name-only')) {
      return result('README.md\0')
    }

    if (args.includes('--cached')) {
      return result('different staged diff')
    }

    return result()
  }
  const runGitHub: GitCommandRunner = async (_command, args) => {
    calls.push({ command: 'gh', args: [...args] })

    if (args[0] === 'repo' && args[1] === 'view') {
      return result(JSON.stringify({ defaultBranchRef: { name: 'main' } }))
    }

    if (args[0] === 'pr' && args[1] === 'list') {
      return result('[]')
    }

    return result()
  }
  const record: WorktreeRecord = {
    repository: 'repo',
    repositoryRoot: '/dev/repo',
    worktreePath: '/dev/repo/.worktree/delivery-test',
    branch: `araya/${taskKey}`,
    base: 'HEAD',
    baseSha,
    excludeAdded: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const delivered = await deliverDraftPullRequests({
    taskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha: baseSha,
      verificationCount: 1,
      snapshotSha256,
      snapshotDiffSha256: 'c'.repeat(64),
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => ({ snapshotSha256, diffTruncated: false })
    }],
    preflightSnapshotGuards: [],
    env: { PATH: '/usr/bin' },
    redact: (text) => text
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'failed')
  assert.equal(delivered.failureReason, 'draft_pr_failed')
  assert.equal(delivered.worktrees[0]?.draftPrStatus, 'failed')
  assert.equal(calls.some((call) => call.args.includes('add')), true)
  assert.equal(calls.some((call) => call.args.includes('commit') || call.args.includes('push')), false)
})
