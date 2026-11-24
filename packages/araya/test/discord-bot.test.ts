import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { runDiscordBot, SHUTDOWN_BUDGET_TOTAL_MS } from '../src/discord/bot.ts'
import { discordUnitSections } from '../src/infrastructure/systemd.ts'
import { CHAT_SHUTDOWN_UNPROCESSED_REPLY } from '../src/discord/chat.ts'
import { OBSOLETE_COMMAND_REPLY, routeSlashCommandInteraction } from '../src/discord/gateway.ts'
import { newState, readDiscordBotState, writeDiscordBotState } from '../src/discord/state.ts'
import { BOT_STARTED_TEXT, RESTART_STARTED_TEXT } from '../src/discord/restart-notice.ts'
import { readHootState, enqueueHootInject, setGoal, updateSettings, upsertProposal } from '../src/hoot/store.ts'
import { controlRequestId, readControlResult, writeControlRequest } from '../src/infrastructure/control-bus.ts'

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

// 通知投稿の stub。bot テストが実 Discord REST へ行かないように共通で注入する
const noticeStubFetch = async () => ({ ok: true } as const)

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
    const lockLog: Record<string, unknown>[] = []
    const secondExitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      log: (entry: Record<string, unknown>) => {
        lockLog.push(entry)
      },
    })

    assert.equal(secondExitCode, 1)
    assert.equal(gatewayCreations, 0, '2つ目は gateway を作らずに終了する')
    // #37: 拒否した理由（生存 holder の PID と lock age）を log に残す
    const blocked = lockLog.filter((entry) => {
      return entry.type === 'discord_already_running'
    })
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0]?.lockReason, 'owner_alive')
    assert.equal(blocked[0]?.lockOwnerPid, child.pid)
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
      fetch: noticeStubFetch,
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

// 実測の deploy 事故（#36 / #37）の再現: unit が main process を exit させて cgroup ごと SIGKILL すると
// lock が残る。stale 30 s を待つと 20〜40 s 起動できないので、owner record で即回収できることを確かめる
test('discord bot: SIGKILL 後の残留 lock を stale 待ちなく起動直後に回収する', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-killed-lock-test-')),
  )
  const childScript = fileURLToPath(new URL('./support/discord-bot-process.mjs', import.meta.url))
  const child = spawn(process.execPath, [childScript, dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const entries: Record<string, unknown>[] = []

  try {
    assert.ok(child.stdout)
    const output = createInterface({ input: child.stdout })
    await once(output, 'line', { signal: AbortSignal.timeout(5_000) })

    child.kill('SIGKILL')
    await once(child, 'exit', { signal: AbortSignal.timeout(5_000) })

    // 死んだ holder は lock の refresh を止める。実測に合わせて mtime を 20 s 前に戻す（stale 30 s には届いていない）
    const lockPath = path.join(dataDir, '.discord-bot.lock')
    const backdated = new Date(Date.now() - 20_000)
    await fs.utimes(lockPath, backdated, backdated)

    const stopController = new AbortController()
    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      log: (entry: Record<string, unknown>) => {
        entries.push(entry)
      },
    })

    assert.equal(exitCode, 0, '残留 lock を回収して起動できる')
    const reclaimed = entries.filter((entry) => {
      return entry.type === 'discord_lock_reclaimed'
    })
    assert.equal(reclaimed.length, 1)
    assert.equal(reclaimed[0]?.ownerPid, child.pid)
    assert.equal(reclaimed[0]?.ownerStatus, 'dead')
    assert.equal(
      entries.some((entry) => {
        return entry.type === 'discord_already_running'
      }),
      false,
      'stale 待ちの起動失敗を挟まない',
    )
    // 回収した側が owner record を引き継ぎ、exit で消している
    await assert.rejects(fs.access(path.join(dataDir, '.discord-bot.lock-owner.json')), { code: 'ENOENT' })
    await assert.rejects(fs.access(path.join(dataDir, '.discord-bot.lock')), { code: 'ENOENT' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }

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
      fetch: noticeStubFetch,
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
      fetch: noticeStubFetch,
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
      fetch: noticeStubFetch,
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
  const drainLogs: Record<string, unknown>[] = []

  try {
    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      log: (entry: Record<string, unknown>) => {
        drainLogs.push(entry)
      },
    })

    await messageDone
    assert.equal(exitCode, 0)
    assert.deepEqual(replies, ['reply while connected'])
    assert.equal(replyAfterGatewayClose, false)
    assert.equal(gatewayClosed, true)
    // #36: drain が動いたことを log で確かめる（discord_stopped は clean 完了の時にだけ出る）
    const stopping = drainLogs.find((entry) => {
      return entry.type === 'discord_stopping'
    })
    assert.ok(stopping !== undefined, 'discord_stopping が残らない')
    // shutdown の瞬間に turn が完了した直後でもよいので、値の内訳より「記録されていること」を見る
    assert.equal(typeof stopping?.processing, 'number')
    assert.equal(typeof stopping?.queued, 'number')
    assert.equal(
      drainLogs.some((entry) => {
        return entry.type === 'discord_shutdown_timeout'
      }),
      false,
      'drain が budget 内に収まったのに timeout を出さない',
    )
    const stopped = drainLogs.find((entry) => {
      return entry.type === 'discord_stopped'
    })
    assert.ok(stopped !== undefined, 'discord_stopped が残らない')
    assert.equal(typeof stopped?.elapsedMs, 'number')
  } finally {
    releaseSubmit?.('cleanup')
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

// #36: drain に上限が無いと unit の TimeoutStopSec（30 s）を越えて SIGKILL され、残留 lock（#37）と
// 無受信窓を増やす。budget で打ち切って gateway / session を閉じ、取りこぼしを reply と log で示す
// ことを実際の hang で確かめる
test('discord bot: shutdown は drain budget で打ち切って gateway と session を閉じる', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-drain-budget-test-')),
  )
  const stopController = new AbortController()
  const drainMs = 300
  const logs: Record<string, unknown>[] = []
  const replies: { content: string; gatewayClosed: boolean }[] = []
  let gatewayClosed = false
  let sessionCloseCount = 0
  let firstSubmitStarted: (() => void) | undefined
  const submitStarted = new Promise<void>((resolve) => {
    firstSubmitStarted = resolve
  })

  try {
    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      shutdownWaits: { hootMs: 50, drainMs, gatewayMs: 300, sessionMs: 300 },
      createChatSession: async function createChatSession() {
        return {
          describe: () => {
            return { conversationId: 3 }
          },
          // 永遠に終わらない turn（実測の「実行中の turn を置き去りにする」状況）
          async submit() {
            firstSubmitStarted?.()

            return await new Promise<string>(() => {})
          },
          async reset() {},
          async close() {
            sessionCloseCount += 1
          },
        }
      },
      createGateway: async function createGateway(_config, handlers) {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            void handlers.onMessage(
              {
                messageId: 'stuck-turn-message',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'this turn never finishes',
              },
              async (content) => {
                replies.push({ content, gatewayClosed })
              },
            )
            await submitStarted
            // 実行中の turn の後ろで待っている message（shutdown で打ち切る側）
            void handlers.onMessage(
              {
                messageId: 'queued-message',
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                content: 'queued behind the stuck turn',
              },
              async (content) => {
                replies.push({ content, gatewayClosed })
              },
            )
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 40)
            })
            stopController.abort()
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
      log: (entry: Record<string, unknown>) => {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0, 'hang する turn を置き去りにしても shutdown は完了する')
    const stopping = logs.find((entry) => {
      return entry.type === 'discord_stopping'
    })
    assert.ok(stopping !== undefined)
    assert.equal(stopping?.processing, 1, '実行中の turn 数')
    assert.equal(stopping?.queued, 1, '実行待ちの message 数')

    const timeouts = logs.filter((entry) => {
      return entry.type === 'discord_shutdown_timeout'
    })
    assert.deepEqual(
      timeouts.map((entry) => {
        return entry.step
      }),
      ['chat_drain'],
      'drain だけを budget で打ち切る',
    )
    assert.equal(timeouts[0]?.budgetMs, drainMs)
    assert.equal(timeouts[0]?.queued, 1)

    const stopped = logs.find((entry) => {
      return entry.type === 'discord_stopped'
    })
    assert.ok(stopped !== undefined, 'budget 内なので discord_stopped は残る')
    assert.ok(Number(stopped?.elapsedMs) >= drainMs, 'drain budget だけは実際に待った')
    // 打ち切った message には gateway を閉じる前に「未処理」を返す（黙って捨てない）
    assert.deepEqual(
      replies.map((entry) => {
        return entry.content
      }),
      [CHAT_SHUTDOWN_UNPROCESSED_REPLY],
    )
    assert.deepEqual(
      replies.map((entry) => {
        return entry.gatewayClosed
      }),
      [false],
      'reply は gateway が生きている間に送った',
    )
    assert.equal(gatewayClosed, true)
    assert.equal(sessionCloseCount, 1)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

// shutdown budget は unit の TimeoutStopSec に収まっていなければならない（#36 と #37 の跨 file 不変条件）
test('discord bot: shutdown budget は unit の TimeoutStopSec 以内に収まる', () => {
  const sections = discordUnitSections({
    authMode: 'env-file',
    dataDir: '/tmp/araya-shutdown-budget-invariant',
    nodePath: '/usr/bin/node',
    botEntrypoint: '/usr/bin/node',
    envFilePath: '/tmp/araya-shutdown-budget-invariant/.env',
    environment: [],
  })
  const timeoutStopSec = Number(
    sections.service.find(([name]) => {
      return name === 'TimeoutStopSec'
    })?.[1] ?? '0',
  )

  assert.ok(timeoutStopSec > 0, 'unit に TimeoutStopSec がない')
  assert.ok(
    SHUTDOWN_BUDGET_TOTAL_MS < timeoutStopSec * 1_000,
    `shutdown budget ${SHUTDOWN_BUDGET_TOTAL_MS} ms が TimeoutStopSec ${timeoutStopSec} s を越えている`,
  )
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
      fetch: noticeStubFetch,
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
      cliControlPollMs: 40,
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
              conversationReads: { calls: 0, entries: 0, chars: 0 },
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
            // poll が state を拾うのを待つの実測待ち。8 s は CI load で届いたことがあり、余裕を持たせる
            const deadline = Date.now() + 20_000

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
    // fixture の now は実行時刻にする。過去の日付だと settings.proposalTTLHours（72 h）で bot の tick が
    // 先に open を closed（expired）へ変えて、dispatch が race に負ける（#36 の test 追加で CI load が上がって露見）
    const fixtureNowMs = Date.now()
    const fixtureOccurrenceKey = `hoot:${new Date(fixtureNowMs).toISOString()}`
    await upsertProposal(dataDir, {
      key: proposalKey,
      decision: 'dispatch',
      goalKeys: ['github-scan'],
      reason: 'draft PR 1 件を続行すべきか判断したい',
      occurrenceKey: fixtureOccurrenceKey,
      nowMs: fixtureNowMs,
    })
    const queued = await enqueueHootInject(dataDir, {
      proposalKey,
      authorizedBy: 'human',
      nowMs: fixtureNowMs,
    })
    assert.equal(queued.skipped, null)
    assert.notEqual(queued.request, null)

    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      cliControlPollMs: 40,
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
              conversationReads: { calls: 0, entries: 0, chars: 0 },
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

            // poll が state を拾うのを待つの実測待ち。8 s は CI load で届いたことがあり、余裕を持たせる
            const deadline = Date.now() + 20_000

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
    // 上の test と同じ理由で fixture の now は実行時刻（proposalTTLHours 切れで expired にならないため）
    const fixtureNowMs = Date.now()
    await upsertProposal(dataDir, {
      key: proposalKey,
      decision: 'dispatch',
      goalKeys: ['github-scan'],
      reason: 'draft PR 1 件を続行すべきか判断したい',
      occurrenceKey: `hoot:${new Date(fixtureNowMs).toISOString()}`,
      nowMs: fixtureNowMs,
    })
    assert.equal((await readHootState(dataDir)).injectRequests.length, 0)

    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      cliControlPollMs: 40,
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
              conversationReads: { calls: 0, entries: 0, chars: 0 },
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

            // poll が state を拾うのを待つの実測待ち。8 s は CI load で届いたことがあり、余裕を持たせる
            const deadline = Date.now() + 20_000

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

test('discord bot: gateway の onIgnored は discord_message_ignored を messageId と failures 付きで log に書く', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-ignored-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []

  try {
    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      sleep: async () => {},
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady('998877665544332211')
            handlers.onIgnored?.(
              {
                guildId: GUILD_ID,
                channelId: '62345678901234567',
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                messageId: '92345678901234621',
              },
              ['channel_mismatch'],
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
    const ignored = logs.filter((entry) => {
      return entry.type === 'discord_message_ignored'
    })
    assert.equal(ignored.length, 1)
    assert.equal(ignored[0]?.messageId, '92345678901234621')
    assert.deepEqual(ignored[0]?.failures, ['channel_mismatch'])
    assert.equal(ignored[0]?.userId, USER_ID)
    assert.equal(ignored[0]?.content, undefined, 'ignored entry に本文を含めない')
    assert.equal(JSON.stringify(logs).includes(BOT_TOKEN), false)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: discord.log の各行は ts timestamp を持つ', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-ts-test-')),
  )
  const stopController = new AbortController()

  try {
    // log を inject しない → production の fileLogger が dataDir/logs/discord.log へ書く
    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      sleep: async () => {},
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady('998877665544332211')
            stopController.abort()
          },
          sendText: async () => {},
          async registerCommands() {
            return 2
          },
          close: async () => {},
        }
      },
    })

    assert.equal(exitCode, 0)
    const raw = await fs.readFile(path.join(dataDir, 'logs', 'discord.log'), 'utf8')
    const entries = raw
      .trim()
      .split('\n')
      .filter((line) => {
        return line !== ''
      })
      .map((line) => JSON.parse(line))
    assert.ok(entries.length > 0, 'discord.log に entry が書かれている')

    for (const entry of entries) {
      assert.equal(typeof entry.ts, 'string')
      assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    }
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

// #36: 起動完了の通知。前回の ready があれば「再起動しました」、無ければ「起動しました」
test('discord bot: 前回の ready がある起動では 再起動しました 通知を指定 channel に投稿する', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-restart-notice-test-')),
  )
  const stopController = new AbortController()
  const notices: { url: string; init: Record<string, unknown> }[] = []
  const logs: Record<string, unknown>[] = []

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-22T00:00:00.000Z',
  })

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
            handlers.onReady('998877665544332211')
            stopController.abort()
          },
          sendText: async () => {},
          async registerCommands() {
            return 2
          },
          close: async () => {},
        }
      },
      fetch: async (url, init) => {
        notices.push({ url, init: init as Record<string, unknown> })

        return { ok: true }
      },
      log: (entry) => {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.url, `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`)
    assert.equal(JSON.parse(String(notices[0]?.init.body ?? '{}')).content, RESTART_STARTED_TEXT)
    const noticeLog = logs.find((entry) => {
      return entry.type === 'discord_restart_notice'
    })
    assert.ok(noticeLog !== undefined && noticeLog.ok === true, JSON.stringify(logs))
    // 通知 log に token を出さない
    assert.ok(!JSON.stringify(logs).includes(BOT_TOKEN))
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 前回の ready が無い最初の起動では 起動しました 通知を送る', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-first-start-test-')),
  )
  const stopController = new AbortController()
  const notices: { url: string; init: Record<string, unknown> }[] = []

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
            handlers.onReady('998877665544332211')
            stopController.abort()
          },
          sendText: async () => {},
          async registerCommands() {
            return 2
          },
          close: async () => {},
        }
      },
      fetch: async (url, init) => {
        notices.push({ url, init: init as Record<string, unknown> })

        return { ok: true }
      },
      log: () => {},
    })

    assert.equal(exitCode, 0)
    assert.equal(notices.length, 1)
    assert.equal(JSON.parse(String(notices[0]?.init.body ?? '{}')).content, BOT_STARTED_TEXT)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 通知投稿に失敗しても bot は継続し、失敗だけ log する', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-notice-fail-test-')),
  )
  const stopController = new AbortController()
  const notices: unknown[] = []
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
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady('998877665544332211')
            stopController.abort()
          },
          sendText: async () => {},
          async registerCommands() {
            return 2
          },
          close: async () => {},
        }
      },
      fetch: async (url) => {
        notices.push(url)

        return { ok: false }
      },
      log: (entry) => {
        logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(notices.length, 1)
    const noticeLog = logs.find((entry) => {
      return entry.type === 'discord_restart_notice'
    })
    assert.ok(noticeLog !== undefined && noticeLog.ok === false, JSON.stringify(logs))
    assert.ok(!JSON.stringify(logs).includes(BOT_TOKEN))
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: CLI の control request（araya reset）を startup 後の poll で実行して result を書く', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-cli-control-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  let resetCount = 0
  const createdAt = Date.now()
  const requestId = controlRequestId(createdAt, 'reset:bot-test')

  await writeControlRequest(dataDir, {
    version: 1,
    id: requestId,
    command: 'reset',
    source: 'cli',
    createdAt: new Date(createdAt).toISOString(),
  })

  try {
    const exitCode = await runDiscordBot({
      fetch: noticeStubFetch,
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
      cliControlPollMs: 40,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 4 }
          },
          async submit() {
            return '会話を続けています。'
          },
          async reset(sessionRequestId?: string) {
            resetCount += 1
            logs.push({ type: 'session_reset', requestId: sessionRequestId })
          },
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')

            // runControl は queue を通さないので、会話の投稿を待たずに reset が効く
            for (let index = 0; index < 100; index += 1) {
              if (await readControlResult(dataDir, requestId) !== null) {
                break
              }

              await new Promise((resolve) => {
                return setTimeout(resolve, 25)
              })
            }

            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 0
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    const result = await readControlResult(dataDir, requestId)
    assert.equal(result?.ok, true)
    assert.match(result?.output ?? '', /この channel の会話をリセットしました/)
    assert.equal(resetCount, 1)
    // reset の requestId は CLI の request id（同じ request を 2 回実行しないための識別子）
    assert.equal(logs.find((entry) => entry.type === 'session_reset')?.requestId, requestId)
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_cli_control_started'
      }),
    )
    const cliLog = logs.find((entry) => {
      return entry.type === 'discord_control_cli'
    })
    assert.equal(cliLog?.command, 'reset')
    // CLI 側の要求 file は claim 後に消える（残った request が後で実行されない）
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'control', 'requests')), [])
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

// #36: gateway が閉じていた窓に投稿された message は Discord が再配信しない。ready 後に history を読み、
// cursor より新しい物だけを会話へ流し込むことを bot の loop 経由で確かめる
const DISCORD_EPOCH_MS = 1_420_064_800_000

function snowflakeAge(ageMs: number) {
  return String((BigInt(Date.now() - ageMs - DISCORD_EPOCH_MS) << 22n) + 1n)
}

test('discord bot: 再起動の窓に投稿された message を ready 後に history から取り直す', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-backfill-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: { content: string; requestId: string }[] = []
  const cursorId = snowflakeAge(60_000)
  const windowId = snowflakeAge(20_000)
  const beforeCursorId = snowflakeAge(90_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-22T00:00:00.000Z',
    lastSeenMessageId: cursorId,
  })

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
      createChatSession: async () => {
        return {
          async submit(content: string, requestId: string) {
            submits.push({ content, requestId })

            return '取り直しました'
          },
          describe: () => {
            return { conversationId: 1 }
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady('998877665544332211')
            // backfill の fetch と queue 処理が走ってから shutdown に入る
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            stopController.abort()
          },
          sendText: async () => {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [
              {
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                messageId: windowId,
                content: '再起動中に出ていた message',
              },
              {
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: USER_ID,
                isBot: false,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                messageId: beforeCursorId,
                content: 'cursor より古い message',
              },
            ]
          },
          close: async () => {},
        }
      },
      fetch: noticeStubFetch,
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(submits.length, 1, JSON.stringify(logs))
    assert.equal(submits[0]?.requestId, windowId)
    assert.match(submits[0]?.content ?? '', /再起動中に出ていた message/)

    const received = logs.find((entry) => {
      return entry.type === 'discord_backfill_received'
    })

    assert.ok(received !== undefined, JSON.stringify(logs))
    assert.equal(received.messageId, windowId)
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_backfill' && entry.handled === 1
      }),
    )

    // cursor は取り直した message まで進み、cursor 以下の物は再処理しない
    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, windowId)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
