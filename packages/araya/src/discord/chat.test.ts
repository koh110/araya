import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'vite-plus/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDiscordChatHandler,
  discordChatReplyNonce,
  isDiscordChatMessageAllowed,
  splitDiscordChatReply,
  stripDiscordBotMention,
  type DiscordChatMessageMetadata,
} from './chat.ts'
import { createRedactor } from '../infrastructure/redaction.ts'
import { readHootState, upsertProposal } from '../hoot/store.ts'
import type { DiscordConfig } from './config.ts'

// control command は state file を読むので deps に dataDir が必要（この test の既存ケースは
// HOOT を触らないので、存在しなくて readHootState は default state を返すだけ）
const chatDataDir = join(tmpdir(), 'araya-discord-chat-control-test')

const config: DiscordConfig = {
  botToken: 'synthetic-token',
  applicationId: '12345678901234567',
  guildId: '22345678901234567',
  channelId: '32345678901234567',
  allowedUserIds: ['42345678901234567'],
}

const message: DiscordChatMessageMetadata = {
  guildId: config.guildId,
  channelId: config.channelId,
  userId: '42345678901234567',
  isBot: false,
  isWebhook: false,
  isSystem: false,
  mentionsBot: true,
}

test('discord chat: 設定 guild/channel の許可 user は mention なしでも受け付ける', () => {
  assert.equal(isDiscordChatMessageAllowed(message, config), true)
  assert.equal(isDiscordChatMessageAllowed({ ...message, guildId: null }, config), false)
  assert.equal(
    isDiscordChatMessageAllowed({ ...message, guildId: '52345678901234567' }, config),
    false,
  )
  assert.equal(
    isDiscordChatMessageAllowed({ ...message, channelId: '62345678901234567' }, config),
    false,
  )
  assert.equal(
    isDiscordChatMessageAllowed({ ...message, userId: '72345678901234567' }, config),
    false,
  )
  assert.equal(isDiscordChatMessageAllowed({ ...message, isBot: true }, config), false)
  assert.equal(isDiscordChatMessageAllowed({ ...message, isWebhook: true }, config), false)
  assert.equal(isDiscordChatMessageAllowed({ ...message, isSystem: true }, config), false)
  assert.equal(isDiscordChatMessageAllowed({ ...message, mentionsBot: false }, config), true)
})

test('discord chat: bot mention を本文から除き、他の user mention は残す', () => {
  assert.equal(
    stripDiscordBotMention(
      '<@12345678901234567> こんにちは <@!12345678901234567>',
      '12345678901234567',
    ),
    'こんにちは',
  )
  assert.equal(
    stripDiscordBotMention('<@12345678901234567> hi <@72345678901234567>', '12345678901234567'),
    'hi <@72345678901234567>',
  )
})

test('discord chat: reply を Discord の上限より短く分割し、surrogate pair を切らない', () => {
  assert.deepEqual(splitDiscordChatReply('one two three', 7), ['one two', 'three'])
  assert.deepEqual(splitDiscordChatReply('ab🙂cd', 4), ['ab🙂', 'cd'])
  assert.ok(
    splitDiscordChatReply('a'.repeat(4001)).every((chunk) => {
      return chunk.length <= 1900
    }),
  )
})

test('discord chat: reply nonce は同じ message/chunk で安定し、25文字以内', () => {
  assert.equal(
    discordChatReplyNonce('123456789012345678', 0),
    discordChatReplyNonce('123456789012345678', 0),
  )
  assert.notEqual(
    discordChatReplyNonce('123456789012345678', 0),
    discordChatReplyNonce('123456789012345678', 1),
  )
  assert.ok(discordChatReplyNonce('123456789012345678', 0).length <= 25)
})

test('discord chat: 許可 channel の mention なし message を redaction 後に submit する', async () => {
  const submitted: { content: string; requestId: string }[] = []
  const replies: { content: string; nonce: string }[] = []
  await createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor(['secret-token']),
    session: {
      submit: async (content, requestId) => {
        submitted.push({ content, requestId })

        return '回答 secret-tokenです'
      },
      reset: async () => {},
    },
    log: () => {},
  }).handle(
    {
      ...message,
      mentionsBot: false,
      messageId: '82345678901234567',
      content: 'secret-tokenを確認して',
    },
    async (content, nonce) => {
      replies.push({ content, nonce })
    },
  )

  assert.deepEqual(submitted, [
    {
      content: `Discord user ${message.userId} said:\n[REDACTED]を確認して`,
      requestId: '82345678901234567',
    },
  ])
  assert.deepEqual(
    replies.map(({ content }) => {
      return content
    }),
    ['回答 [REDACTED]です'],
  )
  assert.ok(replies[0]?.nonce.startsWith('araya-'))
})

test('discord chat: mention なしの空本文は無視し、mention だけなら入力を促す', async () => {
  const submitted: string[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)

        return 'unexpected'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  await handler.handle(
    { ...message, mentionsBot: false, messageId: 'empty-message', content: '   ' },
    async (content) => {
      replies.push(content)
    },
  )
  await handler.handle(
    { ...message, messageId: 'mention-only-message', content: '<@12345678901234567>' },
    async (content) => {
      replies.push(content)
    },
  )

  assert.deepEqual(submitted, [])
  assert.deepEqual(replies, ['メッセージを入力してください。'])
})

test('discord chat: reset command は Pi session を reset し model には送らない', async () => {
  const resetRequestIds: Array<string | undefined> = []
  let submitCount = 0
  const replies: string[] = []
  await createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        submitCount += 1

        return 'unexpected'
      },
      reset: async (requestId?: string) => {
        resetRequestIds.push(requestId)
      },
    },
    log: () => {},
  }).handleCommand(
    commandRequest({ subcommand: 'reset', interactionId: 'interaction-reset-0' }),
    async (content) => {
      replies.push(content)
    },
  )

  assert.deepEqual(resetRequestIds, ['interaction-reset-0'])
  assert.equal(submitCount, 0)
  assert.deepEqual(replies, ['この channel の会話をリセットしました'])
})

test('discord chat: 会話ターンは到着順に直列化する', async () => {
  const started: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        started.push(content.includes('first') ? 'first' : 'second')

        if (started.length === 1) {
          await firstGate
        }

        return 'ok'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  async function reply() {}

  const firstTurn = handler.handle(
    { ...message, messageId: 'a', content: '<@12345678901234567> first' },
    reply,
  )
  const secondTurn = handler.handle(
    { ...message, messageId: 'b', content: '<@12345678901234567> second' },
    reply,
  )

  await Promise.resolve()
  assert.deepEqual(started, ['first'])
  if (releaseFirst === undefined) {
    throw new Error('first turn gate was not initialized')
  }

  releaseFirst()
  await Promise.all([firstTurn, secondTurn])
  assert.deepEqual(started, ['first', 'second'])
})

test('discord chat: stopAccepting は受付を止めても進行中のturnをdrainする', async () => {
  let releaseFirst: (() => void) | undefined
  let signalFirstStarted: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve
  })
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const submitted: string[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)
        signalFirstStarted?.()
        await firstGate

        return 'first reply'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  const firstTurn = handler.handle(
    { ...message, messageId: 'stop-first', content: '<@12345678901234567> first' },
    async (content) => {
      replies.push(content)
    },
  )
  await firstStarted
  handler.stopAccepting()
  await handler.handle(
    { ...message, messageId: 'stop-second', content: '<@12345678901234567> second' },
    async (content) => {
      replies.push(content)
    },
  )
  releaseFirst?.()
  await firstTurn
  await handler.drain()

  assert.equal(submitted.length, 1)
  assert.deepEqual(replies, ['first reply'])
})

test('discord chat: stop は受付済みで未開始のキュー内 message を実行せず破棄する', async () => {
  const submitted: string[] = []
  let stopCalls = 0
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        if (content.includes('SLOW')) {
          await new Promise((resolve) => {
            setTimeout(resolve, 150)
          })
        }

        submitted.push(content)

        return 'ok'
      },
      reset: async () => {},
      stop: async () => {
        stopCalls += 1
      },
    },
    log: () => {},
  })
  const noopReply = async () => {}

  const first = handler.handle(
    { ...message, messageId: '92345678901234561', content: 'SLOW first' },
    noopReply,
  )
  const queued = handler.handle(
    { ...message, messageId: '92345678901234562', content: 'QUEUED second' },
    noopReply,
  )
  // queued がまだ開始する前に stop を受け付ける
  await new Promise((resolve) => {
    setTimeout(resolve, 30)
  })
  // slash command の stop は queue を通さないので、実行中の turn を待たずに効く
  const stopAck = handler.handleCommand(commandRequest({ subcommand: 'stop' }), async () => {})

  await Promise.all([first, queued, stopAck])

  assert.equal(stopCalls, 1)
  assert.deepEqual(submitted, ['Discord user 42345678901234567 said:\nSLOW first'])
})

test('discord chat: HOOT inject は人間の message と同じ session・queue で submit し、notice と answer を返す', async () => {
  const submitted: { content: string; requestId: string }[] = []
  const replies: { content: string; nonce: string }[] = []
  let releaseHuman: () => void = () => {}
  const humanGate = new Promise<void>((resolve) => {
    releaseHuman = resolve
  })

  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor(['hoot-secret']),
    session: {
      submit: async (content, requestId) => {
        submitted.push({ content, requestId })

        if (requestId === '82345678901234567') {
          await humanGate
        }

        return requestId === '82345678901234567'
          ? 'human answer'
          : 'HOOT 案件を進めました hoot-secret'
      },
      reset: async () => {},
    },
    log: () => {},
  })
  const noopReply = async () => {}
  const replyLog = async (content: string, nonce: string) => {
    replies.push({ content, nonce })
  }

  const human = handler.handle(
    { ...message, messageId: '82345678901234567', content: 'human message' },
    noopReply,
  )
  // 人間の message が実行中に HOOT inject を積んでも、同じ queue で直列化する
  const injected = handler.inject(
    {
      content: 'HOOT dispatch の承認済み案件 hoot-secret',
      notice: 'HOOT dispatch を main 会話に渡しました（proposal: abc / 人間の承認）',
      requestId: 'hoot-inject:abc:1',
    },
    replyLog,
  )

  releaseHuman()
  const answer = await injected
  await human

  assert.deepEqual(
    submitted.map((entry) => {
      return entry.requestId
    }),
    ['82345678901234567', 'hoot-inject:abc:1'],
  )
  // main 会話に渡す content は secret を置き換えてある
  assert.equal(submitted[1]?.content, 'HOOT dispatch の承認済み案件 [REDACTED]')
  assert.equal(answer, 'HOOT 案件を進めました hoot-secret')
  assert.deepEqual(
    replies.map((entry) => {
      return entry.content
    }),
    [
      'HOOT dispatch を main 会話に渡しました（proposal: abc / 人間の承認）',
      'HOOT 案件を進めました [REDACTED]',
    ],
  )
  // notice と answer の nonce は違う（同じだと gateway の dedupe で answer が落ちる）
  assert.notEqual(replies[0]?.nonce, replies[1]?.nonce)
})

test('discord chat: session が無い / stop 後の HOOT inject は hoot_inject_unavailable', async () => {
  const replyLog = async () => {}

  const noSession = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: null,
    log: () => {},
  })

  await assert.rejects(() => {
    return noSession.inject(
      { content: 'HOOT dispatch', notice: 'notice', requestId: 'hoot-inject:abc:1' },
      replyLog,
    )
  }, /hoot_inject_unavailable/u)

  let submitted = 0
  const stopped = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        submitted += 1

        return 'answer'
      },
      reset: async () => {},
    },
    log: () => {},
  })
  stopped.stopAccepting()

  await assert.rejects(() => {
    return stopped.inject(
      { content: 'HOOT dispatch', notice: 'notice', requestId: 'hoot-inject:abc:2' },
      replyLog,
    )
  }, /hoot_inject_unavailable/u)
  assert.equal(submitted, 0)
})

test('discord chat: HOOT inject の submit が失敗しても queue は止まらず次の message を処理する', async () => {
  const submitted: string[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)

        if (content.includes('HOOT dispatch')) {
          throw new Error('discord send failed: 429')
        }

        return 'answer after inject failure'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  await assert.rejects(() => {
    return handler.inject(
      { content: 'HOOT dispatch の案件', notice: 'notice', requestId: 'hoot-inject:abc:3' },
      async (content) => {
        replies.push(content)
      },
    )
  }, /429/u)
  // 失敗で送っていない
  assert.equal(replies.length, 0)

  await handler.handle(
    { ...message, messageId: '92345678901234570', content: 'after inject' },
    async (content) => {
      replies.push(content)
    },
  )
  assert.equal(submitted.length, 2)
  assert.match(replies[0] ?? '', /answer after inject failure/u)
  await handler.drain()
})

function commandRequest(input: {
  name?: string
  group?: string | null
  subcommand: string
  options?: Record<string, string | number | boolean>
  interactionId?: string
  userId?: string
  channelId?: string | null
}) {
  return {
    interactionId: input.interactionId ?? 'interaction-1',
    commandName: input.name ?? 'araya',
    userId: input.userId ?? '42345678901234567',
    guildId: config.guildId,
    channelId: input.channelId === undefined ? config.channelId : input.channelId,
    subcommandGroup: input.group ?? null,
    subcommand: input.subcommand,
    options: input.options ?? {},
  }
}

test('discord chat: /araya status は実行中のターンを待たずに応答し model には送らない', async () => {
  let releaseTurn: (() => void) | undefined
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const submitted: string[] = []
  const replies: string[] = []
  const commandReplies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)
        await turnGate

        return '長い作業の応答'
      },
      reset: async () => {},
      describe: () => {
        return { conversationId: 42 }
      },
    },
    log: () => {},
  })

  const turn = handler.handle(
    { ...message, messageId: '92345678901234571', content: '長い作業をして' },
    async (content) => {
      replies.push(content)
    },
  )
  // submit が始まるまで待つ（= 会話実行中）
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })

  await handler.handleCommand(commandRequest({ subcommand: 'status' }), async (content) => {
    commandReplies.push(content)
  })

  assert.equal(commandReplies.length, 1, 'slash command は実行中でも queue を待たずに応答する')
  assert.match(commandReplies[0] ?? '', /main conversation #42 \/ 実行中 1 \/ 待ち 0/u)
  assert.deepEqual(submitted, ['Discord user 42345678901234567 said:\n長い作業をして'])

  releaseTurn?.()
  await turn
  await handler.drain()
  assert.equal(replies.length, 1)
  assert.match(replies[0] ?? '', /長い作業の応答/u)
})

test('discord chat: status や hoot ... という text message は会話として model に渡す（control は slash だけ）', async () => {
  const submitted: string[] = []
  const resetRequestIds: string[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)

        return '会話の応答'
      },
      reset: async (requestId) => {
        resetRequestIds.push(requestId ?? '')
      },
    },
    log: () => {},
  })

  for (const content of [
    'status',
    'stop',
    'session reset',
    'hoot dispatch --key abc',
    'hoot の状態を教えて',
  ]) {
    await handler.handle(
      { ...message, messageId: `923456789012346${submitted.length}`, content },
      async (replyContent) => {
        replies.push(replyContent)
      },
    )
  }

  assert.deepEqual(submitted, [
    'Discord user 42345678901234567 said:\nstatus',
    'Discord user 42345678901234567 said:\nstop',
    'Discord user 42345678901234567 said:\nsession reset',
    'Discord user 42345678901234567 said:\nhoot dispatch --key abc',
    'Discord user 42345678901234567 said:\nhoot の状態を教えて',
  ])
  assert.equal(resetRequestIds.length, 0, 'text message の session reset は reset を走らせない')
  assert.deepEqual(replies, ['会話の応答', '会話の応答', '会話の応答', '会話の応答', '会話の応答'])
})

test('discord chat: /araya reset は interaction id で session を reset し model には送らない', async () => {
  const resetRequestIds: (string | undefined)[] = []
  const replies: string[] = []
  const commandReplies: string[] = []
  let submitCount = 0

  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        submitCount += 1

        return 'unexpected'
      },
      reset: async (requestId?: string) => {
        resetRequestIds.push(requestId)
      },
    },
    log: () => {},
  })

  await handler.handleCommand(
    commandRequest({ subcommand: 'reset', interactionId: 'interaction-reset-1' }),
    async (content) => {
      commandReplies.push(content)
    },
  )

  assert.deepEqual(resetRequestIds, ['interaction-reset-1'])
  assert.equal(submitCount, 0)
  assert.match(commandReplies.join('\n'), /会話をリセットしました/u)

  // session が無ければ reset できない旨を返す
  const offline = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: null,
    log: () => {},
  })
  const offlineReplies: string[] = []
  await offline.handleCommand(commandRequest({ subcommand: 'reset' }), async (content) => {
    offlineReplies.push(content)
  })
  assert.match(offlineReplies.join('\n'), /リセットできませんでした/u)
})

test('discord chat: /araya stop は queue 内の message を取り消して session を止める', async () => {
  const submitted: string[] = []
  const commandReplies: string[] = []
  let stopCount = 0
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)

        if (content.includes('1 件目')) {
          await firstGate
        }

        return '会話の応答'
      },
      reset: async () => {},
      stop: async () => {
        stopCount += 1
      },
    },
    log: () => {},
  })

  const first = handler.handle(
    { ...message, messageId: '92345678901234581', content: '1 件目' },
    async () => {},
  )
  // 1 件目が実行中になってから 2 件目を queue に積む
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })
  const second = handler.handle(
    { ...message, messageId: '92345678901234582', content: '2 件目' },
    async () => {},
  )

  await handler.handleCommand(commandRequest({ subcommand: 'stop' }), async (content) => {
    commandReplies.push(content)
  })
  releaseFirst?.()
  await Promise.all([first, second])
  await handler.drain()
  assert.equal(stopCount, 1)
  assert.match(commandReplies.join('\n'), /中止を要求/u)
  assert.match(commandReplies.join('\n'), /実行待ち 1 件を取り消しました/u)
  assert.deepEqual(
    submitted,
    ['Discord user 42345678901234567 said:\n1 件目'],
    '実行待ちの 2 件目は走らない',
  )
})

test('discord chat: 許可外の user / channel の slash command は拒否して log に残す', async () => {
  const logs: Record<string, unknown>[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => 'unexpected',
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })

  await handler.handleCommand(
    commandRequest({ subcommand: 'status', userId: '99999999999999999' }),
    async (content) => {
      replies.push(content)
    },
  )
  await handler.handleCommand(
    commandRequest({ subcommand: 'status', channelId: '62345678901234567' }),
    async (content) => {
      replies.push(content)
    },
  )

  assert.equal(replies.length, 2)
  assert.match(replies[0] ?? '', /使える channel/u)
  assert.deepEqual(
    logs.filter((entry) => {
      return entry.type === 'discord_command_denied'
    }).length,
    2,
  )
})

test('discord chat: /hoot dispatch は inject request を pending にし、session が無くても HOOT 操作は効く', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'araya-chat-hoot-test-')))
  const commandReplies: string[] = []
  const submitted: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir,
    redactor: createRedactor([]),
    nowMs: () => {
      return Date.parse('2026-11-20T09:00:00.000Z')
    },
    session: {
      submit: async (content) => {
        submitted.push(content)

        return '会話の応答'
      },
      reset: async () => {},
    },
    log: () => {},
  })

  await handler.handleCommand(
    commandRequest({
      name: 'hoot',
      group: 'goal',
      subcommand: 'add',
      options: { key: 'araya-quality', objective: 'diff を見る' },
    }),
    async (content) => {
      commandReplies.push(content)
    },
  )
  await handler.handleCommand(
    commandRequest({
      name: 'hoot',
      group: 'settings',
      subcommand: 'set',
      options: { enabled: true, mode: 'active' },
    }),
    async (content) => {
      commandReplies.push(content)
    },
  )
  await upsertProposal(dataDir, {
    key: 'dispatch-proposal',
    decision: 'dispatch',
    goalKeys: ['araya-quality'],
    reason: 'draft PR の diff を渡す',
    occurrenceKey: 'hoot:2026-11-20T09:00:00.000Z',
    nowMs: Date.parse('2026-11-20T09:00:00.000Z'),
  })

  await handler.handleCommand(
    commandRequest({ name: 'hoot', subcommand: 'dispatch', options: { key: 'dispatch-proposal' } }),
    async (content) => {
      commandReplies.push(content)
    },
  )

  const state = await readHootState(dataDir)
  assert.equal(state.injectRequests.length, 1)
  assert.equal(state.injectRequests[0]?.authorizedBy, 'human')
  assert.equal(state.injectRequests[0]?.status, 'pending')
  assert.match(commandReplies.join('\n'), /hoot-inject:dispatch-proposal:1/u)
  assert.equal(submitted.length, 0, 'slash command は model に渡さない')

  // session が無ても HOOT の操作は効く
  const offline = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir,
    redactor: createRedactor([]),
    session: null,
    log: () => {},
  })
  const offlineReplies: string[] = []
  await offline.handleCommand(
    commandRequest({ name: 'hoot', group: 'inject', subcommand: 'list' }),
    async (content) => {
      offlineReplies.push(content)
    },
  )
  assert.match(offlineReplies.join('\n'), /\[pending\] dispatch proposal=dispatch-proposal/u)

  await fs.rm(dataDir, { recursive: true, force: true })
})

test('discord chat: 受理した message は messageId 付きの received log を残し本文を書かない', async () => {
  const logs: Record<string, unknown>[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => 'ok',
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })

  await handler.handle(
    { ...message, mentionsBot: false, messageId: '92345678901234601', content: '受信証跡の本文' },
    async () => {},
  )

  const received = logs.find((entry) => {
    return entry.type === 'discord_chat_received'
  })
  assert.ok(received, '受理した message の received log がある')
  assert.equal(received?.messageId, '92345678901234601')
  assert.equal(received?.mentionsBot, false)
  assert.ok(
    !logs.some((entry) => {
      return JSON.stringify(entry).includes('受信証跡の本文')
    }),
    'log に本文を残さない',
  )
})

test('discord chat: mention なし空本文の message は ignored log に messageId と理由を残す', async () => {
  const logs: Record<string, unknown>[] = []
  const submitted: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async (content) => {
        submitted.push(content)

        return 'unexpected'
      },
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })

  await handler.handle(
    { ...message, mentionsBot: false, messageId: '92345678901234602', content: '   ' },
    async () => {},
  )

  const ignored = logs.find((entry) => {
    return entry.type === 'discord_chat_ignored'
  })
  assert.ok(ignored, '空本文 message の ignored log がある')
  assert.equal(ignored?.messageId, '92345678901234602')
  assert.equal(ignored?.reason, 'empty_content')
  assert.deepEqual(submitted, [])
})

test('discord chat: stopAccepting 後の message は ignored log に not_accepting を残す', async () => {
  const logs: Record<string, unknown>[] = []
  let submitCount = 0
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        submitCount += 1

        return 'unexpected'
      },
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })
  handler.stopAccepting()

  await handler.handle(
    { ...message, messageId: '92345678901234603', content: '停止後に到着' },
    async () => {},
  )

  const ignored = logs.find((entry) => {
    return entry.type === 'discord_chat_ignored'
  })
  assert.ok(ignored, '停止後 message の ignored log がある')
  assert.equal(ignored?.messageId, '92345678901234603')
  assert.equal(ignored?.reason, 'not_accepting')
  assert.equal(submitCount, 0)
})

test('discord chat: 許可外 message は handle でも ignored log に failures を残す', async () => {
  const logs: Record<string, unknown>[] = []
  let submitCount = 0
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        submitCount += 1

        return 'unexpected'
      },
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })

  await handler.handle(
    {
      ...message,
      messageId: '92345678901234604',
      userId: '72345678901234567',
      content: '許可外 user',
    },
    async () => {},
  )

  const ignored = logs.find((entry) => {
    return entry.type === 'discord_chat_ignored'
  })
  assert.ok(ignored, '許可外 message の ignored log がある')
  assert.equal(ignored?.messageId, '92345678901234604')
  const failures = ignored?.failures
  assert.ok(Array.isArray(failures), 'failures が配列')
  assert.ok((failures as string[]).includes('user_not_allowed'))
  assert.equal(submitCount, 0)
})

test('discord chat: 会話 turn 失敗の log に messageId を残す', async () => {
  const logs: Record<string, unknown>[] = []
  const replies: string[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => {
        throw new Error('model submit failed')
      },
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })

  await handler.handle(
    { ...message, messageId: '92345678901234605', content: '失敗する会話' },
    async (content) => {
      replies.push(content)
    },
  )

  const failed = logs.find((entry) => {
    return entry.type === 'discord_chat_turn_failed'
  })
  assert.ok(failed, 'turn 失敗の log がある')
  assert.equal(failed?.messageId, '92345678901234605')
  assert.match(replies.join('\n'), /会話の処理に失敗しました/u)
})

test('discord chat: 返信失敗の log に messageId を残す', async () => {
  const logs: Record<string, unknown>[] = []
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => '回答本文',
      reset: async () => {},
    },
    log: (entry) => {
      logs.push(entry)
    },
  })

  await handler.handle(
    { ...message, messageId: '92345678901234606', content: '返信が失敗する' },
    async () => {
      throw new Error('discord send failed')
    },
  )

  const failed = logs.find((entry) => {
    return entry.type === 'discord_chat_reply_failed'
  })
  assert.ok(failed, 'reply 失敗の log がある')
  assert.equal(failed?.messageId, '92345678901234606')
})

test('discord chat: runControl は CLI の control request を slash command と同じ kernel で処理し text で返す', async () => {
  const logs: Record<string, unknown>[] = []
  const resetRequestIds: (string | undefined)[] = []
  let stopCalls = 0
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor(['cli-secret']),
    session: {
      submit: async () => 'ok',
      reset: async (requestId?: string) => {
        resetRequestIds.push(requestId)
      },
      stop: async () => {
        stopCalls += 1
      },
      describe: () => {
        return { conversationId: 7 }
      },
    },
    log: (entry) => {
      return logs.push(entry)
    },
  })

  // status: 会話 session の状態と HOOT status が同じ kernel から出てくる（/araya status と 1:1）
  const statusText = await handler.runControl(
    commandRequest({ subcommand: 'status', userId: 'cli', interactionId: 'cli-status-1' }),
  )
  assert.match(statusText, /会話: main conversation #7/)
  assert.match(statusText, /enabled/)
  assert.equal(stopCalls, 0)

  const stopText = await handler.runControl(
    commandRequest({ subcommand: 'stop', userId: 'cli', interactionId: 'cli-stop-1' }),
  )
  assert.equal(stopCalls, 1)
  assert.match(stopText, /中止を要求/)

  // reset の requestId は CLI の request id（同じ request を 2 回実行しないための識別子）
  const resetText = await handler.runControl(
    commandRequest({ subcommand: 'reset', userId: 'cli', interactionId: 'cli-reset-1' }),
  )
  assert.deepEqual(resetRequestIds, ['cli-reset-1'])
  assert.match(resetText, /リセットしました/)

  // 未知の subcommand は throw せず応答 text になる（CLI 側は ok:true で受け取る）
  const unknownText = await handler.runControl(
    commandRequest({ subcommand: 'dispatch', userId: 'cli', interactionId: 'cli-unknown-1' }),
  )
  assert.match(unknownText, /知りません/)

  // log は command 名だけ（option の値・本文を書かない）。unknown subcommand は discord_control_failed
  const commands = logs
    .filter((entry) => {
      return entry.type === 'discord_control_command'
    })
    .map((entry) => entry.command)
  assert.deepEqual(commands, ['araya status', 'araya stop', 'araya reset'])
  const failed = logs.find((entry) => {
    return entry.type === 'discord_control_failed'
  })
  assert.equal(failed?.command, 'araya dispatch')
})

test('discord chat: runControl は Discord の allowlist を要求しない（CLI 入口の guard と file 権限が境界）', async () => {
  const handler = createDiscordChatHandler({
    config,
    botUserId: '12345678901234567',
    dataDir: chatDataDir,
    redactor: createRedactor([]),
    session: {
      submit: async () => 'ok',
      reset: async () => {},
      describe: () => {
        return { conversationId: 3 }
      },
    },
    log: () => {},
  })
  const replies: string[] = []

  // 同じ request を handleCommand（Discord の interaction 経路）に渡すと allowlist で拒否される
  await handler.handleCommand(
    commandRequest({ subcommand: 'status', userId: 'cli' }),
    async (text) => {
      replies.push(text)
    },
  )
  assert.match(replies.join(''), /使える channel/)

  // runControl は bot process 内の control 経路なので Discord の allowlist は通さない（境界は control dir を書ける OS user）
  const text = await handler.runControl(commandRequest({ subcommand: 'status', userId: 'cli' }))
  assert.match(text, /main conversation #3/)
})
