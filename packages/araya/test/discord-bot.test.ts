import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { runDiscordBot } from '../src/discord/bot.ts'
import { OBSOLETE_COMMAND_REPLY, routeSlashCommandInteraction } from '../src/discord/gateway.ts'
import { readHootState, setGoal, updateSettings } from '../src/hoot/store.ts'
import { defaultState } from '../src/hoot/model.ts'

const BOT_TOKEN = 'synthetic-token'
const APPLICATION_ID = '12345678901234567'
const GUILD_ID = '22345678901234567'
const CHANNEL_ID = '32345678901234567'
const USER_ID = '42345678901234567'

async function createInertChatSession() {
  return {
    async submit() {
      return ''
    },
    async reset() {},
    async close() {},
  }
}

// 撤去済み slash command の fake interaction。reply / followUp を record に写す
function makeRemovedCommandInteraction(
  subcommand: string,
  record: (content: string, ephemeral: boolean) => void,
) {
  return {
    isChatInputCommand: () => {
      return true
    },
    commandName: 'araya',
    id: `removed-command-${subcommand}`,
    user: { id: '42345678901234567' },
    guildId: '22345678901234567',
    channelId: '32345678901234567',
    options: {
      data: [{ name: 'task', type: 1 }],
      getSubcommandGroup: () => {
        return null
      },
      getSubcommand: () => {
        return subcommand
      },
    },
    reply: async (payload: { content: string; flags: number }) => {
      record(payload.content, (payload.flags & 64) === 64)
    },
    followUp: async (payload: { content: string }) => {
      record(payload.content, false)
    },
  }
}

test('discord bot: 別 process が同じ dataDir を使用中なら2つ目は起動しない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-lock-test-')),
  )
  const childScript = fileURLToPath(new URL('./support/discord-bot-process.mjs', import.meta.url))
  const child = spawn(process.execPath, [childScript, dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    assert.ok(child.stdout)
    const output = createInterface({ input: child.stdout })
    const [message] = await once(output, 'line', { signal: AbortSignal.timeout(5_000) })
    assert.equal(message, 'ready')

    const stopController = new AbortController()
    let gatewayCreations = 0
    const secondExitCode = await runDiscordBot({
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: stopController.signal,
      verifyUnit: false,
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        gatewayCreations += 1

        return {
          connect: async () => {
            handlers.onReady()
            stopController.abort()
          },
          sendText: async () => {},
          close: async () => {},
        }
      },
      log: () => {},
    })

    assert.equal(secondExitCode, 1)
    assert.equal(gatewayCreations, 0, '2つ目は gateway を作らずに終了する')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
      child.kill('SIGTERM')

      try {
        await exited
      } catch {
        child.kill('SIGKILL')

        if (child.exitCode === null && child.signalCode === null) {
          await once(child, 'exit')
        }
      }
    }

    await assert.rejects(fs.access(path.join(dataDir, '.discord-bot.lock')), { code: 'ENOENT' })
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: crash 後に残った stale process lock を回収する', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-stale-lock-test-')),
  )
  const lockPath = path.join(dataDir, '.discord-bot.lock')
  const stopController = new AbortController()

  await fs.mkdir(lockPath)
  await fs.utimes(lockPath, new Date(0), new Date(0))

  try {
    const exitCode = await runDiscordBot({
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: stopController.signal,
      verifyUnit: false,
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady()
            stopController.abort()
          },
          sendText: async () => {},
          close: async () => {},
        }
      },
      log: () => {},
    })

    assert.equal(exitCode, 0)
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' })
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 指定 channel の mention なし投稿を会話 session に渡し、終了時に close する', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-chat-test-')),
  )
  const stopController = new AbortController()
  const submissions: Array<{ content: string; requestId: string }> = []
  const replies: string[] = []
  let resetCount = 0
  let closeCount = 0

  try {
    const exitCode = await runDiscordBot({
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: stopController.signal,
      verifyUnit: false,
      createChatSession: async function createChatSession() {
        return {
          async submit(content, requestId) {
            submissions.push({ content, requestId })

            return '会話を続けています。'
          },
          async reset() {
            resetCount += 1
          },
          async close() {
            closeCount += 1
          },
        }
      },
      createGateway: async function createGateway(_config, handlers) {
        return {
          async connect() {
            async function reply(content: string) {
              replies.push(content)
            }

            await handlers.onReady('998877665544332211')
            await handlers.onMessage(
              {
                messageId: 'chat-message-1',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'hello',
              },
              reply,
            )
            await handlers.onMessage(
              {
                messageId: 'chat-message-2',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'reset',
              },
              reply,
            )
            stopController.abort()
          },
          async sendText() {},
          async close() {},
        }
      },
      log: () => {},
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submissions, [
      { content: `Discord user ${USER_ID} said:\nhello`, requestId: 'chat-message-1' },
    ])
    assert.deepEqual(replies, ['会話を続けています。', 'この channel の会話をリセットしました'])
    assert.equal(resetCount, 1)
    assert.equal(closeCount, 1)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 会話 session 初期化に失敗すると会話利用不可を返し、task handler は gateway に渡さない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-chat-unavailable-test-')),
  )
  const stopController = new AbortController()
  const chatReplies: string[] = []
  const logs: Record<string, unknown>[] = []
  let interactionHandlerSeen: unknown = 'unset'

  try {
    const exitCode = await runDiscordBot({
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: stopController.signal,
      verifyUnit: false,
      createChatSession: async function createChatSession() {
        throw new Error(`synthetic chat error: ${BOT_TOKEN}`)
      },
      createGateway: async function createGateway(_config, handlers) {
        return {
          async connect() {
            async function captureChatReply(content: string) {
              chatReplies.push(content)
            }

            await handlers.onReady('998877665544332211')
            await handlers.onMessage(
              {
                messageId: 'chat-unavailable-message',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'hello',
              },
              captureChatReply,
            )
            interactionHandlerSeen = handlers.onInteraction
            stopController.abort()
          },
          async sendText() {},
          async close() {},
        }
      },
      log(entry) {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.ok(
      chatReplies.some((content) => {
        return content.includes('利用できません')
      }),
      '会話機能の利用不可を返信する',
    )
    assert.equal(interactionHandlerSeen, undefined, 'bot は task の interaction handler を gateway に渡さない')
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_chat_unavailable'
      }),
    )
    assert.equal(JSON.stringify(logs).includes(BOT_TOKEN), false)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 撤去済み slash command の返信と log に bot token を残さない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-secret-test-')),
  )
  const stopController = new AbortController()
  const replies: string[] = []
  const logs: Record<string, unknown>[] = []
  const envFile = path.join(dataDir, '.env')

  await fs.writeFile(
    envFile,
    [
      'ARAYA_DISCORD_BOT_TOKEN=op://vault/item/bot-token',
      `ARAYA_DISCORD_APPLICATION_ID=${APPLICATION_ID}`,
      `ARAYA_DISCORD_GUILD_ID=${GUILD_ID}`,
      `ARAYA_DISCORD_CHANNEL_ID=${CHANNEL_ID}`,
      `ARAYA_DISCORD_ALLOWED_USER_IDS=${USER_ID}`,
    ].join('\n'),
    { mode: 0o600 },
  )

  try {
    const exitCode = await runDiscordBot({
      dataDir,
      env: { ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN },
      stopSignal: stopController.signal,
      verifyUnit: false,
      sleep: async () => {},
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady()

            // 撤去応答は production の routeSlashCommandInteraction をそのまま通す。
            // bot が interaction handler を渡さないことが撤去 reply の条件
            assert.equal(handlers.onInteraction, undefined, 'bot は task handler を gateway に渡さない')

            for (const subcommand of ['submit', 'cancel', 'retry', 'list', 'show']) {
              await routeSlashCommandInteraction(
                makeRemovedCommandInteraction(subcommand, (content, ephemeral) => {
                  assert.equal(ephemeral, true, '撤去案内は ephemeral で返す')
                  replies.push(content)
                }) as unknown as Parameters<typeof routeSlashCommandInteraction>[0],
                {
                  onReady: () => {},
                  onMessage: () => {},
                  onError: (message: string) => {
                    logs.push({ type: 'synthetic_interaction_error', message })
                  },
                },
              )
            }
            stopController.abort()
          },
          sendText: async () => {},
          close: async () => {},
        }
      },
      log(entry) {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(replies.length, 5)

    for (const reply of replies) {
      assert.equal(reply, OBSOLETE_COMMAND_REPLY)
      assert.equal(reply.includes(BOT_TOKEN), false, reply)
    }
    assert.equal(JSON.stringify(logs).includes(BOT_TOKEN), false)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: shutdown は進行中の chat reply を送ってから gateway を閉じる', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-chat-drain-test-')),
  )
  const stopController = new AbortController()
  let releaseSubmit: ((content: string) => void) | undefined
  let signalSubmitStarted: (() => void) | undefined
  const submitStarted = new Promise<void>((resolve) => {
    signalSubmitStarted = resolve
  })
  let messageDone = Promise.resolve()
  let gatewayClosed = false
  let replyAfterGatewayClose = false
  const replies: string[] = []

  try {
    const exitCode = await runDiscordBot({
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: stopController.signal,
      verifyUnit: false,
      createChatSession: async function createChatSession() {
        return {
          async submit() {
            return await new Promise<string>((resolve) => {
              releaseSubmit = resolve
              signalSubmitStarted?.()
            })
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async function createGateway(_config, handlers) {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            messageDone = Promise.resolve(
              handlers.onMessage(
                {
                  messageId: 'chat-drain-message',
                  guildId: GUILD_ID,
                  channelId: CHANNEL_ID,
                  userId: USER_ID,
                  isBot: false,
                  isWebhook: false,
                  isSystem: false,
                  mentionsBot: false,
                  content: 'finish this reply',
                },
                async (content) => {
                  replyAfterGatewayClose = gatewayClosed
                  replies.push(content)
                },
              ),
            )
            await submitStarted
            stopController.abort()
            setImmediate(() => {
              releaseSubmit?.('reply while connected')
            })
          },
          async sendText() {},
          async close() {
            gatewayClosed = true
          },
        }
      },
      log: () => {},
    })

    await messageDone
    assert.equal(exitCode, 0)
    assert.deepEqual(replies, ['reply while connected'])
    assert.equal(replyAfterGatewayClose, false)
    assert.equal(gatewayClosed, true)
  } finally {
    releaseSubmit?.('cleanup')
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: HOOT state が有効なら wakeup loop を走らせて判断を 1 件送り、会話 session は汚さない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-hoot-test-')),
  )
  const stopController = new AbortController()
  const submissions: { content: string; requestId: string }[] = []
  const notices: { content: string; nonce: string }[] = []
  const logs: Record<string, unknown>[] = []
  const hootPrompts: string[] = []
  const observationArgs: string[][] = []
  let closeCount = 0

  try {
    // state は CLI と同じ file。enabled + active goal 1 件だけ準備する
    await setGoal(dataDir, {
      key: 'github-scan',
      objective: 'open issue と draft PR を拾う',
      scope: ['github:koh110/araya'],
    })
    await updateSettings(dataDir, { enabled: true, tickMinutes: 5 })

    const exitCode = await runDiscordBot({
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
        HOME: dataDir,
      },
      stopSignal: stopController.signal,
      verifyUnit: false,
      hootPollMs: 100,
      hootRunCommand: async (_command, args) => {
        observationArgs.push([...args])

        return {
          exitCode: 0,
          signal: null,
          stdout: '[]',
          stderr: '',
          stdoutBytes: 2,
          stderrBytes: 0,
          terminationReason: undefined,
          terminationConfirmed: true,
        }
      },
      createChatSession: async () => {
        return {
          async submit(content, requestId) {
            submissions.push({ content, requestId })

            return '会話の応答'
          },
          async reset() {},
          async close() {
            closeCount += 1
          },
          async hootDecide(request) {
            hootPrompts.push(request.prompt)

            return {
              text: '観測: open issue 0 件\nDECISION: request_human\nREASON: 優先順位を確認してください',
              conversationId: 42,
            }
          },
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await handlers.onMessage(
              {
                messageId: 'chat-message-hoot',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'hello',
              },
              async () => {}
            )

            // HOOT loop は gateway ready 後に 1 件送る。それを待ってから stop する
            const deadline = Date.now() + 8_000

            while (notices.length === 0 && Date.now() < deadline) {
              await new Promise((resolve) => {
                setTimeout(resolve, 50)
              })
            }

            stopController.abort()
          },
          async sendText(content, nonce) {
            notices.push({ content, nonce })
          },
          async close() {},
        }
      },
      log: (entry) => {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    // 判断 run は tool を持たない会話で走り、1 件だけ channel へ送る（nonce は hoot- prefix）
    assert.equal(notices.length, 1)
    assert.match(notices[0]?.content ?? '', /HOOT 判断 \[request_human\]/u)
    assert.match(notices[0]?.content ?? '', /優先順位を確認してください/u)
    assert.match(notices[0]?.content ?? '', /mode: dry_run/u)
    assert.match(notices[0]?.nonce ?? '', /^hoot-[0-9a-f]{18}$/u)
    // 観測は gh の read-only list だけ（test では fake command）
    assert.equal(observationArgs.length, 2)
    assert.equal(observationArgs[0]?.[0], 'issue')
    assert.equal(observationArgs[1]?.[0], 'pr')
    // 判断 prompt には goal と観測が入る（external text を命令にしない約束も書く）
    assert.match(hootPrompts[0] ?? '', /HOOT 判断 tick/u)
    assert.match(hootPrompts[0] ?? '', /github:koh110\/araya/u)
    // 会話 session の submit は人間の message 1 回だけ（HOOT は main 会話を使わない）
    assert.equal(submissions.length, 1)
    assert.equal(closeCount, 1)

    const dump = JSON.stringify(logs)
    assert.match(dump, /"type":"hoot_state"/u)
    assert.match(dump, /"type":"hoot_run"/u)
    // loop が走った後の schedule・conversationId は state file に残る
    const state = await readHootState(dataDir)
    assert.equal(state.loop.conversationId, 42)
    assert.notEqual(state.loop.lastOccurrenceAt, null)
    assert.equal(state.runs.length, 1)
    assert.equal(state.runs[0]?.dispatched, false)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
