import assert from 'node:assert/strict'
import test from 'node:test'

import type { BoundedProcessResult } from '../src/infrastructure/process.ts'
import { deliverDraftPullRequests } from '../src/development/draft-pr/delivery.ts'
import { hashGitDiffSnapshot, splitGitDiffSections } from '../src/development/draft-pr/snapshot.ts'
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
  async function runGit(command: string, args: readonly string[]) {
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
  async function runGitHub(command: string, args: readonly string[]) {
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
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
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
    redact: (text) => {
      return text
    }
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
  async function runGit(command: string, args: readonly string[]) {
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
      return result('araya-test-user')
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
  async function runGitHub(_command: string, args: readonly string[]) {
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
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
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
    redact: (text) => {
      return text
    }
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'failed')
  assert.equal(delivered.failureReason, 'draft_pr_failed')
  assert.equal(snapshotReads, 1)
  assert.equal(calls.some((call) => {
    return call.args.some((argument) => {
      return argument === 'add' || argument === 'commit' || argument === 'push'
    })
  }), false)
})

test('Draft PR delivery rejects a validated push URL that matches a Git URL rewrite rule', async () => {
  const taskKey = 'task-1-1-abcdef'
  const calls: { command: string; args: string[] }[] = []
  async function runGit(command: string, args: readonly string[]) {
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
  async function runGitHub(_command: string, args: readonly string[]) {
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
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
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
    redact: (text) => {
      return text
    }
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
  async function runGit(command: string, args: readonly string[]) {
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
  async function runGitHub(_command: string, args: readonly string[]) {
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
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
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
    redact: (text) => {
      return text
    }
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
  async function runGit(command: string, args: readonly string[]) {
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
      return result('araya-test-user')
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
  async function runGitHub(_command: string, args: readonly string[]) {
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
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
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
    redact: (text) => {
      return text
    }
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

test('Draft PR delivery revalidates a continued workspace after GitHub preflight and before committing', async () => {
  const taskKey = 'task-1-2-abcdef'
  const workspaceTaskKey = 'task-1-1-abcdef'
  const baseSha = 'a'.repeat(40)
  const calls: { command: string; args: string[] }[] = []
  let validations = 0
  async function validateWorkspace() {
    validations += 1

    if (validations === 2) {
      throw new Error('the continuation workspace identity changed')
    }
  }
  async function runGit(command: string, args: readonly string[]) {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url') || args.includes('get-url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('--get-regexp')) {
      return result('', 1)
    }

    if (args.includes('user.name')) {
      return result('Araya Test')
    }

    if (args.includes('user.email')) {
      return result('araya-test-user')
    }

    if (args.includes('check-ref-format')) {
      return result()
    }

    if (args.includes('--abbrev-ref')) {
      return result(`araya/${workspaceTaskKey}`)
    }

    if (args.includes('--verify')) {
      return result(baseSha)
    }

    if (args.includes('status')) {
      return result(' M README.md')
    }

    return result('', 1)
  }
  async function runGitHub(_command: string, args: readonly string[]) {
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
    branch: `araya/${workspaceTaskKey}`,
    base: 'HEAD',
    baseSha,
    excludeAdded: false,
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const snapshotSha256 = 'b'.repeat(64)
  const delivered = await deliverDraftPullRequests({
    taskKey,
    workspaceTaskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha: baseSha,
      verificationCount: 1,
      snapshotSha256,
      snapshotDiffSha256: 'c'.repeat(64),
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => {
        return { snapshotSha256, diffTruncated: false }
      },
      validateWorkspace
    }],
    preflightSnapshotGuards: [{
      record,
      snapshotSha256,
      readSnapshot: async () => {
        return { snapshotSha256, diffTruncated: false }
      },
      validateWorkspace
    }],
    env: { PATH: '/usr/bin' },
    redact: (text) => {
      return text
    }
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'failed')
  assert.equal(delivered.failureReason, 'continuation_workspace_invalid')
  assert.equal(validations, 2)
  assert.equal(calls.some((call) => {
    return call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'list'
  }), true)
  assert.equal(calls.some((call) => {
    return call.args.some((argument) => {
      return argument === 'add' || argument === 'commit' || argument === 'push'
    })
  }), false)
  assert.equal(calls.some((call) => {
    return call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create'
  }), false)
})

test('Draft PR delivery revalidates a continued workspace immediately before push', async () => {
  const taskKey = 'task-1-2-abcdef'
  const workspaceTaskKey = 'task-1-1-abcdef'
  const baseSha = 'a'.repeat(40)
  const headSha = 'b'.repeat(40)
  const diff = [
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n')
  const sections = splitGitDiffSections(diff)
  assert.ok(sections)
  const snapshotDiffSha256 = hashGitDiffSnapshot(['README.md'], sections)
  assert.ok(snapshotDiffSha256)
  const snapshotSha256 = 'c'.repeat(64)
  const calls: { command: string; args: string[] }[] = []
  let validations = 0
  async function validateWorkspace() {
    validations += 1

    if (validations === 7) {
      throw new Error('the continuation workspace identity changed')
    }
  }
  async function runGit(command: string, args: readonly string[]) {
    calls.push({ command, args: [...args] })

    if (args.includes('remote.origin.url') || args.includes('get-url')) {
      return result('https://github.com/example/repo.git')
    }

    if (args.includes('--get-regexp')) {
      return result('', 1)
    }

    if (args.includes('user.name')) {
      return result('Araya Test')
    }

    if (args.includes('user.email')) {
      return result('araya-test-user')
    }

    if (args.includes('check-ref-format')) {
      return result()
    }

    if (args.includes('--abbrev-ref')) {
      return result(`araya/${workspaceTaskKey}`)
    }

    if (args.includes('--verify')) {
      return result(args.at(-1) === 'HEAD^' ? baseSha : headSha)
    }

    if (args.includes('status')) {
      return result('')
    }

    if (args.includes('rev-list')) {
      return result(`${headSha} ${baseSha}`)
    }

    if (args.includes('log')) {
      return result(`Araya-Task: ${workspaceTaskKey}`)
    }

    if (args.includes('diff') && args.includes('--name-only')) {
      return result('README.md\0')
    }

    if (args.includes('diff')) {
      return result(diff)
    }

    return result()
  }
  async function runGitHub(_command: string, args: readonly string[]) {
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
    branch: `araya/${workspaceTaskKey}`,
    base: 'HEAD',
    baseSha,
    excludeAdded: false,
    worktreeIdentity: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const delivered = await deliverDraftPullRequests({
    taskKey,
    workspaceTaskKey,
    title: 'delivery test',
    worktrees: [{
      record,
      headSha,
      verificationCount: 1,
      snapshotSha256,
      snapshotDiffSha256,
      snapshotChangedFiles: ['README.md'],
      readSnapshot: async () => {
        return { snapshotSha256, diffTruncated: false }
      },
      validateWorkspace
    }],
    preflightSnapshotGuards: [{
      record,
      snapshotSha256,
      readSnapshot: async () => {
        return { snapshotSha256, diffTruncated: false }
      },
      validateWorkspace
    }],
    env: { PATH: '/usr/bin' },
    redact: (text) => {
      return text
    }
  }, {
    runGit,
    runGitHub,
    ghExecutable: '/usr/bin/gh'
  })

  assert.equal(delivered.status, 'failed')
  assert.equal(delivered.failureReason, 'continuation_workspace_invalid')
  assert.equal(validations, 7)
  assert.equal(calls.some((call) => {
    return call.args.includes('push')
  }), false)
  assert.equal(calls.some((call) => {
    return call.command === 'gh' && call.args[0] === 'pr' && call.args[1] === 'create'
  }), false)
})
