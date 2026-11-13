import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { openDiscordChatAgent } from '../src/discord/chat-agent.ts'
import { GITHUB_REPOSITORY_LIST_TOOL_NAME } from '../src/discord/github-repositories.ts'
import { createRedactor } from '../src/infrastructure/redaction.ts'
import { openTaskLedger } from '../src/runner/ledger.ts'
import { answer, createFauxModels, toolCall } from './support/faux-shiki.ts'
import { createRunnerFixture, ctx, removeRunnerFixture } from './support/runner-fixture.ts'

function modelRef(models: Awaited<ReturnType<typeof createFauxModels>>) {
  return {
    provider: models.model.provider,
    modelId: models.model.id,
    thinkingLevel: 'medium' as const,
  }
}

test('discord chat agent: durable storage を再openしても conversation を使える', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const input = {
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor([]),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
  }

  models.script(function script() {
    return answer('継続中の会話です')
  })

  try {
    const first = await openDiscordChatAgent(input)
    assert.equal(await first.submit('最初の入力', 'message-1'), '継続中の会話です')
    await first.close?.()

    const second = await openDiscordChatAgent(input)
    assert.equal(await second.submit('続きの入力', 'message-2'), '継続中の会話です')
    await second.close?.()

    assert.equal(ledger.listTasks({ limit: 10 }).length, 0)
    assert.equal(
      (await fs.stat(path.join(fixture.dataDir, 'discord', 'chat.sqlite'))).mode & 0o777,
      0o600,
    )
    assert.equal((await fs.stat(path.join(fixture.dataDir, 'discord'))).mode & 0o777, 0o700)
  } finally {
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})

test('discord chat agent: araya_submit_task だけが既存 ledger に Task を作り、同じ input は重複しない', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const session = await openDiscordChatAgent({
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor(['secret-value']),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
  })
  let toolCalls = 0
  models.script((view) => {
    if (view.toolResults.length === 0) {
      toolCalls += 1
      return toolCall('araya_submit_task', {
        title: 'Discord chat task',
        goal: 'secret-value を除去した task body を保存する',
      })
    }

    return answer(view.toolResults[0]?.text ?? 'Task result missing')
  })

  try {
    const taskReply = await session.submit('実装をお願いします', 'message-task-1')
    assert.match(taskReply, /^Task #\d+ を既存 Task runner に登録しました（待ち）。$/u)
    assert.equal(await session.submit('実装をお願いします', 'message-task-1'), taskReply)

    const tasks = ledger.listTasks({ limit: 10 })
    const task = tasks[0] === undefined ? null : ledger.showTask(tasks[0].id, { events: 0 }).task
    assert.equal(toolCalls, 1)
    assert.equal(tasks.length, 1)
    assert.equal(task?.title, 'Discord chat task')
    assert.equal(task?.goal.includes('secret-value'), false)
    assert.equal(task?.goal.includes('[REDACTED]'), true)
    assert.deepEqual(task?.permissions, [])
  } finally {
    await session.close?.()
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})

test('discord chat agent: 同じ reset message の再送で後続会話を消さない', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const session = await openDiscordChatAgent({
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor([]),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
  })
  models.script((view) => {
    return answer(view.prompt)
  })

  try {
    await session.submit('before reset', 'before-reset-1')
    await session.reset('reset-message-1')
    const afterReset = await session.submit('after reset', 'after-reset-1')
    assert.match(afterReset, /after reset/u)

    await session.reset('reset-message-1')
    const afterReplay = await session.submit('after replay', 'after-replay-1')
    assert.match(afterReplay, /after reset/u)
  } finally {
    await session.close?.()
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})

test('discord chat agent: existing root configuration is upgraded to expose GitHub tools', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  let originalSession: Awaited<ReturnType<typeof openDiscordChatAgent>> | undefined
  let upgradedSession: Awaited<ReturnType<typeof openDiscordChatAgent>> | undefined

  try {
    const input = {
      dataDir: fixture.dataDir,
      ledger,
      redactor: createRedactor([]),
      models: models.runtime,
      model: modelRef(models),
      context: ctx,
      github: {
        env: {},
        fetch: async () => new Response(JSON.stringify([
          { name: 'README.md', path: 'README.md', type: 'file', size: 80 },
        ]), { status: 200 }),
      },
    }

    originalSession = await openDiscordChatAgent(input)
    await originalSession.close?.()

    const storagePath = path.join(fixture.dataDir, 'discord', 'chat.sqlite')
    const storage = await openNodeSqliteStorage(storagePath)
    const legacyHarness = await Harness.open(storage, {
      models: models.runtime,
      registry: createRegistry(),
    }, ctx)

    try {
      const root = await legacyHarness.root(ctx)
      await root.configure({
        tools: [],
        modelTools: [],
        instructions: 'Legacy instructions without GitHub repository tools.',
      }, ctx)
    } finally {
      await legacyHarness.close(ctx)
    }

    models.script((view) => {
      if (view.toolResults.length === 0) {
        return toolCall(GITHUB_REPOSITORY_LIST_TOOL_NAME, { owner: 'octo', repo: 'project' })
      }

      return answer(view.toolResults[0]?.text ?? 'GitHub result missing')
    })
    upgradedSession = await openDiscordChatAgent(input)
    const reply = await upgradedSession.submit('octo/project を読む', 'message-github-upgrade-1')

    assert.ok(reply.includes('README.md'))
  } finally {
    await upgradedSession?.close?.()
    await originalSession?.close?.()
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})

test('discord chat agent: repository read-only tool を conversation に登録して実行する', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const session = await openDiscordChatAgent({
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor([]),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
    github: {
      env: {},
      fetch: async () => new Response(JSON.stringify([
        { name: 'README.md', path: 'README.md', type: 'file', size: 80 },
      ]), { status: 200 }),
    },
  })
  models.script((view) => {
    if (view.toolResults.length === 0) {
      return toolCall(GITHUB_REPOSITORY_LIST_TOOL_NAME, { owner: 'octo', repo: 'project' })
    }

    return answer(view.toolResults[0]?.text ?? 'GitHub result missing')
  })

  try {
    const reply = await session.submit('octo/project のファイル一覧を見て', 'message-github-1')
    assert.match(reply, /README\.md/u)
  } finally {
    await session.close?.()
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})
