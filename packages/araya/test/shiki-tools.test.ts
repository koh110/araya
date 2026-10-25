import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createRegistry, defineExtension, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'

import {
  buildShikiInstructions,
  buildSystemPrompt,
  buildTaskBody,
  createShikiTools,
  SHIKI_TOOL_NAMES
} from '../src/shiki.ts'
import { createFakeSystemd } from './support/fake-systemd.ts'
import { answer, createFauxModels, toolCall } from './support/faux-shiki.ts'
import { createRepository, createRunnerFixture, ctx, removeRunnerFixture } from './support/runner-fixture.ts'

const EMPTY_BODY = {
  goal: '空の入力を拒否する',
  constraints: [],
  targets: [],
  permissions: [],
  note: null,
  previous: null
}

test('shiki: 課題の本文は値のある項目だけを決まった順に組み立てる', () => {
  assert.equal(buildTaskBody(EMPTY_BODY), '目的:\n空の入力を拒否する')
  assert.equal(buildTaskBody({
    goal: '空の入力を拒否する',
    constraints: ['依存を追加しない', 'API を変えない'],
    targets: ['araya'],
    permissions: ['push してよい'],
    note: '前回の質問への答え: A を使う',
    previous: {
      attempt: 1,
      status: 'blocked',
      failureReason: null,
      summary: '質問しました',
      decisionQuestion: 'A と B のどちらを使いますか',
      worktrees: [{ worktreePath: '/dev/araya/.worktree/araya-task-1-1-abcdef', branch: 'araya/task-1-1-abcdef' }],
      interrupted: false
    }
  }), [
    '目的:',
    '空の入力を拒否する',
    '',
    '制約:',
    '- 依存を追加しない',
    '- API を変えない',
    '',
    '作業対象の手がかり（必要な repository は自分で判断してよい）:',
    '- araya',
    '',
    'この Task で許可されていること（commit、push、PR の作成、merge、deploy、publish は、ここに書かれていても行わない）:',
    '- push してよい',
    '',
    '前回の試行（1回目）の結果:',
    '- 結果: blocked',
    '- 報告: 質問しました',
    '- 人への質問: A と B のどちらを使いますか',
    '- 前回の worktree（編集しない。必要なら読んでよい）:',
    '  - /dev/araya/.worktree/araya-task-1-1-abcdef（branch araya/task-1-1-abcdef）',
    '',
    '追加の指示:',
    '前回の質問への答え: A を使う'
  ].join('\n'))
})

test('shiki: 前回の試行の報告は先頭 4000 文字までで、途中で止まった試行には注意の1行を足す', () => {
  const body = buildTaskBody({
    ...EMPTY_BODY,
    previous: {
      attempt: 2,
      status: 'failed',
      failureReason: 'agent_timeout',
      summary: 'あ'.repeat(5000),
      decisionQuestion: null,
      worktrees: [],
      interrupted: true
    }
  })

  assert.equal(body, [
    '目的:',
    '空の入力を拒否する',
    '',
    '前回の試行（2回目）の結果:',
    '- 結果: failed（agent_timeout）',
    `- 報告: ${'あ'.repeat(4000)}`,
    '- 注意: 前回の試行は作業の途中で止まりました。外部への変更が済んでいる可能性があります。同じ操作をくり返す前に、前回の worktree と外部の状態を確かめてください。'
  ].join('\n'))
})

test('shiki: instructions は既存の system prompt に判断の依頼と tool の制約の2文を足したもの', () => {
  const input = { devRoot: '/home/araya/dev', taskKey: 'task-1-1-abcdef' }

  assert.equal(buildShikiInstructions(input), [
    buildSystemPrompt(input),
    '',
    '人の判断が無いと進められないときは、推測で進めずに araya_request_decision で質問し、作業を終えてください',
    'grep・find・ls の tool はありません。必要なら bash で実行してください'
  ].join('\n'))
})

test('shiki: tool は read・edit・write・bash と araya の3つの7種類', () => {
  const tools = createShikiTools({
    dataDir: '/tmp/araya-data',
    hash: '0123456789ab',
    systemd: createFakeSystemd().ops,
    env: {},
    resolveAttempt: async () => {
      return undefined
    }
  })

  assert.deepEqual(tools.map((tool) => {
    return tool.name
  }), [...SHIKI_TOOL_NAMES])
  assert.deepEqual([...SHIKI_TOOL_NAMES], [
    'read',
    'edit',
    'write',
    'bash',
    'araya_create_worktree',
    'araya_register_verification',
    'araya_request_decision'
  ])
})

test('shiki: 試行の会話でなければ、bash は command を動かさずに失敗し、araya の tool も誤りを返す', async () => {
  const fixture = await createRunnerFixture()
  const models = await createFauxModels(fixture)
  const systemd = createFakeSystemd()
  const marker = path.join(fixture.root, 'bash-ran')
  const results: { toolName: string; isError: boolean; text: string }[] = []
  const tools = createShikiTools({
    dataDir: fixture.dataDir,
    hash: fixture.hash,
    systemd: systemd.ops,
    env: fixture.env,
    resolveAttempt: async () => {
      return undefined
    }
  })
  const registry = createRegistry()
  const extension = defineExtension({ name: 'shiki-test', tools })
  registry.install(extension)
  const harness = await Harness.open(new MemoryStorage(), {
    models: models.runtime,
    registry,
    env: ({ cwd }) => {
      return new NodeExecutionEnv({ cwd: cwd ?? fixture.devRoot, shellEnv: fixture.env })
    }
  }, ctx)

  try {
    await createRepository(fixture, 'repo')
    harness.resume()
    models.script((view) => {
      results.splice(0, results.length, ...view.toolResults)

      switch (view.toolResults.length) {
        case 0:
          return toolCall('bash', { command: `touch ${marker}` })
        case 1:
          return toolCall('araya_create_worktree', { repository: 'repo' })
        case 2:
          return toolCall('araya_request_decision', { question: '質問' })
        default:
          return answer('done')
      }
    })
    const root = await harness.root(ctx, {
      agent: {
        model: { provider: models.model.provider, modelId: models.model.id },
        extensions: [extension],
        tools,
        cwd: fixture.devRoot,
        instructions: 'test'
      }
    })
    const settled = await (await root.submit({ type: 'input', content: 'go', requestId: 'r1' }, ctx)).wait(ctx)

    assert.equal(settled.status, 'done')
    assert.deepEqual(results.map(({ toolName, isError }) => {
      return { toolName, isError }
    }), [
      { toolName: 'bash', isError: true },
      { toolName: 'araya_create_worktree', isError: true },
      { toolName: 'araya_request_decision', isError: true }
    ])
    assert.match(results[1]?.text ?? '', /attempt_not_found/u)
    await assert.rejects(fs.access(marker))
    assert.deepEqual(systemd.launches(), [])
  } finally {
    await harness.close(ctx)
    await removeRunnerFixture(fixture)
  }
})
