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
import { readHootState, enqueueHootInject, setGoal, updateSettings, upsertProposal } from '../src/hoot/store.ts'
import { defaultState, proposalKeyOf } from '../src/hoot/model.ts'

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
    describe: () => {
      return { conversationId: 1 }
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

// Discord がくれる ChatInputCommandInteraction の fake（slash command の test で使う）
function makeSlashInteraction(
  input: {
    commandName: string
    subcommand: string
    group?: string | null
    options?: { name: string; value: string }[]
    id?: string
  },
  record: (content: string, ephemeral: boolean) => void,
) {
  return {
    isChatInputCommand: () => {
      return true
    },
    commandName: input.commandName,
    id: input.id ?? `${input.commandName}-${input.subcommand}`,
    user: { id: USER_ID },
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    options: {
      data: (input.options ?? []).map((option) => {
        return { name: option.name, type: 3, value: option.value }
      }),
      getSubcommandGroup: () => {
        return input.group ?? null
      },
      getSubcommand: () => {
        return input.subcommand
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
          async registerCommands() {
            return 2
          },
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
          async registerCommands() {
            return 2
          },
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
  const registeredCommands: { name: string }[][] = []

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
          describe: () => {
            return { conversationId: 1 }
          },
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
            // 会話を操作する command は slash command（text message の reset は会話として model に渡る）
            await handlers.onInteraction?.(
              {
                interactionId: 'interaction-reset',
                commandName: 'araya',
                userId: USER_ID,
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                subcommandGroup: null,
                subcommand: 'reset',
                options: {},
              },
              reply,
            )
            stopController.abort()
          },
          async sendText() {},
          async registerCommands(commands) {
            registeredCommands.push(commands.map((command) => {
              return { name: command.name }
            }))

            return commands.length
          },
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
    assert.equal(registeredCommands.length, 1)
    assert.deepEqual(
      registeredCommands[0]?.map((command) => {
        return command.name
      }),
      ['araya', 'hoot'],
    )
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 会話 session 初期化に失敗すると会話利用不可を返し、slash command には session 未開を返す', async () => {
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
            await handlers.onInteraction?.(
              {
                interactionId: 'interaction-status',
                commandName: 'araya',
                userId: USER_ID,
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                subcommandGroup: null,
                subcommand: 'status',
                options: {},
              },
              captureChatReply,
            )
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
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
    assert.equal(typeof interactionHandlerSeen, 'function', 'bot は slash command handler を gateway に渡す')
    assert.ok(
      chatReplies.some((content) => {
        return content.includes('会話 session は開けていません')
      }),
      'agent session が無いことは /araya status に書く',
    )
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

            // 撤去応答は production の routeSlashCommandInteraction -> bot の handler をそのまま通す
            assert.equal(typeof handlers.onInteraction, 'function', 'bot は slash command handler を gateway に渡す')

            for (const subcommand of ['submit', 'cancel', 'retry', 'list', 'show']) {
              await routeSlashCommandInteraction(
                makeRemovedCommandInteraction(subcommand, (content, ephemeral) => {
                  assert.equal(ephemeral, true, '撤去案内は ephemeral で返す')
                  replies.push(content)
                }) as unknown as Parameters<typeof routeSlashCommandInteraction>[0],
                handlers,
              )
            }

            // handler を渡さない古い gateway 配線でも撤去案内は返る
            await routeSlashCommandInteraction(
              makeRemovedCommandInteraction('spawn', (content) => {
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
            stopController.abort()
          },
          sendText: async () => {},
          async registerCommands() {
            return 2
          },
          close: async () => {},
        }
      },
      log(entry) {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(replies.length, 6)

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
          describe: () => {
            return { conversationId: 2 }
          },
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
          async registerCommands() {
            return 2
          },
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
          describe: () => {
            return { conversationId: 3 }
          },
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
          async registerCommands() {
            return 2
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

test('discord bot: CLI で承認した HOOT dispatch を main 会話 session に inject し、notice と answer を channel に返す', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-inject-test-')),
  )
  const stopController = new AbortController()
  const submissions: { content: string; requestId: string }[] = []
  const notices: { content: string; nonce: string }[] = []
  const logs: Record<string, unknown>[] = []
  const hootPrompts: string[] = []

  try {
    // CLI（araya hoot dispatch --key）が state に書いた承認を、bot process の loop が拾う
    await setGoal(dataDir, {
      key: 'github-scan',
      objective: 'open issue と draft PR を拾う',
      scope: ['github:koh110/araya'],
    })
    await updateSettings(dataDir, { enabled: true, tickMinutes: 5, mode: 'active' })

    const proposalKey = proposalKeyOf({ goalKeys: ['github-scan'], decision: 'dispatch' })
    await upsertProposal(dataDir, {
      key: proposalKey,
      decision: 'dispatch',
      goalKeys: ['github-scan'],
      reason: 'draft PR 1 件を続行すべきか判断したい',
      occurrenceKey: 'hoot:2026-11-19T08:00:00.000Z',
      nowMs: Date.parse('2026-11-19T08:00:00.000Z'),
    })
    const queued = await enqueueHootInject(dataDir, {
      proposalKey,
      authorizedBy: 'human',
      nowMs: Date.parse('2026-11-19T08:00:00.000Z'),
    })
    assert.equal(queued.skipped, null)
    assert.notEqual(queued.request, null)

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
      hootRunCommand: async () => ({
        exitCode: 0,
        signal: null,
        stdout: '[]',
        stderr: '',
        stdoutBytes: 2,
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }),
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 4 }
          },
          async submit(content, requestId) {
            submissions.push({ content, requestId })

            return 'HOOT 案件を進めました'
          },
          async reset() {},
          async close() {},
          async hootDecide(request) {
            hootPrompts.push(request.prompt)

            return {
              text: 'HOOT 判断:\nDECISION: wait\nREASON: 次に 1 件進める',
              conversationId: 43,
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
                messageId: 'chat-message-inject',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'human message',
              },
              async () => {}
            )

            const deadline = Date.now() + 8_000

            while (
              !submissions.some((entry) => {
                return entry.requestId.startsWith('hoot-inject:')
              }) && Date.now() < deadline
            ) {
              await new Promise((resolve) => {
                setTimeout(resolve, 50)
              })
            }

            stopController.abort()
          },
          async sendText(content, nonce) {
            notices.push({ content, nonce })
          },
          async registerCommands() {
            return 2
          },
          async close() {},
        }
      },
      log: (entry) => {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    const injectSubmission = submissions.find((entry) => {
      return entry.requestId.startsWith('hoot-inject:')
    })
    assert.notEqual(injectSubmission, undefined)
    assert.match(injectSubmission?.content ?? '', /open issue と draft PR を拾う/u)
    assert.match(injectSubmission?.content ?? '', new RegExp(`araya hoot dispatch --key ${proposalKey}`, 'u'))
    assert.match(injectSubmission?.content ?? '', /この承認では許可されていません/u)
    // 人間の message と inject が同じ main 会話 session を通る（submit 2 件）
    assert.equal(submissions.length, 2)
    // 人間に届くのは「何を自動化したか」の notice と main 会話の answer
    const injectNotice = notices.find((entry) => {
      return entry.content.includes('HOOT dispatch を main 会話に渡しました')
    })
    const injectAnswer = notices.find((entry) => {
      return entry.content === 'HOOT 案件を進めました'
    })
    assert.notEqual(injectNotice, undefined)
    assert.notEqual(injectAnswer, undefined)
    assert.notEqual(injectNotice?.nonce, injectAnswer?.nonce)
    assert.match(injectNotice?.content ?? '', /人間の承認/u)
    // inject だけでは model 判断 run は走らない（wait の判断が 1 件走るだけ）
    assert.equal(hootPrompts.length, 1)
    assert.match(JSON.stringify(logs), /"type":"hoot_inject_delivered"/u)

    const state = await readHootState(dataDir)
    assert.equal(state.injectRequests.length, 1)
    assert.equal(state.injectRequests[0]?.status, 'injected')
    assert.equal(state.injectRequests[0]?.attempts, 1)
    // autoDispatch=false なので判断 run から新しい request は増えていない
    assert.equal(state.runs[0]?.decision, 'wait')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: Discord の /hoot dispatch 承認を同じ process の poll が拾って main 会話に inject する', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-command-inject-test-')),
  )
  const stopController = new AbortController()
  const submissions: { content: string; requestId: string }[] = []
  const notices: { content: string; nonce: string }[] = []
  const logs: Record<string, unknown>[] = []

  try {
    await setGoal(dataDir, {
      key: 'github-scan',
      objective: 'open issue と draft PR を拾う',
      scope: ['github:koh110/araya'],
    })
    // autoDispatch は off（人間の承認だけで inject する）
    await updateSettings(dataDir, { enabled: true, tickMinutes: 5, mode: 'active' })

    const proposalKey = proposalKeyOf({ goalKeys: ['github-scan'], decision: 'dispatch' })
    await upsertProposal(dataDir, {
      key: proposalKey,
      decision: 'dispatch',
      goalKeys: ['github-scan'],
      reason: 'draft PR 1 件を続行すべきか判断したい',
      occurrenceKey: 'hoot:2026-11-20T08:00:00.000Z',
      nowMs: Date.parse('2026-11-20T08:00:00.000Z'),
    })
    assert.equal((await readHootState(dataDir)).injectRequests.length, 0)

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
      hootRunCommand: async () => ({
        exitCode: 0,
        signal: null,
        stdout: '[]',
        stderr: '',
        stdoutBytes: 2,
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }),
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 9 }
          },
          async submit(content, requestId) {
            submissions.push({ content, requestId })

            return 'HOOT 案件を進めました'
          },
          async reset() {},
          async close() {},
          async hootDecide() {
            return {
              text: 'HOOT 判断:\nDECISION: wait\nREASON: 次に 1 件進める',
              conversationId: 44,
            }
          },
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // 人間の承認は Discord の slash command から打つ（CLI を叩きに行かない）
            await routeSlashCommandInteraction(
              makeSlashInteraction(
                { commandName: 'hoot', subcommand: 'dispatch', options: [{ name: 'key', value: proposalKey }] },
                (content) => {
                  notices.push({ content, nonce: 'interaction-dispatch' })
                },
              ) as unknown as Parameters<typeof routeSlashCommandInteraction>[0],
              handlers,
            )
            await routeSlashCommandInteraction(
              makeSlashInteraction({ commandName: 'araya', subcommand: 'status' }, (content) => {
                notices.push({ content, nonce: 'interaction-status' })
              }) as unknown as Parameters<typeof routeSlashCommandInteraction>[0],
              handlers,
            )

            const deadline = Date.now() + 8_000

            while (
              !notices.some((entry) => {
                return entry.content.includes('HOOT 案件を進めました')
              }) && Date.now() < deadline
            ) {
              await new Promise((resolve) => {
                setTimeout(resolve, 50)
              })
            }

            stopController.abort()
          },
          async sendText(content, nonce) {
            notices.push({ content, nonce })
          },
          async registerCommands() {
            return 2
          },
          async close() {},
        }
      },
      log: (entry) => {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    const dump = JSON.stringify(logs)
    assert.match(dump, /"type":"discord_control_command"/u)
    assert.match(dump, /"type":"hoot_inject_delivered"/u)

    // 承認は state に human として残る
    const state = await readHootState(dataDir)
    assert.equal(state.injectRequests.length, 1)
    assert.equal(state.injectRequests[0]?.authorizedBy, 'human')
    assert.equal(state.injectRequests[0]?.status, 'injected')
    assert.equal(state.settings.autoDispatch, false)

    // control command は model に渡さず、inject だけが main 会話へ入る
    assert.equal(submissions.length, 1)
    const injectSubmission = submissions[0]
    assert.equal(injectSubmission?.requestId, `hoot-inject:${proposalKey}:1`)
    assert.match(injectSubmission?.content ?? '', /open issue と draft PR を拾う/u)
    assert.match(injectSubmission?.content ?? '', /破壊的な操作は、この承認では許可されていません/u)

    const replies = notices.map((entry) => {
      return entry.content
    })
    // 1: 承認の ack / 2: status 画面 / 3: inject notice / 4: main 会話の answer
    assert.match(replies.join('\n'), /inject request を作りました: hoot-inject:/u)
    assert.match(replies.join('\n'), /main conversation #9/u)
    assert.match(replies.join('\n'), /HOOT dispatch を main 会話に渡しました/u)
    assert.match(replies.join('\n'), /HOOT 案件を進めました/u)
    const noticeNonce = notices.find((entry) => {
      return entry.content.includes('HOOT dispatch を main 会話に渡しました')
    })?.nonce
    const answerNonce = notices.find((entry) => {
      return entry.content === 'HOOT 案件を進めました'
    })?.nonce
    assert.notEqual(noticeNonce, undefined)
    assert.notEqual(answerNonce, undefined)
    assert.notEqual(noticeNonce, answerNonce)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
