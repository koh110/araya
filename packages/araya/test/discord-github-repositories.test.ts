import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGitHubRepositoryTools,
  GITHUB_REPOSITORY_LIST_TOOL_NAME,
  GITHUB_REPOSITORY_READ_TOOL_NAME,
  GITHUB_REPOSITORY_SEARCH_TOOL_NAME,
} from '../src/discord/github-repositories.ts'
import { createRedactor } from '../src/infrastructure/redaction.ts'

function getTool(
  tools: ReturnType<typeof createGitHubRepositoryTools>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool)

  return tool
}

test('github repository list: public directory contents use the anonymous GitHub API', async () => {
  let requestedUrl = ''
  let ghWasCalled = false
  const tools = createGitHubRepositoryTools({
    cwd: '/tmp/araya-test',
    env: {},
    redactor: createRedactor([]),
    fetch: async (input) => {
      requestedUrl = String(input)

      return new Response(JSON.stringify([
        { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 120 },
        { name: 'lib', path: 'src/lib', type: 'dir', size: 0 },
      ]), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    launch: async () => {
      ghWasCalled = true
      throw new Error('public read should not need gh auth')
    },
  })

  const result = await getTool(tools, GITHUB_REPOSITORY_LIST_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', path: 'src' } as never,
    { callId: 'github-list-public' } as never,
    {} as never,
  )

  assert.equal(new URL(requestedUrl).pathname, '/repos/octo/project/contents/src')
  assert.equal(new URL(requestedUrl).searchParams.get('per_page'), '100')
  assert.equal(ghWasCalled, false)
  assert.match(JSON.stringify(result.output), /index\.ts/u)
  assert.match(JSON.stringify(result.output), /src\/lib/u)
})

test('github repository list: non-GitHub GH_HOST skips anonymous GitHub.com API calls', async () => {
  let fetchCalls = 0
  let launchedCommand = ''
  let launchedArgs: readonly string[] = []
  let childEnvironment: Readonly<Record<string, string | undefined>> | undefined
  const listing = [{ name: 'README.md', path: 'README.md', type: 'file' }]
  const tools = createGitHubRepositoryTools({
    cwd: '/srv/araya',
    env: {
      HOME: '/home/araya',
      PATH: '/usr/bin:/bin',
      GH_HOST: 'github.enterprise.invalid',
    },
    redactor: createRedactor([]),
    fetch: async () => {
      fetchCalls += 1
      return new Response('[]', { status: 200 })
    },
    launch: async (command, args, options) => {
      launchedCommand = command
      launchedArgs = args
      childEnvironment = options.env
      const stdout = JSON.stringify(listing)

      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }
    },
  })
  const result = await getTool(tools, GITHUB_REPOSITORY_LIST_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', path: '' } as never,
    { callId: 'github-list-enterprise' } as never,
    {} as never,
  )

  assert.equal(fetchCalls, 0)
  assert.equal(launchedCommand, 'gh')
  assert.ok(launchedArgs.includes('repos/octo/project/contents'))
  assert.equal(childEnvironment?.GH_HOST, 'github.enterprise.invalid')
  assert.ok(JSON.stringify(result.output).includes('README.md'))
})

test('github repository list: private directory falls back to gh with only a GET API request', async () => {
  let launchedCommand = ''
  let launchedArgs: readonly string[] = []
  let childEnvironment: Readonly<Record<string, string | undefined>> | undefined
  const privateListing = [
    { name: 'README.md', path: 'README.md', type: 'file', size: 300 },
  ]
  const tools = createGitHubRepositoryTools({
    cwd: '/srv/araya',
    env: {
      HOME: '/home/araya',
      PATH: '/usr/bin:/bin',
      GH_TOKEN: 'synthetic-gh-token',
      GH_ENTERPRISE_TOKEN: 'synthetic-gh-enterprise-token',
      GITHUB_TOKEN: 'synthetic-github-token',
      GITHUB_ENTERPRISE_TOKEN: 'synthetic-github-enterprise-token',
      UNRELATED_SECRET: 'must-not-be-inherited',
    },
    redactor: createRedactor(['synthetic-gh-token']),
    fetch: async () => new Response('not found', { status: 404 }),
    launch: async (command, args, options) => {
      launchedCommand = command
      launchedArgs = args
      childEnvironment = options.env
      const stdout = JSON.stringify(privateListing)

      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }
    },
  })

  const result = await getTool(tools, GITHUB_REPOSITORY_LIST_TOOL_NAME).execute(
    { owner: 'octo', repo: 'private-project', path: '' } as never,
    { callId: 'github-list-private' } as never,
    {} as never,
  )

  assert.equal(launchedCommand, 'gh')
  assert.ok(launchedArgs.includes('repos/octo/private-project/contents'))
  assert.ok(launchedArgs.includes('GET'))
  assert.ok(!launchedArgs.some((arg) => ['POST', 'PATCH', 'DELETE'].includes(arg)))
  assert.equal(childEnvironment?.HOME, '/home/araya')
  assert.equal(childEnvironment?.GH_TOKEN, undefined)
  assert.equal(childEnvironment?.GH_ENTERPRISE_TOKEN, undefined)
  assert.equal(childEnvironment?.GITHUB_TOKEN, undefined)
  assert.equal(childEnvironment?.GITHUB_ENTERPRISE_TOKEN, undefined)
  assert.equal(childEnvironment?.GH_PROMPT_DISABLED, '1')
  assert.equal(childEnvironment?.UNRELATED_SECRET, undefined)
  assert.match(JSON.stringify(result.output), /README\.md/u)
})

test('github repository search: queries are scoped to the requested repository and exclude other results', async () => {
  let launchedArgs: readonly string[] = []
  const searchResponse = {
    total_count: 2,
    incomplete_results: false,
    items: [
      {
        name: 'matches.ts',
        path: 'src/matches.ts',
        html_url: 'https://github.com/octo/project/blob/main/src/matches.ts',
        repository: { full_name: 'octo/project' },
      },
      {
        name: 'other.ts',
        path: 'src/other.ts',
        html_url: 'https://github.com/octo/other/blob/main/src/other.ts',
        repository: { full_name: 'octo/other' },
      },
    ],
  }
  const tools = createGitHubRepositoryTools({
    cwd: '/srv/araya',
    env: { HOME: '/home/araya', PATH: '/usr/bin:/bin' },
    redactor: createRedactor([]),
    fetch: async () => new Response('requires authentication', { status: 401 }),
    launch: async (_command, args) => {
      launchedArgs = args
      const stdout = JSON.stringify(searchResponse)

      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: '',
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }
    },
  })

  const result = await getTool(tools, GITHUB_REPOSITORY_SEARCH_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', query: '@/etc/passwd' } as never,
    { callId: 'github-search' } as never,
    {} as never,
  )
  const output = JSON.stringify(result.output)
  const outputBlock = result.output?.[0]
  assert.ok(outputBlock !== undefined && 'text' in outputBlock)
  const payload = JSON.parse(outputBlock.text) as { total_count: number; incomplete_results: boolean }

  assert.ok(launchedArgs.includes('search/code'))
  assert.equal(payload.total_count, 2)
  assert.equal(payload.incomplete_results, false)
  assert.ok(launchedArgs.includes('--raw-field'))
  assert.ok(launchedArgs.includes('q=repo:octo/project @/etc/passwd'))
  assert.ok(launchedArgs.includes('GET'))
  assert.match(output, /src\/matches\.ts/u)
  assert.doesNotMatch(output, /octo\/other/u)
})

test('github repository search: incomplete status is preserved in the result', async () => {
  const tools = createGitHubRepositoryTools({
    cwd: '/srv/araya',
    env: {},
    redactor: createRedactor([]),
    fetch: async () => new Response(JSON.stringify({
      total_count: 0,
      incomplete_results: true,
      items: [],
    }), { status: 200 }),
  })
  const result = await getTool(tools, GITHUB_REPOSITORY_SEARCH_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', query: 'unlikely-marker' } as never,
    { callId: 'github-search-incomplete' } as never,
    {} as never,
  )
  const outputBlock = result.output?.[0]
  assert.ok(outputBlock !== undefined && 'text' in outputBlock)
  const payload = JSON.parse(outputBlock.text) as { total_count: number; incomplete_results: boolean }

  assert.equal(payload.total_count, 0)
  assert.equal(payload.incomplete_results, true)
})

test('github repository search: caller-supplied repository scope qualifiers are rejected', async () => {
  for (const query of [
    'needle repo:octo/other',
    'needle org:other',
    'needle user:other',
    'needle "',
    'needle (',
    'needle )',
  ]) {
    let calls = 0
    const tools = createGitHubRepositoryTools({
      cwd: '/srv/araya',
      env: {},
      redactor: createRedactor([]),
      fetch: async () => {
        calls += 1
        return new Response('{"total_count":0,"items":[]}', { status: 200 })
      },
      launch: async () => {
        calls += 1
        throw new Error('invalid search must not call gh')
      },
    })
    const result = await getTool(tools, GITHUB_REPOSITORY_SEARCH_TOOL_NAME).execute(
      { owner: 'octo', repo: 'project', query } as never,
      { callId: 'github-search-scope-injection' } as never,
      {} as never,
    )

    assert.equal(result.isError, true, query)
    assert.equal(calls, 0, query)
  }
})

test('github repository read: file contents are decoded, bounded and redacted', async () => {
  let requestedUrl = ''
  const source = 'export const token = "synthetic-gh-token";\nexport const answer = 42;\n'
  const tools = createGitHubRepositoryTools({
    cwd: '/tmp/araya-test',
    env: {},
    redactor: createRedactor(['synthetic-gh-token']),
    fetch: async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(source).toString('base64'),
        size: Buffer.byteLength(source),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const result = await getTool(tools, GITHUB_REPOSITORY_READ_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', path: 'src/config.ts', ref: 'main' } as never,
    { callId: 'github-read-public' } as never,
    {} as never,
  )
  const output = JSON.stringify(result.output)

  assert.equal(new URL(requestedUrl).pathname, '/repos/octo/project/contents/src/config.ts')
  assert.equal(new URL(requestedUrl).searchParams.get('ref'), 'main')
  assert.match(output, /export const answer = 42/u)
  assert.match(output, /\[REDACTED\]/u)
  assert.doesNotMatch(output, /synthetic-gh-token/u)
})

test('github repository list: path traversal is rejected before any network or subprocess call', async () => {
  let calls = 0
  const tools = createGitHubRepositoryTools({
    cwd: '/srv/araya',
    env: {},
    redactor: createRedactor([]),
    fetch: async () => {
      calls += 1
      return new Response('[]', { status: 200 })
    },
    launch: async () => {
      calls += 1
      throw new Error('must not launch')
    },
  })
  const result = await getTool(tools, GITHUB_REPOSITORY_LIST_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', path: '../secret' } as never,
    { callId: 'github-list-invalid-path' } as never,
    {} as never,
  )

  assert.equal(calls, 0)
  assert.equal(result.isError, true)
})

test('github repository read: gh stderr and token are never returned on authorization failure', async () => {
  const secret = 'private-gh-token-value'
  const tools = createGitHubRepositoryTools({
    cwd: '/srv/araya',
    env: { HOME: '/home/araya', PATH: '/usr/bin:/bin', GH_TOKEN: secret },
    redactor: createRedactor([secret]),
    fetch: async () => new Response('not found', { status: 404 }),
    launch: async () => ({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: `authentication failed: ${secret}`,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(`authentication failed: ${secret}`),
      terminationReason: undefined,
      terminationConfirmed: true,
    }),
  })
  const result = await getTool(tools, GITHUB_REPOSITORY_READ_TOOL_NAME).execute(
    { owner: 'octo', repo: 'private-project', path: 'README.md' } as never,
    { callId: 'github-read-denied' } as never,
    {} as never,
  )
  const output = JSON.stringify(result.output)

  assert.equal(result.isError, true)
  assert.doesNotMatch(output, /private-gh-token-value/u)
  assert.doesNotMatch(output, /authentication failed/u)
})

test('github repository read: long text is truncated at the documented character limit', async () => {
  const source = 'x'.repeat(24_001)
  const tools = createGitHubRepositoryTools({
    cwd: '/tmp/araya-test',
    env: {},
    redactor: createRedactor([]),
    fetch: async () => new Response(JSON.stringify({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(source).toString('base64'),
      size: Buffer.byteLength(source),
    }), { status: 200 }),
  })
  const result = await getTool(tools, GITHUB_REPOSITORY_READ_TOOL_NAME).execute(
    { owner: 'octo', repo: 'project', path: 'large.txt' } as never,
    { callId: 'github-read-large' } as never,
    {} as never,
  )
  const block = result.output?.[0]
  assert.ok(block !== undefined && 'text' in block)
  const payload = JSON.parse(block.text) as { content: string; truncated: boolean }

  assert.equal(Array.from(payload.content).length, 24_000)
  assert.equal(payload.truncated, true)
})
