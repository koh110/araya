import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createRedactor } from '../src/infrastructure/redaction.ts'
import { handleDiscordCommand, type DiscordCommandRequest } from '../src/discord/interactions.ts'
import { MAX_DISCORD_MESSAGE_CHARS } from '../src/discord/render.ts'
import { openTaskLedger, type TaskLedger } from '../src/runner/ledger.ts'

const BOT_TOKEN = 'discord-b…alue'
const APPLICATION_ID = '123456789012345678'
const GUILD_ID = '12345678901234567'
const CHANNEL_ID = '12345678901234568'
const USER_ID = '12345678901234569'
const UNIT = 'araya-discord-0123456789ab.service'

const CONFIG = {
  botToken: BOT_TOKEN,
  applicationId: APPLICATION_ID,
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  allowedUserIds: [USER_ID],
} as const

type Env = {
  dataDir: string
  ledger: TaskLedger
  replies(
    subcommand: string,
    options?: DiscordCommandRequest['options'],
    overrides?: Partial<DiscordCommandRequest>,
  ): string[]
}

async function makeEnv() {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-interactions-test-')),
  )
  const ledger = openTaskLedger(dataDir)
  let sequence = 0

  function replies(
    subcommand: string,
    options: DiscordCommandRequest['options'] = {},
    overrides: Partial<DiscordCommandRequest> = {},
  ) {
    sequence += 1
    const result = handleDiscordCommand(
      {
        interactionId: `interaction-${sequence}`,
        userId: USER_ID,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        subcommand,
        options,
        ...overrides,
      },
      {
        config: CONFIG,
        unit: UNIT,
        ledger,
        nowMs: () => {
          return Date.parse('2026-10-31T00:00:00.000Z')
        },
        redactor: createRedactor([BOT_TOKEN]),
      },
    )

    return result.map((reply) => {
      return reply.content
    })
  }

  return { dataDir, ledger, replies }
}

async function withEnv(run: (env: Env) => void | Promise<void>) {
  const env = await makeEnv()

  try {
    await run(env)
  } finally {
    env.ledger.close()
    await fs.rm(env.dataDir, { recursive: true, force: true })
  }
}

function replyAt(replies: string[], index: number) {
  const reply = replies[index]

  assert.ok(reply, `reply ${index} が存在すること`)

  return reply
}

test('discord-interactions: 設定した guild・channel・user の外は reply しない', async () => {
  await withEnv(({ replies }) => {
    const boundary = 'この操作は、設定された channel と許可された user だけが使えます'

    assert.deepEqual(replies('list', {}, { guildId: '99999999999999999' }), [boundary])
    assert.deepEqual(replies('list', {}, { channelId: '99999999999999999' }), [boundary])
    assert.deepEqual(replies('list', {}, { userId: '99999999999999999' }), [boundary])
    assert.deepEqual(replies('unknown'), [
      '知らない subcommand です（list・show・submit・cancel・retry）',
    ])
  })
})

test('discord-interactions: list は runner の状態と Task 一覧を日本語の短文で出す', async () => {
  await withEnv(({ replies }) => {
    const empty = replyAt(replies('list'), 0)

    assert.ok(empty.startsWith('runner: 未稼働'), empty)
    assert.match(empty, /実行中 0 \/ 待ち 0（同時 1）/u)
    assert.ok(empty.endsWith('Task はありません'), empty)

    assert.deepEqual(
      replies('submit', { title: 'テストタスク', goal: 'goal の本文' })[0],
      'Task #1 を登録しました（待ち）',
    )
    assert.ok(
      replyAt(replies('submit', { title: 'テストタスク2', goal: 'goal' }), 1).includes(
        'unit が稼働していません',
      ),
      'runner 未稼働の warning を添える',
    )

    const listed = replyAt(replies('list'), 0)

    assert.match(listed, /^#1 待ち（試行 1） テストタスク$/mu)

    // status filter
    assert.match(replyAt(replies('list', { status: 'queued' }), 0), /#1/u)
    assert.ok(replyAt(replies('list', { status: 'completed' }), 0).endsWith('Task はありません'))
    assert.deepEqual(replies('list', { status: 'bogus' }), [
      'status は queued・running・completed・failed・blocked のいずれかです',
    ])
  })
})

test('discord-interactions: list は Task が多くても Discord の文字数上限を越えない', async () => {
  await withEnv(({ replies }) => {
    for (let index = 0; index < 30; index += 1) {
      replies('submit', { title: 'x'.repeat(80), goal: 'goal' })
    }

    const messages = replies('list')

    assert.ok(messages.length > 1, '長い一覧は複数の reply に分割する')
    assert.ok(
      messages.every((message) => {
        return message.length <= MAX_DISCORD_MESSAGE_CHARS
      }),
      messages
        .map((message) => {
          return message.length
        })
        .join(', '),
    )
  })
})

test('discord-interactions: submit は option を台帳の Task にする。同じ interaction の再送では重複しない', async () => {
  await withEnv(({ replies, ledger }) => {
    assert.deepEqual(replies('submit', { goal: 'goal の本文' }), ['title を指定してください'])
    assert.deepEqual(replies('submit', { title: 'title' }), ['goal を指定してください'])

    // Discord option も台帳の title / targets 上限を越えさせない
    const longTitle = replyAt(replies('submit', { title: 'x'.repeat(201), goal: 'goal' }), 0)

    assert.ok(!longTitle.includes('を登録しました'), longTitle)
    assert.equal(ledger.listTasks({ limit: 10 }).length, 0)

    const tooManyTargets = Array.from({ length: 17 }, (_, index) => {
      return `target-${index}`
    }).join(',')
    const targetReply = replyAt(
      replies('submit', { title: 'title', goal: 'goal', targets: tooManyTargets }),
      0,
    )

    assert.ok(!targetReply.includes('を登録しました'), targetReply)
    assert.equal(ledger.listTasks({ limit: 10 }).length, 0)

    const [first, warning] = replies('submit', {
      title: 'target を絞る',
      goal: 'goal',
      targets: 'packages/araya, docs/spec',
      constraints: 'test を増やす',
      permissions: 'commit,push',
    })

    assert.equal(first, 'Task #1 を登録しました（待ち）')
    assert.ok(warning?.includes('araya runner install'), warning ?? 'warning がありません')

    const task = ledger.showTask(1, { events: 0 }).task

    assert.deepEqual(task.targets, ['packages/araya', 'docs/spec'])
    assert.deepEqual(task.constraints, ['test を増やす'])
    assert.deepEqual(task.permissions, ['commit', 'push'])

    // 同じ interactionId の再送
    const firstRequest = {
      interactionId: 'interaction-5',
      userId: USER_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      subcommand: 'submit',
      options: { title: '違う title', goal: 'goal' },
    }
    const ledgerRef = ledger

    const resend = handleDiscordCommand(
      {
        ...firstRequest,
        options: {
          title: 'target を絞る',
          goal: 'goal',
          targets: 'packages/araya, docs/spec',
          constraints: 'test を増やす',
          permissions: 'commit,push',
        },
      },
      {
        config: CONFIG,
        unit: UNIT,
        ledger: ledgerRef,
        nowMs: () => {
          return 0
        },
        redactor: createRedactor([BOT_TOKEN]),
      },
    ).map((r) => {
      return r.content
    })

    assert.equal(resend[0], 'Task #1 は既に登録されています（同じ操作の再送と判断しました）')

    // 同じ interactionId で違う値は idempotency_conflict → 日本語の案内
    const conflict = handleDiscordCommand(
      { ...firstRequest, options: { title: '違う title', goal: 'goal' } },
      {
        config: CONFIG,
        unit: UNIT,
        ledger: ledgerRef,
        nowMs: () => {
          return 0
        },
        redactor: createRedactor([BOT_TOKEN]),
      },
    ).map((r) => {
      return r.content
    })

    assert.equal(conflict[0], '同じ idempotency key を使う別の Task が既に登録されています')
    assert.equal(ledger.listTasks({ limit: 10 }).length, 1)
  })
})

test('discord-interactions: show は Task 詳細を 1 通に収まる形で出す', async () => {
  await withEnv(({ replies }) => {
    assert.deepEqual(replies('show', { task: 0 }), [
      'task は 1 以上の数値の Task ID で指定してください',
    ])
    assert.deepEqual(replies('show', { task: 'abc' }), [
      'task は 1 以上の数値の Task ID で指定してください',
    ])
    assert.deepEqual(replies('show', { task: 42 }), ['指定された Task がありません'])

    replies('submit', { title: '詳細タスク', goal: 'goal の本文', constraints: '制約A' })
    const detail = replyAt(replies('show', { task: 1 }), 0)

    assert.ok(detail.startsWith('Task #1: 詳細タスク'), detail)
    assert.match(detail, /^状態: 待ち（試行 1）/mu)
    assert.ok(detail.includes('目的: goal の本文'), detail)
    assert.ok(detail.includes('制約: 制約A'), detail)
    assert.ok(detail.includes('イベント'), detail)
    assert.ok(detail.includes('task.created'), detail)
    assert.ok(!detail.includes(BOT_TOKEN), 'token を出さない')
  })
})

test('discord-interactions: Task に保存済みの設定 credential を list/show に出さない', async () => {
  await withEnv(({ ledger, replies }) => {
    ledger.createTask({
      title: `Task ${BOT_TOKEN}`,
      goal: `Goal ${BOT_TOKEN}`,
      constraints: [BOT_TOKEN],
      targets: [BOT_TOKEN],
      permissions: [BOT_TOKEN],
      idempotencyKey: null,
    })

    const rendered = [...replies('list'), ...replies('show', { task: 1 })].join('\n')

    assert.equal(rendered.includes(BOT_TOKEN), false, rendered)
    assert.ok(rendered.includes('[REDACTED]'), rendered)
  })
})

test('discord-interactions: cancel の重複 interaction は後続の attempt を取り消さない', async () => {
  await withEnv(({ replies, ledger }) => {
    replies('submit', { title: 'cancel replay', goal: 'goal' })
    replies('cancel', { task: 1 }, { interactionId: 'cancel-once' })
    replies('retry', { task: 1 }, { interactionId: 'retry-next' })

    replies('cancel', { task: 1 }, { interactionId: 'cancel-once' })

    const task = ledger.getTask(1)
    assert.equal(task.attempt, 2)
    assert.equal(task.status, 'queued')
  })
})

test('discord-interactions: retry の重複 interaction は追加の attempt を作らない', async () => {
  await withEnv(({ replies, ledger }) => {
    replies('submit', { title: 'retry replay', goal: 'goal' })
    replies('cancel', { task: 1 })
    replies('retry', { task: 1 }, { interactionId: 'retry-once' })
    ledger.cancelTask(1)

    replies('retry', { task: 1 }, { interactionId: 'retry-once' })

    const task = ledger.getTask(1)
    assert.equal(task.attempt, 2)
    assert.equal(task.status, 'failed')
  })
})

test('discord-interactions: cancel と retry。実行前の Task は取り消し、失敗した Task は試行を増やして再実行する', async () => {
  await withEnv(({ replies, ledger }) => {
    assert.deepEqual(replies('cancel', { task: 7 }), ['指定された Task がありません'])

    replies('submit', { title: '中止する', goal: 'goal' })

    assert.deepEqual(replies('cancel', { task: 1 }), [
      'Task #1 を中止しました（実行前だったため Task として取り消しました）',
    ])
    assert.deepEqual(replies('cancel', { task: 1 }), [
      'その Task は既に終わっているため、中止できません',
    ])

    // started_at の無い取り消しは side effects 確認を要求しない
    assert.deepEqual(replies('retry', { task: 1, note: '続きから' }), [
      `Task #1 の再実行を受け付けました（試行 2）。次は ${UNIT} の unit で実行します`,
    ])
    assert.match(replyAt(replies('list'), 0), /^#1 待ち（試行 2） 中止する$/mu)

    const detail = ledger.showTask(1, { events: 0 })

    assert.equal(detail.task.attempt, 2)
    assert.equal(detail.attempts[1]?.note, '続きから')
  })
})

test('discord-interactions: retry は開始後に中断した試行の side effects 確認を求める', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-interactions-side-effects-')),
  )
  let ledger = openTaskLedger(dataDir)

  try {
    function call(subcommand: string, options: DiscordCommandRequest['options']) {
      return handleDiscordCommand(
        {
          interactionId: `side-effects-${subcommand}-${Object.keys(options).length}`,
          userId: USER_ID,
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          subcommand,
          options,
        },
        {
          config: CONFIG,
          unit: UNIT,
          ledger,
          nowMs: () => {
            return 0
          },
          redactor: createRedactor([BOT_TOKEN]),
        },
      ).map((reply) => {
        return reply.content
      })
    }

    call('submit', { title: '中断した', goal: 'goal' })
    assert.deepEqual(call('cancel', { task: 1 }), [
      'Task #1 を中止しました（実行前だったため Task として取り消しました）',
    ])

    // 台帳を直接直して「開始後に中止された試行」にする（runner を動かさずに済ませる）
    ledger.close()
    const db = new DatabaseSync(path.join(dataDir, 'tasks.sqlite'))

    try {
      db.prepare(
        "UPDATE runs SET started_at = '2026-10-31T00:00:00.000Z', evidence_json = ? WHERE task_id = 1 AND attempt = 1",
      ).run(
        JSON.stringify({
          worktrees: [
            { worktreePath: '/tmp/araya/.worktree/interrupted', branch: 'feature/interrupted' },
          ],
        }),
      )
    } finally {
      db.close()
    }
    ledger = openTaskLedger(dataDir)

    const withoutConfirm = call('retry', { task: 1 })
    const reply = withoutConfirm[0] ?? ''

    assert.match(reply, /Task #1/u, reply)
    assert.match(reply, /記録された worktree: 1 件/u, reply)
    assert.match(reply, /\/araya retry/u, reply)
    assert.match(reply, /task=1/u, reply)
    assert.match(reply, /confirm_side_effects=true/u, reply)
    assert.doesNotMatch(reply, /araya task remove/u, reply)
    assert.equal(ledger.showTask(1, { events: 0 }).attempts.length, 1)

    assert.deepEqual(call('retry', { task: 1, confirm_side_effects: true }), [
      `Task #1 の再実行を受け付けました（試行 2）。次は ${UNIT} の unit で実行します`,
    ])
  } finally {
    ledger.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
