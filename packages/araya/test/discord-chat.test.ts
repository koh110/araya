import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDiscordChatHandler,
  discordChatReplyNonce,
  isDiscordChatMessageAllowed,
  splitDiscordChatReply,
  stripDiscordBotMention,
  type DiscordChatMessageMetadata,
} from '../src/discord/chat.ts'
import { createRedactor } from '../src/infrastructure/redaction.ts'
import { readHootState, upsertProposal } from '../src/hoot/store.ts'
import type { DiscordConfig } from '../src/discord/config.ts'

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
  }).handle(
    { ...message, mentionsBot: false, messageId: '92345678901234567', content: 'reset' },
    async (content) => {
      replies.push(content)
    },
  )

  assert.deepEqual(resetRequestIds, ['92345678901234567'])
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
  const stopAck = handler.handle(
    { ...message, messageId: '92345678901234563', content: 'stop' },
    noopReply,
  )

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

        return requestId === '82345678901234567' ? 'human answer' : 'HOOT 案件を進めました hoot-secret'
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
    noopReply
  )
  // 人間の message が実行中に HOOT inject を積んでも、同じ queue で直列化する
  const injected = handler.inject(
    {
      content: 'HOOT dispatch の承認済み案件 hoot-secret',
      notice: 'HOOT dispatch を main 会話に渡しました（proposal: abc / 人間の承認）',
      requestId: 'hoot-inject:abc:1:attempt:1',
    },
    replyLog
  )

  releaseHuman()
  const answer = await injected
  await human

  assert.deepEqual(
    submitted.map((entry) => {
      return entry.requestId
    }),
    ['82345678901234567', 'hoot-inject:abc:1:attempt:1']
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
    ]
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

  await assert.rejects(
    () => {
      return noSession.inject({ content: 'HOOT dispatch', notice: 'notice', requestId: 'hoot-inject:abc:1' }, replyLog)
    },
    /hoot_inject_unavailable/u
  )

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

  await assert.rejects(
    () => {
      return stopped.inject({ content: 'HOOT dispatch', notice: 'notice', requestId: 'hoot-inject:abc:2' }, replyLog)
    },
    /hoot_inject_unavailable/u
  )
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

  await assert.rejects(
    () => {
      return handler.inject(
        { content: 'HOOT dispatch の案件', notice: 'notice', requestId: 'hoot-inject:abc:3' },
        async (content) => {
          replies.push(content)
        }
      )
    },
    /429/u
  )
  // 失敗で送っていない
  assert.equal(replies.length, 0)

  await handler.handle(
    { ...message, messageId: '92345678901234570', content: 'after inject' },
    async (content) => {
      replies.push(content)
    }
  )
  assert.equal(submitted.length, 2)
  assert.match(replies[0] ?? '', /answer after inject failure/u)
  await handler.drain()
})

test('discord chat: control command は実行中のターンを待たずに応答し model には送らない', async () => {
  let releaseTurn: (() => void) | undefined
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve
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

  await handler.handle(
    { ...message, messageId: '92345678901234572', content: 'status' },
    async (content) => {
      replies.push(content)
    },
  )

  assert.equal(replies.length, 1, 'status は実行中でも queue を待たずに応答する')
  assert.match(replies[0] ?? '', /main conversation #42 \/ 実行中 1 \/ 待ち 0/u)
  assert.deepEqual(submitted, ['Discord user 42345678901234567 said:\n長い作業をして'])

  releaseTurn?.()
  await turn
  await handler.drain()
  assert.equal(replies.length, 2)
  assert.match(replies[1] ?? '', /長い作業の応答/u)
})

test('discord chat: session reset と書いた message も reset として扱う', async () => {
  const resetRequestIds: (string | undefined)[] = []
  const replies: string[] = []
  let submitCount = 0

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
  }).handle(
    { ...message, mentionsBot: true, messageId: '92345678901234573', content: '<@12345678901234567> session reset' },
    async (content) => {
      replies.push(content)
    },
  )

  assert.deepEqual(resetRequestIds, ['92345678901234573'])
  assert.equal(submitCount, 0)
})

test('discord chat: hoot dispatch を Discord から送ると inject request が pending になる', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'araya-chat-hoot-test-')))
  const replies: string[] = []
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

  await handler.handle(
    { ...message, messageId: '92345678901234574', content: 'hoot goal add --key araya-quality --objective "diff を見る"' },
    async (content) => {
      replies.push(content)
    },
  )
  await handler.handle(
    { ...message, messageId: '92345678901234575', content: 'hoot settings set --enabled true --mode active' },
    async (content) => {
      replies.push(content)
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

  await handler.handle(
    { ...message, messageId: '92345678901234576', content: 'hoot dispatch --key dispatch-proposal' },
    async (content) => {
      replies.push(content)
    },
  )

  const state = await readHootState(dataDir)
  assert.equal(state.injectRequests.length, 1)
  assert.equal(state.injectRequests[0]?.authorizedBy, 'human')
  assert.equal(state.injectRequests[0]?.status, 'pending')
  assert.match(replies.join('\n'), /hoot-inject:dispatch-proposal:1/u)
  assert.equal(submitted.length, 0, 'control command は model に渡さない')

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
  await offline.handle(
    { ...message, messageId: '92345678901234577', content: 'hoot inject list' },
    async (content) => {
      offlineReplies.push(content)
    },
  )
  assert.match(offlineReplies.join('\n'), /\[pending\] dispatch proposal=dispatch-proposal/u)
})
