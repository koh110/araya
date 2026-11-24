import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, vi } from 'vite-plus/test'

import { Harness } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

import { openArayaAgentHost } from './host.ts'
import { createRedactor } from '../infrastructure/redaction.ts'
import { answer, createFauxModels, toolCall } from '../../test/support/faux-shiki.ts'

async function makeAgentFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-agent-host-test-')))
  const dataDir = path.join(root, 'data')
  const devRoot = path.join(root, 'dev')
  const agentDir = path.join(root, 'pi')

  for (const dir of [dataDir, devRoot, agentDir]) {
    await fs.mkdir(dir, { recursive: true })
  }

  return { root, dataDir, devRoot, agentDir }
}

async function removeAgentFixture(fixture: Awaited<ReturnType<typeof makeAgentFixture>>) {
  await fs.rm(fixture.root, { recursive: true, force: true })
}

async function waitUntil(cond: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (cond()) {
      return true
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }

  return cond()
}

test('agent host: task tool の spawn で child が作業し、報告が main 経由で deliverReport に届き、reopen でも name 対応が続く', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  const reports: { name: string; text: string }[] = []

  const openHost = async () => {
    return await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: { provider: models.model.provider, modelId: models.model.id, thinkingLevel: 'medium' },
      redactor: createRedactor(['secret-value']),
      deliverReport: async (name, text) => {
        reports.push({ name, text })
      },
      context: BACKGROUND_CONTEXT,
    })
  }

  try {
    // main: spawn を呼んで tool 結果を受けたら要約。child: 依頼を受けて答えだけ返す
    models.script((view) => {
      if (view.prompt.includes('CHILD-WORK')) {
        return answer('child 作業完了')
      }

      if (view.toolResults.length === 0) {
        return toolCall('task', { action: 'spawn', name: 'worker-1', message: 'CHILD-WORK を実施' })
      }

      return answer('main まとめ secret-value')
    })

    const first = await openHost()

    try {
      const answerText = await first.submit('メイン依頼', 'message-1')
      assert.match(answerText, /main まとめ/)
      assert.doesNotMatch(answerText, /secret-value/u)

      assert.ok(
        await waitUntil(() => {
          return reports.length > 0
        }, 20_000),
        'deliverReport が呼ばれなかった',
      )
      assert.equal(reports[0]?.name, 'worker-1')
      assert.match(reports[0]?.text ?? '', /main まとめ/u)
    } finally {
      await first.close()
    }

    // reopen: session-scoped document で child の name 対応が残り、status から一覧できる
    // main の context には過去の tool result が残るので、この session の turn 番号で分岐する
    let statusTurn = 0

    models.script((view) => {
      statusTurn += 1

      if (statusTurn === 1) {
        return toolCall('task', { action: 'status', name: 'worker-1' })
      }

      return answer(view.toolResults.at(-1)?.text ?? '')
    })

    const second = await openHost()

    try {
      const status = await second.submit('STATUS-CHECK', 'message-2')
      assert.match(status, /"name":"worker-1"/u)

      // 同じ name の spawn は child を増やさない
      let dupTurn = 0

      models.script((view) => {
        dupTurn += 1

        if (dupTurn === 1) {
          return toolCall('task', { action: 'spawn', name: 'worker-1', message: 'CHILD-WORK 2' })
        }

        return answer('dup-rejected')
      })

      assert.equal(await second.submit('DUPLICATE-SPAWN', 'message-3'), 'dup-rejected')
      assert.equal(reports.length, 1)
    } finally {
      await second.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})

test('agent host: describe から実行中 child の処理種別・経過時間を取得できる', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  const progress: string[] = []
  const reports: string[] = []

  try {
    models.script((view) => {
      if (view.prompt.includes('CHILD-WORK')) {
        if (view.toolResults.length === 0) {
          return toolCall('bash', {
            command:
              'while [ ! -f .child-progress-release ]; do sleep 0.02; done; printf child-secret',
          })
        }

        return answer('child 作業完了')
      }

      if (view.toolResults.length === 0) {
        return toolCall('task', {
          action: 'spawn',
          name: 'progress-worker',
          message: 'CHILD-WORK を実施',
        })
      }

      return answer('main 作業完了')
    })

    const host = await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: {
        provider: models.model.provider,
        modelId: models.model.id,
        thinkingLevel: 'medium' as const,
      },
      redactor: createRedactor(['child-secret']),
      deliverReport: async (_name: string, text: string) => {
        reports.push(text)
      },
      deliverProgress: async (text: string) => {
        progress.push(text)
      },
      context: BACKGROUND_CONTEXT,
    })

    try {
      assert.equal(await host.submit('child 進捗テスト', 'child-progress-1'), 'main 作業完了')
      assert.ok(
        await waitUntil(() => {
          return progress.some((message) => {
            return message.includes('background task: コマンドを実行中')
          })
        }, 5_000),
        `child の進捗通知が届かなかった: ${progress.join(' | ')} / ${JSON.stringify(host.describe().progress)}`,
      )

      const description = host.describe()
      const state =
        typeof description === 'object' && description !== null && 'progress' in description
          ? description.progress
          : null
      assert.ok(typeof state === 'object' && state !== null && 'children' in state)
      assert.ok(Array.isArray(state.children))
      const child = state.children.find((candidate) => {
        return (
          typeof candidate === 'object' &&
          candidate !== null &&
          'name' in candidate &&
          candidate.name === 'progress-worker'
        )
      })
      assert.ok(
        typeof child === 'object' &&
          child !== null &&
          'operation' in child &&
          'phaseStartedAtMs' in child &&
          'phaseStartedAtIsEstimated' in child,
      )
      assert.equal(child.operation, 'bash')
      assert.equal(typeof child.phaseStartedAtMs, 'number')
      assert.equal(child.phaseStartedAtIsEstimated, true)
      assert.equal(typeof child.requestStartedAtMs, 'number')
      assert.doesNotMatch(progress.join('\n'), /CHILD-WORK|child-secret|child-progress-release/u)
    } finally {
      await fs.writeFile(path.join(fixture.devRoot, '.child-progress-release'), 'release')
      assert.ok(
        await waitUntil(() => {
          return reports.length > 0
        }, 5_000),
        'child の report が完了しなかった',
      )
      await host.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})

test('agent host: progress monitor の初期化失敗があっても会話を続ける', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  const logs: Record<string, unknown>[] = []
  const openHarness = Harness.open
  vi.spyOn(Harness, 'open').mockImplementation(async (storage, options, context) => {
    const harness = await openHarness(storage, options, context)
    vi.spyOn(harness, 'watchTaskGraph').mockRejectedValue(new Error('progress-watch-init-secret'))
    return harness
  })
  let host: Awaited<ReturnType<typeof openArayaAgentHost>> | undefined

  try {
    models.script(() => {
      return answer('進捗監視失敗後も通常応答')
    })
    host = await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: { provider: models.model.provider, modelId: models.model.id, thinkingLevel: 'medium' },
      redactor: createRedactor([]),
      deliverReport: async () => {},
      log: (entry) => {
        logs.push(entry)
      },
      context: BACKGROUND_CONTEXT,
    })

    assert.equal(
      await host.submit('通常の依頼', 'progress-init-failure-1'),
      '進捗監視失敗後も通常応答',
    )
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_progress_monitor_initialization_failed'
      }),
    )
    assert.doesNotMatch(JSON.stringify(logs), /progress-watch-init-secret/u)
  } finally {
    await host?.close()
    vi.restoreAllMocks()
    await removeAgentFixture(fixture)
  }
})

test('agent host: progress 通知は作業種別の変化だけを送り、同種 tool をまとめて引数を含めない', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  const progress: { text: string; nonce: string }[] = []
  await fs.writeFile(path.join(fixture.devRoot, 'progress-a.txt'), 'secret-output')
  await fs.writeFile(path.join(fixture.devRoot, 'progress-b.txt'), 'other-output')

  try {
    models.script((view) => {
      if (view.toolResults.length === 0) {
        return toolCall('read', { path: 'progress-a.txt' })
      }

      if (view.toolResults.length === 1) {
        return toolCall('read', { path: 'progress-b.txt' })
      }

      if (view.toolResults.length === 2) {
        return toolCall('bash', { command: 'printf private-command' })
      }

      return answer('完了')
    })

    const host = await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: {
        provider: models.model.provider,
        modelId: models.model.id,
        thinkingLevel: 'medium' as const,
      },
      redactor: createRedactor(['secret-output']),
      deliverReport: async () => {},
      deliverProgress: async (text: string, nonce: string) => {
        progress.push({ text, nonce })
      },
      context: BACKGROUND_CONTEXT,
    })

    try {
      assert.equal(await host.submit('進捗通知テスト', 'progress-notification-1'), '完了')
      assert.ok(
        await waitUntil(() => {
          return progress.some((message) => {
            return message.text.includes('コマンドを実行中')
          })
        }, 3_000),
        'コマンド実行の progress message が届かなかった',
      )

      assert.equal(
        progress.filter((message) => {
          return message.text.includes('ファイルを読み取り中')
        }).length,
        1,
      )
      assert.equal(
        progress.filter((message) => {
          return message.text.includes('コマンドを実行中')
        }).length,
        1,
      )
      assert.doesNotMatch(
        progress
          .map((message) => {
            return message.text
          })
          .join('\n'),
        /progress-a\.txt|progress-b\.txt|private-command|secret-output|other-output/u,
      )
      assert.doesNotMatch(
        progress
          .map((message) => {
            return message.text
          })
          .join('\n'),
        /モデル応答を生成中/u,
      )
      assert.equal(
        new Set(
          progress.map((message) => {
            return message.nonce
          }),
        ).size,
        progress.length,
      )
    } finally {
      await host.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})

test('agent host: progress 通知の配送失敗は main の実行を止めず、安全な失敗記録だけを残す', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  const logs: Record<string, unknown>[] = []

  try {
    models.script((view) => {
      if (view.toolResults.length === 0) {
        return toolCall('bash', { command: 'printf delivery-failure-secret' })
      }

      return answer('配送失敗後も完了')
    })

    const host = await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: {
        provider: models.model.provider,
        modelId: models.model.id,
        thinkingLevel: 'medium' as const,
      },
      redactor: createRedactor([]),
      deliverReport: async () => {},
      deliverProgress: async () => {
        throw new Error('delivery-failure-secret')
      },
      log: (entry: Record<string, unknown>) => {
        logs.push(entry)
      },
      context: BACKGROUND_CONTEXT,
    })

    try {
      assert.equal(await host.submit('通知失敗テスト', 'progress-failure-1'), '配送失敗後も完了')
      assert.ok(
        await waitUntil(() => {
          return logs.some((entry) => {
            return entry.type === 'discord_progress_delivery_failed'
          })
        }, 5_000),
        '進捗通知の失敗記録がない',
      )
      assert.doesNotMatch(JSON.stringify(logs), /delivery-failure-secret/u)
    } finally {
      await host.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})

test('agent host: deliverReport 失敗後は durable state から同じ nonce で再送する', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  const deliveries: { name: string; text: string; nonce: string }[] = []

  const openHost = async () => {
    return await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: { provider: models.model.provider, modelId: models.model.id, thinkingLevel: 'medium' },
      redactor: createRedactor([]),
      deliveryRetryMs: 300,
      deliverReport: async (name, text, nonce) => {
        deliveries.push({ name, text, nonce })

        if (deliveries.length === 1) {
          throw new Error('synthetic delivery failure')
        }
      },
      context: BACKGROUND_CONTEXT,
    })
  }

  try {
    models.script((view) => {
      if (view.prompt.includes('CHILD-WORK')) {
        return answer('child 作業完了')
      }

      if (view.toolResults.length === 0) {
        return toolCall('task', {
          action: 'spawn',
          name: 'retry-worker',
          message: 'CHILD-WORK を実施',
        })
      }

      return answer('main まとめ')
    })

    const host = await openHost()

    try {
      await host.submit('再送テスト', 'message-1')

      assert.ok(
        await waitUntil(() => {
          return deliveries.length >= 2
        }, 20_000),
        'deliverReport 再送が観測されなかった',
      )
      assert.equal(deliveries[1]?.nonce, deliveries[0]?.nonce)
      assert.equal(deliveries[1]?.name, 'retry-worker')
    } finally {
      await host.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})

test('agent host: tool の shell に agent session の目印を足さない（撤去したことを固定する）', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  // host process の env に目印が有る environment（dev unit など）でも test が environment 依存にならないよう一時的に消す
  const hostMarkerBefore = process.env.ARAYA_AGENT_SESSION
  delete process.env.ARAYA_AGENT_SESSION

  try {
    models.script((view) => {
      if (view.toolResults.length === 0) {
        return toolCall('bash', { command: 'printf "marker=%s" "$ARAYA_AGENT_SESSION"' })
      }

      return answer(view.toolResults.at(-1)?.text ?? '')
    })

    const host = await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: { provider: models.model.provider, modelId: models.model.id, thinkingLevel: 'medium' },
      redactor: createRedactor(['secret-value']),
      deliverReport: async () => {},
      context: BACKGROUND_CONTEXT,
    })

    try {
      const text = await host.submit('MARKER-CHECK', 'marker-message-1')
      // agent host 側が tool の shell に目印を足すことは無い（消した値のまま）
      assert.equal(text, 'marker=')
      // control command の status 表示用の conversation id が取れる
      const described = host.describe()
      assert.equal(typeof described.conversationId, 'number')
    } finally {
      await host.close()
    }
  } finally {
    if (hostMarkerBefore !== undefined) {
      process.env.ARAYA_AGENT_SESSION = hostMarkerBefore
    }

    await removeAgentFixture(fixture)
  }
})

test('agent host: 同じ requestId の submit は durable で 1 回だけ走り、記録済みの answer を返す（inject 再試行が重複作業にならない）', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)
  let modelRuns = 0

  try {
    models.script(() => {
      modelRuns += 1

      return answer('inject 応答')
    })

    const host = await openArayaAgentHost({
      dataDir: fixture.dataDir,
      devRoot: fixture.devRoot,
      models: models.runtime,
      model: { provider: models.model.provider, modelId: models.model.id, thinkingLevel: 'medium' },
      redactor: createRedactor(['secret-value']),
      deliverReport: async () => {},
      context: BACKGROUND_CONTEXT,
    })

    try {
      const first = await host.submit('INJECT-CASE', 'hoot-inject:hoot-prop-abc:1')
      // 同じ dedupe key での再 submit（poll の再試行・restart 後の再.poll）は model を走らせない
      const second = await host.submit('INJECT-CASE-RETRY', 'hoot-inject:hoot-prop-abc:1')
      // key が違えば別案件として走る
      const other = await host.submit('INJECT-CASE-2', 'hoot-inject:hoot-prop-abc:2')

      assert.equal(first, 'inject 応答')
      assert.equal(second, 'inject 応答')
      assert.equal(other, 'inject 応答')
      assert.equal(modelRuns, 2)
    } finally {
      await host.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})
