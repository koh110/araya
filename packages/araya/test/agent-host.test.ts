import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

import { openArayaAgentHost } from '../src/agent/host.ts'
import { createRedactor } from '../src/infrastructure/redaction.ts'
import { answer, createFauxModels, toolCall } from './support/faux-shiki.ts'

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

      assert.ok(await waitUntil(() => {
        return reports.length > 0
      }, 20_000), 'deliverReport が呼ばれなかった')
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
        return toolCall('task', { action: 'spawn', name: 'retry-worker', message: 'CHILD-WORK を実施' })
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

test('agent host: main 会話の shell には agent session の目印が入る（HOOT 承認を agent 自分で実行できないようにする）', async () => {
  const fixture = await makeAgentFixture()
  const models = await createFauxModels(fixture)

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
      // 目印は tool の shell 에만 들어간다（bot process 自身の env は汚さない）
      assert.equal(text, 'marker=1')
      assert.equal(process.env.ARAYA_AGENT_SESSION, undefined)
      // control command の status 表示用の conversation id が取れる
      const described = host.describe()
      assert.equal(typeof described.conversationId, 'number')
    } finally {
      await host.close()
    }
  } finally {
    await removeAgentFixture(fixture)
  }
})
