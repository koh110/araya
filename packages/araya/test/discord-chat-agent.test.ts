import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import {
  DISCORD_CHAT_TASK_LIST_TOOL_NAME,
  DISCORD_CHAT_TASK_SHOW_TOOL_NAME,
  openDiscordChatAgent,
} from '../src/discord/chat-agent.ts'
import { GITHUB_REPOSITORY_LIST_TOOL_NAME } from '../src/discord/github-repositories.ts'
import { createRedactor } from '../src/infrastructure/redaction.ts'
import { openTaskLedger, type AttemptResult } from '../src/runner/ledger.ts'
import { answer, createFauxModels, toolCall } from './support/faux-shiki.ts'
import {
  createRunnerFixture,
  ctx,
  defaultSettings,
  removeRunnerFixture,
  taskInput,
} from './support/runner-fixture.ts'

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

test('discord chat agent: read-only Task tools から判断質問と redacted session excerpt を参照する', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const secret = 'session-private-value-12345'
  const created = ledger.createTask(taskInput({ title: 'Task1', goal: `Task goal with ${secret}` }))
  const claimed = ledger.claimNextAttempt(1, defaultSettings(fixture, null))
  assert.ok(claimed)
  const result: AttemptResult = {
    status: 'blocked',
    failureReason: null,
    failureDetail: null,
    summary: '変更方針を提示しました。',
    decisionQuestion: 'どちらの API を使いますか？',
    model: null,
    evidence: {
      outcome: 'blocked',
      sessionExcerpt: {
        contentScope: 'user-assistant-text',
        truncated: false,
        messages: [
          { role: 'user', text: `Task #1: ${secret} を使う実装を検討してください` },
          { role: 'assistant', text: 'A案とB案を比較しました。どちらを採用しますか？' },
        ],
      },
    },
  }
  assert.deepEqual(
    ledger.recordResult(claimed.taskKey, result, { taskKey: claimed.taskKey, addMs: 10 }),
    {
      recorded: true,
      status: 'blocked',
      failureReason: null,
    },
  )

  const session = await openDiscordChatAgent({
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor([secret]),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
  })
  let listResult = ''
  let invalidIdResult = ''
  models.script((view) => {
    if (view.toolResults.length === 0) {
      return toolCall(DISCORD_CHAT_TASK_LIST_TOOL_NAME, {})
    }

    if (view.toolResults.length === 1) {
      listResult = view.toolResults[0]?.text ?? ''
      const list: { tasks: { id: number; title: string | null }[] } = JSON.parse(listResult)
      const matchingTask = list.tasks.find((task) => {
        return task.title === 'Task1'
      })

      return toolCall(DISCORD_CHAT_TASK_SHOW_TOOL_NAME, {
        taskId: matchingTask === undefined ? '' : String(matchingTask.id),
      })
    }

    if (view.toolResults.length === 2) {
      return toolCall(DISCORD_CHAT_TASK_SHOW_TOOL_NAME, { taskId: 'Task1' })
    }

    invalidIdResult = view.toolResults.at(-1)?.text ?? ''
    return answer(view.toolResults[1]?.text ?? 'Task result missing')
  })

  try {
    const reply = await session.submit('判断待ち内容を確認して', 'message-task-read-1')
    const listed: {
      tasks: { id: number; status: string; decisionQuestion: string | null }[]
    } = JSON.parse(listResult)
    const detail: {
      task: { id: number; status: string; goal: string; goalTruncated: boolean }
      selectedAttempt: {
        decisionQuestion: string
        sessionExcerpt: {
          contentScope: string
          truncated: boolean
          messages: { role: string; text: string }[]
        }
      }
    } = JSON.parse(reply)

    assert.deepEqual(
      listed.tasks.map(({ id, status, decisionQuestion }) => {
        return { id, status, decisionQuestion }
      }),
      [{ id: created.task.id, status: 'blocked', decisionQuestion: 'どちらの API を使いますか？' }],
    )
    assert.equal(invalidIdResult.includes('taskId は正の整数、#1、Task 1 の形式'), true)
    assert.equal(ledger.getTask(created.task.id).status, 'blocked')
    assert.equal(detail.task.id, created.task.id)
    assert.equal(detail.task.status, 'blocked')
    assert.equal(detail.task.goal.includes(secret), false)
    assert.equal(detail.task.goal.includes('[REDACTED]'), true)
    assert.equal(detail.task.goalTruncated, false)
    assert.equal(detail.selectedAttempt.decisionQuestion, 'どちらの API を使いますか？')
    assert.equal(detail.selectedAttempt.sessionExcerpt.contentScope, 'user-assistant-text')
    assert.equal(detail.selectedAttempt.sessionExcerpt.truncated, false)
    assert.deepEqual(
      detail.selectedAttempt.sessionExcerpt.messages.map(({ role }) => {
        return role
      }),
      ['user', 'assistant'],
    )
    assert.equal(reply.includes(secret), false)
    assert.equal(ledger.listTasks({ limit: 10 }).length, 1)
  } finally {
    await session.close?.()
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})

test('discord chat agent: Task2 の確認は読み取り tool を先に実行し、model の誤った拒否を返さない', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const secret = 'task-read-secret-value'
  ledger.createTask(taskInput({ title: 'Unrelated task' }))

  const unrelatedAttempt = ledger.claimNextAttempt(1, defaultSettings(fixture, null))
  assert.ok(unrelatedAttempt)
  ledger.recordResult(
    unrelatedAttempt.taskKey,
    {
      status: 'completed',
      failureReason: null,
      failureDetail: null,
      summary: 'Unrelated task completed.',
      decisionQuestion: null,
      model: null,
      evidence: { taskKey: unrelatedAttempt.taskKey, outcome: 'completed', worktrees: [] },
    },
    { taskKey: unrelatedAttempt.taskKey, addMs: 1 },
  )

  assert.equal(ledger.createTask(taskInput({ title: 'Cleanup target' })).task.id, 2)
  const targetAttempt = ledger.claimNextAttempt(1, defaultSettings(fixture, null))
  assert.ok(targetAttempt)
  ledger.recordResult(
    targetAttempt.taskKey,
    {
      status: 'failed',
      failureReason: 'no_changes',
      failureDetail: null,
      summary: `Cleanup attempt reported no workspace changes; ${secret}`,
      decisionQuestion: null,
      model: null,
      evidence: {
        taskKey: targetAttempt.taskKey,
        outcome: 'failed',
        failureReason: 'no_changes',
        worktrees: [],
      },
    },
    { taskKey: targetAttempt.taskKey, addMs: 1 },
  )

  const originalListTasks = ledger.listTasks.bind(ledger)
  const originalShowTask = ledger.showTask.bind(ledger)
  let listToolCalls = 0
  let showToolCalls = 0
  ledger.listTasks = (filter) => {
    listToolCalls += 1
    return originalListTasks(filter)
  }
  ledger.showTask = (taskId, options) => {
    showToolCalls += 1
    return originalShowTask(taskId, options)
  }

  let modelCalls = 0
  const modelContexts: unknown[][] = []
  models.script((view) => {
    modelCalls += 1
    modelContexts.push([...view.messages])
    return answer('この会話では Task を確認できません。')
  })

  const agentInput = {
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor([secret]),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
  }
  let session = await openDiscordChatAgent(agentInput)

  try {
    const reply = await session.submit(
      'Discord user 401725525703393285 said:\nTask2を確認して',
      'message-task-read-2',
    )

    assert.equal(listToolCalls, 1)
    assert.equal(showToolCalls, 1)
    assert.equal(modelCalls, 0)
    assert.match(reply, /Task #2/u)
    assert.match(reply, /Cleanup target/u)
    assert.match(reply, /状態: 結果未確認 \(no_changes\)/u)
    assert.match(reply, /判定: worktree差分なし/u)
    assert.doesNotMatch(reply, /状態: 失敗|失敗理由: no_changes/u)
    assert.match(reply, /実行報告: Cleanup attempt reported no workspace changes; \[REDACTED\]/u)
    assert.match(reply, /タスク全体や外部操作の成否は未確認/u)
    assert.equal(reply.includes(secret), false)

    for (const [index, request] of [
      'Discord user 401725525703393285 said:\nTask2 の状態表示を修正して',
      'Discord user 401725525703393285 said:\nTask #2 の状態を確認してから修正をお願いします',
      'Discord user 401725525703393285 said:\nTask #2 の状態を確認してから変更を加えてください',
      'Discord user 401725525703393285 said:\nTask #2 の状態を確認してから README を書き換えてください',
      'Discord user 401725525703393285 said:\nTask #2 の結果を見せて、テストをもう一度走らせてください',
    ].entries()) {
      assert.equal(
        await session.submit(request, `message-task-read-mixed-${index + 1}`),
        'この会話では Task を確認できません。',
        request,
      )
    }
    assert.equal(listToolCalls, 1)
    assert.equal(showToolCalls, 1)
    assert.equal(modelCalls, 5)
    assert.match(JSON.stringify(modelContexts[3]), /README/u)
    assert.match(JSON.stringify(modelContexts[4]), /テストをもう一度走らせてください/u)
    for (const contextMessages of modelContexts) {
      const serialized = JSON.stringify(contextMessages)
      assert.match(serialized, /Task #2 — Cleanup target/u)
      assert.match(serialized, /状態: 結果未確認 \(no_changes\)/u)
      assert.equal(serialized.includes(secret), false)
    }

    await session.close?.()
    session = await openDiscordChatAgent(agentInput)
    assert.equal(
      await session.submit('その失敗理由を詳しく説明して', 'message-task-read-follow-up'),
      'この会話では Task を確認できません。',
    )
    assert.equal(modelCalls, 6)
    const reopenedContext = JSON.stringify(modelContexts[5])
    assert.match(reopenedContext, /Task #2 — Cleanup target/u)
    assert.match(reopenedContext, /判定: worktree差分なし/u)

    await session.close?.()
    const historyHarness = await Harness.open(
      await openNodeSqliteStorage(path.join(fixture.dataDir, 'discord', 'chat.sqlite')),
      { models: models.runtime, registry: createRegistry() },
      ctx,
    )

    try {
      const history = await (await historyHarness.root(ctx)).context(ctx)
      const readEntry = history.entries.find((entry) => {
        return entry.kind === 'araya.discord.task-read'
      })

      assert.ok(readEntry)
      assert.deepEqual(readEntry.data, {
        reply,
        toolsUsed: [DISCORD_CHAT_TASK_LIST_TOOL_NAME, DISCORD_CHAT_TASK_SHOW_TOOL_NAME],
      })
      assert.deepEqual(
        readEntry.model?.map((message) => {
          return message.role
        }),
        ['user', 'assistant'],
      )
      assert.match(JSON.stringify(readEntry.model), /Task #2 — Cleanup target/u)
      assert.equal(JSON.stringify(readEntry.model).includes(secret), false)
      assert.match(JSON.stringify(history.messages), /状態: 結果未確認 \(no_changes\)/u)
    } finally {
      await historyHarness.close(ctx)
    }
  } finally {
    await session.close?.()
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})

test('discord chat agent: 明示した試行番号の結果を選んで返す', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const ledger = openTaskLedger(fixture.dataDir)
  const task = ledger.createTask(taskInput({ title: 'Attempt selector target' })).task
  const first = ledger.claimNextAttempt(1, defaultSettings(fixture, null))
  assert.ok(first)
  ledger.recordResult(
    first.taskKey,
    {
      status: 'failed',
      failureReason: 'verification_failed',
      failureDetail: null,
      summary: '試行1だけの報告',
      decisionQuestion: null,
      model: null,
      evidence: {
        taskKey: first.taskKey,
        outcome: 'failed',
        failureReason: 'verification_failed',
        worktrees: [],
      },
    },
    { taskKey: first.taskKey, addMs: 1 },
  )
  ledger.retryTask(task.id, { note: null, confirmSideEffects: false })
  const second = ledger.claimNextAttempt(1, defaultSettings(fixture, null))
  assert.ok(second)
  ledger.recordResult(
    second.taskKey,
    {
      status: 'completed',
      failureReason: null,
      failureDetail: null,
      summary: '試行2だけの報告',
      decisionQuestion: null,
      model: null,
      evidence: { taskKey: second.taskKey, outcome: 'completed', worktrees: [] },
    },
    { taskKey: second.taskKey, addMs: 1 },
  )

  let modelCalls = 0
  models.script(() => {
    modelCalls += 1
    return answer('この会話では Task を確認できません。')
  })
  const session = await openDiscordChatAgent({
    dataDir: fixture.dataDir,
    ledger,
    redactor: createRedactor([]),
    models: models.runtime,
    model: modelRef(models),
    context: ctx,
  })

  try {
    const reply = await session.submit('Task #1 の試行1の結果を確認して', 'message-task-attempt-1')
    assert.match(reply, /試行: #1（失敗 \(failed\)）/u)
    assert.match(reply, /試行1だけの報告/u)
    assert.doesNotMatch(reply, /試行2だけの報告/u)
    assert.equal(modelCalls, 0)
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
        fetch: async () => {
          return new Response(
            JSON.stringify([{ name: 'README.md', path: 'README.md', type: 'file', size: 80 }]),
            { status: 200 },
          )
        },
      },
    }

    originalSession = await openDiscordChatAgent(input)
    await originalSession.close?.()

    const storagePath = path.join(fixture.dataDir, 'discord', 'chat.sqlite')
    const storage = await openNodeSqliteStorage(storagePath)
    const legacyHarness = await Harness.open(
      storage,
      {
        models: models.runtime,
        registry: createRegistry(),
      },
      ctx,
    )

    try {
      const root = await legacyHarness.root(ctx)
      await root.configure(
        {
          tools: [],
          modelTools: [],
          instructions: 'Legacy instructions without GitHub repository tools.',
        },
        ctx,
      )
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
      fetch: async () => {
        return new Response(
          JSON.stringify([{ name: 'README.md', path: 'README.md', type: 'file', size: 80 }]),
          { status: 200 },
        )
      },
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
