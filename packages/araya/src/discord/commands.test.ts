import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import {
  DISCORD_CONTROL_USAGE,
  createDiscordControlCommands,
  hootArgumentsOf,
  type DiscordControlContext,
} from './commands.ts'
import { ARAYA_SLASH_COMMANDS, HOOT_COMMAND, validateArayaSlashCommands } from './slash.ts'
import { readHootState, setGoal, updateSettings, upsertProposal } from '../hoot/store.ts'

function fakeContext(options: { dataDir?: string } = {}) {
  const sends: string[] = []
  const context: DiscordControlContext & { sends: string[] } = {
    conversationId: 41,
    runningCount: 1,
    queuedCount: 2,
    sessionAvailable: true,
    sends,
    send: async (content) => {
      sends.push(content)
    },
    cancelQueued: () => 3,
    stopSession: async () => '実行中・実行待ちの作業があれば中止を要求しました',
    resetSession: async (requestId) => `reset ${requestId}`,
  }

  return context
}

function hootRequest(input: {
  group?: string
  subcommand: string
  options?: Record<string, string | number | boolean>
}) {
  return {
    interactionId: 'interaction-2',
    commandName: 'hoot',
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    subcommandGroup: input.group ?? null,
    subcommand: input.subcommand,
    options: input.options ?? {},
  }
}

test('slash command 定義は Discord の constraints を満たす', () => {
  assert.deepEqual(validateArayaSlashCommands(ARAYA_SLASH_COMMANDS), [])
  assert.deepEqual(
    ARAYA_SLASH_COMMANDS.map((command) => command.name),
    ['araya', 'hoot'],
  )
  assert.deepEqual(
    HOOT_COMMAND.options.map((entry) => entry.name),
    ['status', 'dispatch', 'runs', 'inject', 'evidence', 'goal', 'settings', 'proposal', 'reset-schedule'],
  )
})

test('slash command 定義の壊れを validateArayaSlashCommands が拾う', () => {
  const problems = validateArayaSlashCommands([
    {
      name: 'Bad Name',
      description: '',
      options: [
        {
          type: 2,
          name: 'goal',
          description: 'goal',
          options: [
            {
              type: 1,
              name: 'add',
              description: 'add',
              options: [{ name: 'x'.repeat(40), description: 'o', type: 3 }],
            },
          ],
        },
      ],
    },
  ])

  assert.equal(problems.length >= 3, true, JSON.stringify(problems))
  assert.equal(
    problems.some((problem) => {
      return problem.includes('command name')
    }),
    true,
  )
  assert.equal(
    problems.some((problem) => {
      return problem.includes('option name')
    }),
    true,
  )
})

test('/hoot の option を araya hoot と同じ引数列へ変換する', () => {
  assert.deepEqual(hootArgumentsOf(hootRequest({ subcommand: 'status' })), ['status'])
  assert.deepEqual(hootArgumentsOf(hootRequest({ subcommand: 'runs' })), ['runs'])
  assert.deepEqual(hootArgumentsOf(hootRequest({ subcommand: 'reset-schedule' })), [
    'reset-schedule',
  ])
  assert.deepEqual(
    hootArgumentsOf(hootRequest({ subcommand: 'dispatch', options: { key: 'abc' } })),
    ['dispatch', '--key', 'abc'],
  )
  assert.deepEqual(hootArgumentsOf(hootRequest({ group: 'inject', subcommand: 'list' })), [
    'inject',
    'list',
  ])
  assert.deepEqual(hootArgumentsOf(hootRequest({ group: 'proposal', subcommand: 'list' })), [
    'proposal',
    'list',
  ])
  assert.deepEqual(
    hootArgumentsOf(
      hootRequest({ group: 'proposal', subcommand: 'resolve', options: { key: 'abc' } }),
    ),
    ['proposal', 'resolve', '--key', 'abc'],
  )
  assert.deepEqual(
    hootArgumentsOf(
      hootRequest({
        group: 'goal',
        subcommand: 'add',
        options: {
          key: 'ship-pr34',
          objective: 'PR #34 を review して merge する',
          scope: 'github:koh110/araya,github:koh110/araya',
          constraint: 'deploy は human gate,token を log に出さない',
          'review-at': '2026-07-31',
        },
      }),
    ),
    [
      'goal',
      'add',
      '--key',
      'ship-pr34',
      '--objective',
      'PR #34 を review して merge する',
      '--scope',
      'github:koh110/araya,github:koh110/araya',
      '--constraint',
      'deploy は human gate,token を log に出さない',
      '--review-at',
      '2026-07-31',
    ],
  )
  // update は指定した field だけ渡す（未指定は CLI 側で現状維持）
  assert.deepEqual(
    hootArgumentsOf(
      hootRequest({
        group: 'goal',
        subcommand: 'update',
        options: { key: 'k', objective: '新しい目的' },
      }),
    ),
    ['goal', 'update', '--key', 'k', '--objective', '新しい目的'],
  )
  assert.deepEqual(
    hootArgumentsOf(hootRequest({ group: 'goal', subcommand: 'pause', options: { key: 'k' } })),
    ['goal', 'pause', '--key', 'k'],
  )
  assert.deepEqual(hootArgumentsOf(hootRequest({ group: 'settings', subcommand: 'show' })), [
    'settings',
    'show',
  ])
  // boolean option は CLI の 'true' / 'false'、integer は string にする
  assert.deepEqual(
    hootArgumentsOf(
      hootRequest({
        group: 'settings',
        subcommand: 'set',
        options: {
          enabled: true,
          mode: 'dry_run',
          'max-injects-per-day': 2,
          'auto-dispatch': false,
          'conversation-read': true,
        },
      }),
    ),
    [
      'settings',
      'set',
      '--enabled',
      'true',
      '--mode',
      'dry_run',
      '--auto-dispatch',
      'false',
      '--conversation-read',
      'true',
      '--max-injects-per-day',
      '2',
    ],
  )
})

test('unknown subcommand・必須 option 欠落・data-dir は hoot_invalid_argument', () => {
  assert.throws(() => {
    hootArgumentsOf(hootRequest({ subcommand: 'delete-everything' }))
  }, /hoot_invalid_argument/u)
  assert.throws(() => {
    hootArgumentsOf(hootRequest({ group: 'goal', subcommand: 'explode' }))
  }, /hoot_invalid_argument/u)
  assert.throws(() => {
    hootArgumentsOf(hootRequest({ subcommand: 'dispatch', options: {} }))
  }, /hoot_invalid_argument: \/hoot dispatch は key が必要です/u)
  assert.throws(() => {
    hootArgumentsOf(hootRequest({ group: 'goal', subcommand: 'add', options: { key: 'k' } }))
  }, /objective が必要です/u)
  assert.throws(() => {
    hootArgumentsOf(hootRequest({ group: 'settings', subcommand: 'set', options: {} }))
  }, /1 つ以上の field が必要/u)
  assert.throws(() => {
    hootArgumentsOf(hootRequest({ subcommand: 'status', options: { 'data-dir': '/tmp/other' } }))
  }, /--data-dir は指定できません/u)
})

test('Discord control command: /araya の help・status・stop・reset', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-control-'))

  try {
    const logs: Record<string, unknown>[] = []
    const control = createDiscordControlCommands({
      dataDir,
      nowMs: (): number => Date.parse('2026-06-30T09:00:00.000Z'),
      log: (entry) => {
        logs.push(entry)
      },
    })
    const context = fakeContext({ dataDir })

    await control.handle(
      {
        interactionId: 'i1',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'help',
        options: {},
      },
      context,
    )
    assert.equal(context.sends[0]?.includes('/hoot dispatch'), true)
    assert.equal(context.sends[0]?.includes('/araya reset'), true)

    await control.handle(
      {
        interactionId: 'i2',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      context,
    )
    assert.match(context.sends[1] ?? '', /main conversation #41/u)
    assert.match(context.sends[1] ?? '', /state file:/u)

    await control.handle(
      {
        interactionId: 'i3',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'stop',
        options: {},
      },
      context,
    )
    assert.match(context.sends[2] ?? '', /中止を要求/u)
    assert.match(context.sends[2] ?? '', /実行待ち 3 件/u)

    await control.handle(
      {
        interactionId: 'i4',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'reset',
        options: {},
      },
      context,
    )
    assert.equal(context.sends[3], 'reset i4')

    assert.deepEqual(
      logs.map((entry) => {
        return entry.command
      }),
      ['araya help', 'araya status', 'araya stop', 'araya reset'],
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Discord control command: /araya status は実行中詳細が未取得なら idle と誤表示しない', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-progress-unknown-'))

  try {
    const context = {
      ...fakeContext({ dataDir }),
      progress: null,
    }

    await createDiscordControlCommands({
      dataDir,
      nowMs: () => {
        return Date.parse('2026-06-30T09:00:00.000Z')
      },
      log: () => {},
    }).handle(
      {
        interactionId: 'progress-unknown',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      context,
    )

    assert.match(context.sends[0] ?? '', /進捗: 実行中の作業詳細を取得できません/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Discord control command: /araya status は現在の処理と background task の経過を表示する', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-progress-control-'))

  try {
    const nowMs = Date.parse('2026-06-30T09:00:00.000Z')
    const context = {
      ...fakeContext({ dataDir }),
      progress: {
        main: {
          operation: 'bash' as const,
          phaseStartedAtMs: nowMs - 12_000,
          phaseStartedAtIsEstimated: true,
        },
        children: [
          {
            name: 'worker-1',
            operation: 'edit' as const,
            phaseStartedAtMs: nowMs - 7_000,
            phaseStartedAtIsEstimated: true,
            requestStartedAtMs: nowMs - 45_000,
          },
        ],
      },
    }

    await createDiscordControlCommands({
      dataDir,
      nowMs: () => {
        return nowMs
      },
      log: () => {},
    }).handle(
      {
        interactionId: 'progress-status',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      context,
    )

    assert.match(context.sends[0] ?? '', /現在の処理: コマンドを実行中/u)
    assert.match(context.sends[0] ?? '', /この工程 少なくとも12秒（観測時点から）/u)
    assert.match(context.sends[0] ?? '', /task\[worker-1\].*ファイルを編集中/u)
    assert.match(context.sends[0] ?? '', /この工程 少なくとも7秒（観測時点から）/u)
    assert.match(context.sends[0] ?? '', /依頼から 45秒/u)
    assert.doesNotMatch(context.sends[0] ?? '', /private-command|secret-output/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Discord control command: /araya status は汎用準備待ちを background task 待ちと誤表示しない', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-progress-preparing-'))
  const nowMs = Date.parse('2026-06-30T09:00:00.000Z')
  const context = {
    ...fakeContext({ dataDir }),
    progress: {
      main: {
        operation: 'preparing' as const,
        phaseStartedAtMs: nowMs - 2_000,
        phaseStartedAtIsEstimated: true,
      },
      children: [],
    },
  }

  try {
    await createDiscordControlCommands({
      dataDir,
      nowMs: () => {
        return nowMs
      },
      log: () => {},
    }).handle(
      {
        interactionId: 'progress-preparing',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      context,
    )

    assert.match(context.sends[0] ?? '', /現在の処理: 次の処理を準備中/u)
    assert.doesNotMatch(context.sends[0] ?? '', /background task の完了待ち/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Discord control command: 知らない subcommand はエラー応答と discord_control_failed', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-control-'))

  try {
    const logs: Record<string, unknown>[] = []
    const control = createDiscordControlCommands({
      dataDir,
      nowMs: (): number => Date.parse('2026-06-30T09:00:00.000Z'),
      log: (entry) => {
        logs.push(entry)
      },
    })
    const context = fakeContext({ dataDir })

    await control.handle(
      {
        interactionId: 'i5',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'deploy',
        options: {},
      },
      context,
    )
    assert.match(context.sends[0] ?? '', /知りません/u)
    assert.equal(logs[0]?.type, 'discord_control_failed')

    await control.handle(
      {
        interactionId: 'i6',
        commandName: 'other',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      context,
    )
    assert.match(context.sends[1] ?? '', /\/araya か \/hoot/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Discord control command: /hoot dispatch は bot process の dataDir で inject request を作る', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-control-'))

  try {
    const logs: Record<string, unknown>[] = []
    const control = createDiscordControlCommands({
      dataDir,
      nowMs: (): number => Date.parse('2026-06-30T09:00:00.000Z'),
      log: (entry) => {
        logs.push(entry)
      },
    })
    await setGoal(
      dataDir,
      {
        key: 'watch-ci',
        objective: 'CI の失敗を追跡する',
        scope: ['github:koh110/araya'],
        constraints: [],
      },
      { replace: true },
    )
    // dispatch の承認は mode=active が前提（dry_run では inject を作らない）
    await updateSettings(dataDir, { mode: 'active' })
    await upsertProposal(dataDir, {
      key: 'abc',
      decision: 'dispatch',
      goalKeys: ['watch-ci'],
      reason: 'CI が失敗しています',
      occurrenceKey: 'hoot:2026-06-30T08:00:00.000Z',
      nowMs: Date.parse('2026-06-30T08:00:00.000Z'),
    })

    const context = fakeContext({ dataDir })
    await control.handle(hootRequest({ subcommand: 'dispatch', options: { key: 'abc' } }), context)

    assert.match(context.sends[0] ?? '', /inject request/iu, JSON.stringify(context.sends))
    const written = await readHootState(dataDir)
    assert.equal(written.injectRequests.length, 1)
    assert.equal(written.injectRequests[0]?.authorizedBy, 'human')
    assert.equal(written.injectRequests[0]?.requestId, 'hoot-inject:abc:1')
    assert.equal(
      logs.some((entry) => {
        return (
          entry.type === 'discord_control_command' &&
          String(entry.command).includes('hoot dispatch')
        )
      }),
      true,
    )
    // 同じ key をもう一度承認しようすると CLI 側の guard で断られる（同じ案件を繰り返さない）
    await control.handle(hootRequest({ subcommand: 'dispatch', options: { key: 'abc' } }), context)
    assert.match(
      context.sends[1] ?? '',
      /hoot_inject_exists|pending|すでに/u,
      JSON.stringify(context.sends[1]),
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('/hoot status・inject list・runs は bot process の dataDir を読む（session が無くても動く）', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-control-'))

  try {
    const control = createDiscordControlCommands({
      dataDir,
      nowMs: (): number => Date.parse('2026-06-30T09:00:00.000Z'),
      log: () => {},
    })
    const context = fakeContext({ dataDir })
    context.conversationId = null
    context.sessionAvailable = false

    await control.handle(hootRequest({ subcommand: 'status' }), context)
    assert.match(context.sends[0] ?? '', /state file:/u)

    await control.handle(hootRequest({ group: 'inject', subcommand: 'list' }), context)
    assert.match(context.sends[1] ?? '', /inject request/iu, JSON.stringify(context.sends[1]))

    await control.handle(hootRequest({ subcommand: 'runs' }), context)
    assert.match(context.sends[2] ?? '', /run/iu)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('/hoot proposal history と /hoot evidence は araya hoot と同じ引数列へ変換する（未知の proposal subcommand は list / history / resolve に案内）', () => {
  assert.deepEqual(hootArgumentsOf(hootRequest({ group: 'proposal', subcommand: 'history' })), [
    'proposal',
    'history',
  ])
  assert.deepEqual(hootArgumentsOf(hootRequest({ subcommand: 'evidence' })), ['evidence'])
  // closed 履歴を読むのに --key は要らない（resolve は今まで通り --key 必須）
  assert.throws(
    () => hootArgumentsOf(hootRequest({ group: 'proposal', subcommand: 'resolve' })),
    /hoot_invalid_argument/u,
  )
  // --data-dir は option 定義に無いが、万一来ても拒否して bot process の dataDir を正とする
  assert.throws(
    () =>
      hootArgumentsOf(
        hootRequest({ group: 'proposal', subcommand: 'history', options: { 'data-dir': '/tmp/x' } }),
      ),
    /Discord から --data-dir/u,
  )
  assert.throws(
    () => hootArgumentsOf(hootRequest({ group: 'proposal', subcommand: 'archive' })),
    /proposal archive は知りません（list \/ history \/ resolve）/u,
  )
})

test('Discord control command: /hoot proposal list・history と /hoot evidence は bot process の dataDir を読む（read-only）', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-proposal-history-'))

  try {
    const logs: Record<string, unknown>[] = []
    const control = createDiscordControlCommands({
      dataDir,
      nowMs: (): number => Date.parse('2026-06-30T09:00:00.000Z'),
      log: (entry) => {
        logs.push(entry)
      },
    })
    await setGoal(
      dataDir,
      {
        key: 'watch-ci',
        objective: 'CI の失敗を追跡する',
        scope: [],
        constraints: [],
      },
      { replace: true },
    )
    await upsertProposal(dataDir, {
      key: 'open-one',
      decision: 'request_human',
      goalKeys: ['watch-ci'],
      reason: '優先順位を決めてください',
      occurrenceKey: 'hoot:2026-06-30T08:00:00.000Z',
      nowMs: Date.parse('2026-06-30T08:00:00.000Z'),
    })
    await upsertProposal(dataDir, {
      key: 'closed-one',
      decision: 'dispatch',
      goalKeys: ['watch-ci'],
      reason: 'CI が失敗しています',
      occurrenceKey: 'hoot:2026-06-30T07:00:00.000Z',
      nowMs: Date.parse('2026-06-30T07:00:00.000Z'),
    })

    const context = fakeContext({ dataDir })
    // /hoot proposal resolve は state に効く（ここだけは書き換え）
    await control.handle(
      hootRequest({ group: 'proposal', subcommand: 'resolve', options: { key: 'closed-one' } }),
      context,
    )
    assert.match(context.sends[0] ?? '', /resolved にしました/u)

    // list は open だけ。closed の中身は出さず、総数と履歴への案内だけ
    await control.handle(hootRequest({ group: 'proposal', subcommand: 'list' }), context)
    assert.match(context.sends[1] ?? '', /open 1 \/ closed 1/u)
    assert.equal((context.sends[1] ?? '').includes('closed-one'), false)
    assert.match(
      context.sends[1] ?? '',
      /araya hoot proposal history \/ Discord は \/hoot proposal history/u,
      JSON.stringify(context.sends[1]),
    )

    // history は closed だけ、updatedAt の新しい順に最大 5 件
    await control.handle(hootRequest({ group: 'proposal', subcommand: 'history' }), context)
    assert.match(context.sends[2] ?? '', /closed 1（updatedAt の新しい順に直近 5 件）/u)
    assert.match(context.sends[2] ?? '', /closed-one \[resolved\]/u)
    assert.equal((context.sends[2] ?? '').includes('open-one'), false)

    // evidence は CLI と同じ read-only 表示（bot process の dataDir）
    await control.handle(hootRequest({ subcommand: 'evidence' }), context)
    assert.match(context.sends[3] ?? '', /delivery/u, JSON.stringify(context.sends[3]))

    // 読むだけの command が state を書き換えていない（resolve 以降も closed は 1 件のまま）
    const state = await readHootState(dataDir)
    assert.equal(
      state.proposals.filter((proposal) => {
        return proposal.status !== 'open'
      }).length,
      1,
    )
    assert.equal(
      logs.some((entry) => {
        return entry.type === 'discord_control_command' && String(entry.command) === 'hoot proposal history'
      }),
      true,
    )
    assert.equal(
      logs.some((entry) => {
        return entry.type === 'discord_control_command' && String(entry.command) === 'hoot evidence'
      }),
      true,
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('Discord control command: /hoot proposal の未知の subcommand は ephemeral に list / history / resolve と返す', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-proposal-unknown-'))

  try {
    const logs: Record<string, unknown>[] = []
    const control = createDiscordControlCommands({
      dataDir,
      nowMs: (): number => Date.parse('2026-06-30T09:00:00.000Z'),
      log: (entry) => {
        logs.push(entry)
      },
    })
    const context = fakeContext({ dataDir })

    await control.handle(hootRequest({ group: 'proposal', subcommand: 'archive' }), context)
    assert.match(context.sends[0] ?? '', /できませんでした: hoot_invalid_argument: \/hoot proposal archive は知りません（list \/ history \/ resolve）/u)
    assert.equal(
      logs.some((entry) => {
        return entry.type === 'discord_control_failed' && String(entry.command) === 'hoot proposal archive'
      }),
      true,
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('usage には slash command 形と operation の境界を書く', () => {
  assert.equal(DISCORD_CONTROL_USAGE.includes('/araya help'), true)
  assert.equal(DISCORD_CONTROL_USAGE.includes('/hoot settings'), true)
  // closed 履歴と delivery の観測差も slash command 側にある（CLI 専用ではない）
  assert.equal(DISCORD_CONTROL_USAGE.includes('/hoot proposal list / history / resolve'), true)
  assert.equal(DISCORD_CONTROL_USAGE.includes('/hoot evidence'), true)
  // 境界は「どの shell から叩いたか」ではなく「承認済みの dispatch を受け取った main 会話だけ」側で説明する
  assert.equal(DISCORD_CONTROL_USAGE.includes('同じ kernel を通ります'), true)
  assert.equal(DISCORD_CONTROL_USAGE.includes('agent session の内側から'), false)
})

test('Discord control command: /araya status は実行中の turn の経過時間を出す（status だけで停滞の長さを読めるように）', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-turn-elapsed-'))

  try {
    const commands = createDiscordControlCommands({
      dataDir,
      nowMs: () => {
        return Date.parse('2026-06-30T09:00:00.000Z')
      },
      log: () => {},
    })

    const running = {
      ...fakeContext({ dataDir }),
      progress: null,
      // 2026-11-24 に起きた 15h37m の停滞と同じ桁
      runningElapsedMs: 54_120_000,
    }
    await commands.handle(
      {
        interactionId: 'turn-elapsed-running',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      running,
    )
    assert.match(running.sends[0] ?? '', /実行中 1（うち 15時間2分）/u)

    // 実行中 0 件なら経過時間を付けない（idle を「何か走っている」に見せない）
    const idle = {
      ...fakeContext({ dataDir }),
      runningCount: 0,
      queuedCount: 0,
      progress: null,
      runningElapsedMs: null,
    }
    await commands.handle(
      {
        interactionId: 'turn-elapsed-idle',
        commandName: 'araya',
        userId: 'u',
        guildId: 'g',
        channelId: 'c',
        subcommandGroup: null,
        subcommand: 'status',
        options: {},
      },
      idle,
    )
    assert.match(idle.sends[0] ?? '', /実行中 0 \/ 待ち 0/u)
    assert.doesNotMatch(idle.sends[0] ?? '', /うち /u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
