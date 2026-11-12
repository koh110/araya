import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { openTaskLedger } from '../src/runner/ledger.ts'
import { runDiscordBot } from '../src/discord/bot.ts'
import { dataDirHash, discordUnitName, runnerUnitName } from '../src/infrastructure/systemd.ts'

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

test('discord bot: 指定 channel の mention を会話 session に渡し、終了時に close する', async () => {
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
                mentionsBot: true,
                content: '<@!998877665544332211> hello',
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
                mentionsBot: true,
                content: '<@998877665544332211> reset',
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

test('discord bot: 会話 session 初期化に失敗しても既存 slash command は利用できる', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-chat-unavailable-test-')),
  )
  const stopController = new AbortController()
  const chatReplies: string[] = []
  const commandReplies: string[] = []
  const logs: Record<string, unknown>[] = []

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

            async function captureCommandReply(content: string) {
              commandReplies.push(content)
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
                mentionsBot: true,
                content: '<@998877665544332211> hello',
              },
              captureChatReply,
            )
            await handlers.onInteraction(
              {
                interactionId: 'chat-unavailable-list',
                userId: USER_ID,
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                subcommandGroup: 'task',
                subcommand: 'list',
                options: {},
              },
              captureCommandReply,
            )
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
    assert.ok(commandReplies.length > 0, '既存 command に返信する')
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

test('discord bot: Task 操作の返信では Discord unit でなく runner unit を示す', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-test-')),
  )
  const stopController = new AbortController()
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
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            await handlers.onInteraction(
              {
                interactionId: 'interaction-unit-name',
                userId: USER_ID,
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                subcommandGroup: 'task',
                subcommand: 'submit',
                options: { title: 'unit name', goal: 'check displayed service' },
              },
              async (content) => {
                replies.push(content)
              },
            )
            stopController.abort()
          },
          sendText: async () => {},
          close: async () => {},
        }
      },
      log: () => {},
    })

    const hash = dataDirHash(dataDir)
    const runnerUnit = runnerUnitName(hash)
    const discordUnit = discordUnitName(hash)

    assert.equal(exitCode, 0)
    assert.ok(
      replies.some((content) => {
        return content.includes(`warning: ${runnerUnit} の unit`)
      }),
      replies.join('\n'),
    )
    assert.ok(
      !replies.some((content) => {
        return content.includes(discordUnit)
      }),
      replies.join('\n'),
    )
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 1Passwordで解決したbot tokenを task・retry note・reply・notification に残さない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-secret-test-')),
  )
  const stopController = new AbortController()
  const replies: string[] = []
  const notifications: string[] = []
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
            const request = {
              interactionId: 'secret-task',
              userId: USER_ID,
              guildId: GUILD_ID,
              channelId: CHANNEL_ID,
              subcommandGroup: 'task',
            }

            await handlers.onInteraction(
              {
                ...request,
                subcommand: 'submit',
                options: { title: `Task ${BOT_TOKEN}`, goal: `Goal ${BOT_TOKEN}` },
              },
              async (content) => {
                replies.push(content)
              },
            )
            await handlers.onInteraction(
              {
                ...request,
                interactionId: 'secret-cancel',
                subcommand: 'cancel',
                options: { task: 1 },
              },
              async (content) => {
                replies.push(content)
              },
            )
            await handlers.onInteraction(
              {
                ...request,
                interactionId: 'secret-retry',
                subcommand: 'retry',
                options: { task: 1, note: `retry ${BOT_TOKEN}` },
              },
              async (content) => {
                replies.push(content)
              },
            )
            await handlers.onInteraction(
              { ...request, interactionId: 'secret-list', subcommand: 'list', options: {} },
              async (content) => {
                replies.push(content)
              },
            )
            await handlers.onInteraction(
              {
                ...request,
                interactionId: 'secret-show',
                subcommand: 'show',
                options: { task: 1 },
              },
              async (content) => {
                replies.push(content)
              },
            )
          },
          sendText: async (content) => {
            notifications.push(content)
            stopController.abort()
          },
          close: async () => {},
        }
      },
      log: () => {},
    })

    const ledger = openTaskLedger(dataDir)

    try {
      const detail = ledger.showTask(1, { events: 0 })
      const storedRetryNote = detail.attempts[1]?.note ?? null
      const outputs = [
        ...replies,
        ...notifications,
        detail.task.title,
        detail.task.goal,
        ...(storedRetryNote === null ? [] : [storedRetryNote]),
      ]

      assert.equal(exitCode, 0)
      assert.equal(detail.task.attempt, 2)
      assert.equal(storedRetryNote, 'retry [REDACTED]')
      assert.ok(notifications.length > 0, 'created event が通知される')
      assert.ok(
        outputs.some((output) => {
          return output.includes('[REDACTED]')
        }),
        outputs.join('\n'),
      )

      for (const output of outputs) {
        assert.equal(output.includes(BOT_TOKEN), false, output)
      }
    } finally {
      ledger.close()
    }
  } finally {
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
                  mentionsBot: true,
                  content: '<@998877665544332211> finish this reply',
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
