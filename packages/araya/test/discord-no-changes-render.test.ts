import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { renderNotification, renderTaskDetail, renderTaskList } from '../src/discord/render.ts'
import { openTaskLedger } from '../src/runner/ledger.ts'

async function makeDataDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-no-changes-test-')))
}

function createAttempt(ledger: ReturnType<typeof openTaskLedger>) {
  ledger.createTask({
    title: 'cleanup worktrees',
    goal: 'perform operational cleanup',
    constraints: [],
    targets: [],
    permissions: [],
    idempotencyKey: null,
  })
  const attempt = ledger.claimNextAttempt(1, {
    devRoot: '/tmp/araya-no-changes-dev',
    agentDir: '/tmp/araya-no-changes-agent',
    model: null,
    timeoutMs: 60_000,
    verificationTimeoutMs: 60_000,
  })

  assert.ok(attempt)
  return attempt
}

test('discord renderer: no_changes は失敗ではなく結果未確認として表示する', async () => {
  const dataDir = await makeDataDir()
  const ledger = openTaskLedger(dataDir)

  try {
    const attempt = createAttempt(ledger)
    ledger.recordResult(
      attempt.taskKey,
      {
        status: 'failed',
        failureReason: 'no_changes',
        failureDetail: null,
        summary: '外部作業を実施したとの報告。',
        decisionQuestion: null,
        model: null,
        evidence: {
          taskKey: attempt.taskKey,
          outcome: 'failed',
          failureReason: 'no_changes',
          worktrees: [],
        },
      },
      { taskKey: attempt.taskKey, addMs: 1 },
    )

    const detail = ledger.showTask(1, { events: 10 })
    const detailText = renderTaskDetail({
      task: detail.task,
      attempts: detail.attempts,
      events: detail.events,
    }).join('\n')
    const listText = renderTaskList({
      tasks: ledger.listTasks({ limit: 10 }),
      runner: null,
      queue: ledger.queueView(1),
    })

    assert.equal(detail.task.status, 'failed', '保存済みの内部statusは変更しない')
    assert.match(detailText, /状態: 結果未確認/u)
    assert.match(detailText, /worktree差分なし/u)
    assert.doesNotMatch(detailText, /失敗/u)
    assert.match(listText, /結果未確認/u)
    assert.match(listText, /worktree差分なし/u)
    assert.doesNotMatch(listText, /失敗/u)
    assert.match(
      renderNotification({
        seq: 1,
        attempt: 1,
        at: '2026-11-17T00:00:00.000Z',
        type: 'run.finished',
        data: { status: 'failed', failureReason: 'no_changes' },
        taskId: 1,
        taskTitle: 'cleanup worktrees',
      }) ?? '',
      /結果未確認.*worktree差分なし/u,
    )
  } finally {
    ledger.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
