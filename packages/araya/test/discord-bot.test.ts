import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { runDiscordBot, SHUTDOWN_BUDGET_TOTAL_MS } from '../src/discord/bot.ts'
import { discordUnitSections } from '../src/infrastructure/systemd.ts'
import { CHAT_SHUTDOWN_UNPROCESSED_REPLY, CHAT_UNAVAILABLE_REPLY } from '../src/discord/chat.ts'
import { OBSOLETE_COMMAND_REPLY, routeSlashCommandInteraction } from '../src/discord/gateway.ts'
import { newState, readDiscordBotState, writeDiscordBotState } from '../src/discord/state.ts'
import { BOT_STARTED_TEXT, RESTART_STARTED_TEXT } from '../src/discord/restart-notice.ts'
import {
  readHootState,
  enqueueHootInject,
  setGoal,
  updateSettings,
  upsertProposal,
} from '../src/hoot/store.ts'
import {
  controlRequestId,
  readControlResult,
  writeControlRequest,
} from '../src/infrastructure/control-bus.ts'

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
const noticeStubFetch = async () => ({ ok: true }) as const

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

// #13 の受け入れ検証で <dataDir>/logs/discord.log は 0664 だった（fs.appendFileSync は file を作る mode を
// 決めず、既存 file の mode はそのまま残る）。bot は起動時に logs を 0700・discord.log を 0600 に整えてから
// append することを実側で固定する（mode 以外の挙動・既存の log 本文は変えない）
test('discord bot: 0664 の既存 discord.log を 0600 に整えて追記し、logs dir を 0700 にする', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-log-mode-test-')),
  )
  const logsDir = path.join(dataDir, 'logs')
  const logFile = path.join(logsDir, 'discord.log')
  const stopController = new AbortController()

  await fs.mkdir(logsDir, { mode: 0o755 })
  await fs.writeFile(logFile, 'previous run line\n', 'utf8')
  await fs.chmod(logFile, 0o664)

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
    })

    assert.equal(exitCode, 0)
    assert.equal((await fs.stat(logsDir)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600)

    const lines = (await fs.readFile(logFile, 'utf8'))
      .split('\n')
      .filter((line) => {
        return line !== ''
      })
    // 既存の log を空にしない（mode だけ整える）
    assert.equal(lines[0], 'previous run line')
    const types = lines.slice(1).map((line) => {
      return (JSON.parse(line) as { type?: string }).type
    })

    assert.ok(types.includes('discord_started'), types.join(','))
    // mode を整えられたので診断は出ない
    assert.ok(!types.includes('discord_log_mode_failed'), types.join(','))
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
    await assert.rejects(fs.access(path.join(dataDir, '.discord-bot.lock-owner.json')), {
      code: 'ENOENT',
    })
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
            registeredCommands.push(
              commands.map((command) => {
                return { name: command.name }
              }),
            )

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
    assert.equal(
      typeof interactionHandlerSeen,
      'function',
      'bot は slash command handler を gateway に渡す',
    )
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
            assert.equal(
              typeof handlers.onInteraction,
              'function',
              'bot は slash command handler を gateway に渡す',
            )

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
// message を受信できない時間を増やす。budget で打ち切って gateway / session を閉じ、取りこぼしを reply と log で示す
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
              async () => {},
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
              async () => {},
            )

            // poll が state を拾うのを待つの実測待ち。8 s は CI load で届いたことがあり、余裕を持たせる
            const deadline = Date.now() + 20_000

            while (
              !submissions.some((entry) => {
                return entry.requestId.startsWith('hoot-inject:')
              }) &&
              Date.now() < deadline
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
    assert.match(
      injectSubmission?.content ?? '',
      new RegExp(`araya hoot dispatch --key ${proposalKey}`, 'u'),
    )
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
                {
                  commandName: 'hoot',
                  subcommand: 'dispatch',
                  options: [{ name: 'key', value: proposalKey }],
                },
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
              }) &&
              Date.now() < deadline
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
              if ((await readControlResult(dataDir, requestId)) !== null) {
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

// #36: gateway が閉じている間に投稿された message は Discord が再配信しない。ready 後に history を読み、
// cursor より新しい物だけを会話へ流し込むことを bot の loop 経由で確かめる
const DISCORD_EPOCH_MS = 1_420_070_400_000

function snowflakeAge(ageMs: number) {
  return String((BigInt(Date.now() - ageMs - DISCORD_EPOCH_MS) << 22n) + 1n)
}

test('discord bot: 再起動中に投稿された message を ready 後に history から取り直す', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-backfill-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: { content: string; requestId: string }[] = []
  const cursorId = snowflakeAge(60_000)
  const duringStopId = snowflakeAge(20_000)
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
                messageId: duringStopId,
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
    assert.equal(submits[0]?.requestId, duringStopId)
    assert.match(submits[0]?.content ?? '', /再起動中に出ていた message/)

    const received = logs.find((entry) => {
      return entry.type === 'discord_backfill_received'
    })

    assert.ok(received !== undefined, JSON.stringify(logs))
    assert.equal(received.messageId, duringStopId)
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_backfill' && entry.handled === 1
      }),
    )

    // cursor は取り直した message まで進み、cursor 以下の物は再処理しない
    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, duringStopId)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

// gateway の live messageCreate と history fetch に同じ形の情報を与える（backfill は同じ admission gate を通す）
function liveChatMessage(messageId: string, content: string) {
  return {
    messageId,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    isBot: false,
    isWebhook: false,
    isSystem: false,
    mentionsBot: false,
    content,
  }
}

test('discord bot: drain で置き去りにした message は cursor を進めず、restart 後の backfill が取り直す', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-atleast-once-test-')),
  )
  const seedCursor = snowflakeAge(200_000)
  const doneId = snowflakeAge(120_000)
  const stuckId = snowflakeAge(90_000)
  const queuedId = snowflakeAge(60_000)
  const drainMs = 300
  const firstLogs: Record<string, unknown>[] = []
  const firstReplies: { content: string; gatewayClosed: boolean }[] = []
  const firstStop = new AbortController()
  const secondStop = new AbortController()
  let stuckStarted: (() => void) | undefined
  const stuck = new Promise<void>((resolve) => {
    stuckStarted = resolve
  })

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: seedCursor,
  })

  try {
    const firstExitCode = await runDiscordBot({
      fetch: noticeStubFetch,
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: firstStop.signal,
      verifyUnit: false,
      shutdownWaits: { hootMs: 50, drainMs, gatewayMs: 300, sessionMs: 300 },
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            if (requestId === stuckId) {
              stuckStarted?.()

              // 終わらない turn（drain budget で置き去りにされる）
              return await new Promise<string>(() => {})
            }

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // 先に完了する turn は cursor を前に進める
            await handlers.onMessage(liveChatMessage(doneId, '完了する turn'), async (content) => {
              firstReplies.push({ content, gatewayClosed: false })
            })
            void handlers.onMessage(
              liveChatMessage(stuckId, '終わらない turn'),
              async (content) => {
                firstReplies.push({ content, gatewayClosed: false })
              },
            )
            await stuck
            // stuck の後ろで待って shutdown で打ち切られる message
            void handlers.onMessage(
              liveChatMessage(queuedId, '打ち切られる message'),
              async (content) => {
                firstReplies.push({ content, gatewayClosed: false })
              },
            )
            await new Promise((resolve) => {
              setTimeout(resolve, 60)
            })
            firstStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async close() {},
        }
      },
      log: (entry) => {
        return firstLogs.push(entry)
      },
    })

    assert.equal(firstExitCode, 0)

    const timeout = firstLogs.find((entry) => {
      return entry.type === 'discord_shutdown_timeout' && entry.step === 'chat_drain'
    })

    assert.ok(timeout !== undefined, JSON.stringify(firstLogs))
    assert.equal(timeout.processing, 1, '実行中に置き去りにした turn')

    const unfinished = firstLogs.find((entry) => {
      return entry.type === 'discord_shutdown_unfinished'
    })

    assert.ok(unfinished !== undefined, JSON.stringify(firstLogs))
    assert.deepEqual(
      unfinished.messageIds,
      [stuckId, queuedId],
      '置き去りにした ids は cursor より古いまま残る',
    )
    assert.equal(unfinished.cursor, doneId, 'cursor は完了した turn までしか進まない')

    const stateAfterFirst = readDiscordBotState(dataDir)

    assert.ok(stateAfterFirst !== null)
    assert.equal(stateAfterFirst.lastSeenMessageId, doneId)
    assert.ok(
      firstReplies.some((entry) => {
        return entry.content === CHAT_SHUTDOWN_UNPROCESSED_REPLY
      }),
      '打ち切った message には未処理の通知を送る',
    )

    // 同じ dataDir で 2 つ目の process を起動し、history から取り直すことを確かめる
    const secondLogs: Record<string, unknown>[] = []
    const submits: { content: string; requestId: string }[] = []

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
      stopSignal: secondStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push({ content, requestId })

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // backfill の queue が終わってから shutdown
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            secondStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            // gateway の history は新しい順
            return [
              liveChatMessage(queuedId, '打ち切られる message'),
              liveChatMessage(stuckId, '終わらない turn'),
              liveChatMessage(doneId, '完了する turn'),
            ]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return secondLogs.push(entry)
      },
    })

    assert.equal(secondExitCode, 0)
    assert.deepEqual(
      submits.map((entry) => entry.requestId),
      [stuckId, queuedId],
      'cursor より新しい打ち切り分だけを古い順に取り直す（完了済みは再処理しない）',
    )
    assert.ok(
      secondLogs.some((entry) => {
        return entry.type === 'discord_backfill' && entry.handled === 2
      }),
      JSON.stringify(secondLogs),
    )

    const stateAfterSecond = readDiscordBotState(dataDir)

    assert.ok(stateAfterSecond !== null)
    assert.equal(stateAfterSecond.lastSeenMessageId, queuedId, '取り直した分だけ cursor が進む')
  } finally {
    firstStop.abort()
    secondStop.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: state.json の unfinished を restart 後に復元し、self message で cursor をその後ろへ進めない', async () => {
  // 2026-11-24 の incident の入口。unfinished が memory 上にしか無い状態で、bot 自身の応答の echo が
  // discard 経路を通り、cursor が unfinished 3 件より後ろへ進んで恒久的に処理されなかった。
  // 同じ dataDir から unfinished を復元した bot が同じ経路で cursor を越えないことを測る
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-unfinished-restore-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const seedCursor = snowflakeAge(200_000)
  const unfinishedId = snowflakeAge(90_000)
  const selfEchoId = snowflakeAge(10_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: seedCursor,
    unfinishedMessageIds: [unfinishedId],
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
      sleep: async () => {},
      createChatSession: createInertChatSession,
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // unfinished より新しい bot 自身の message（応答の echo）。discard 経路で cursor を進めようとする
            handlers.onIgnored?.(
              {
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
                userId: '998877665544332211',
                isBot: true,
                isWebhook: false,
                isSystem: false,
                mentionsBot: false,
                messageId: selfEchoId,
              },
              ['is_bot'],
            )
            await new Promise((resolve) => {
              setTimeout(resolve, 100)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          // unfinished な message は history の fetch 範囲外（削除された・100 件より古い）
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)

    const restored = logs.find((entry) => {
      return entry.type === 'discord_unfinished_restored'
    })

    assert.ok(restored !== undefined, JSON.stringify(logs))
    assert.equal(restored.count, 1)
    assert.deepEqual(restored.messageIds, [unfinishedId])
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_message_ignored' && entry.messageId === selfEchoId
      }),
      JSON.stringify(logs),
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, seedCursor, 'unfinished より後ろへ cursor を進めない')
    assert.deepEqual(state.unfinishedMessageIds, [unfinishedId], 'unfinished は state.json に残す')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 15 分以上前に受理した unfinished を restart 後の backfill が取り直す（2026-11-24 incident）', async () => {
  // incident で処理されなかった message の age は cursor から 1554 ms 分以上離れていた。
  // 受理済みで turn が終わっていない id は age 上限を見ないことを、process をまたいで測る
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-old-unfinished-test-')),
  )
  const seedCursor = snowflakeAge(4 * 60 * 60_000)
  const stuckId = snowflakeAge(3 * 60 * 60_000)
  const firstStop = new AbortController()
  const secondStop = new AbortController()
  const firstLogs: Record<string, unknown>[] = []
  const secondLogs: Record<string, unknown>[] = []
  const submits: { content: string; requestId: string }[] = []
  let stuckStarted: (() => void) | undefined
  const stuck = new Promise<void>((resolve) => {
    stuckStarted = resolve
  })

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: seedCursor,
  })

  try {
    const firstExitCode = await runDiscordBot({
      fetch: noticeStubFetch,
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: firstStop.signal,
      verifyUnit: false,
      shutdownWaits: { hootMs: 50, drainMs: 300, gatewayMs: 300, sessionMs: 300 },
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            if (requestId === stuckId) {
              stuckStarted?.()

              return await new Promise<string>(() => {})
            }

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // 3 時間前に投稿された message が live で届いて turn が終わらない
            void handlers.onMessage(liveChatMessage(stuckId, '終わらない turn'), async () => {})
            await stuck
            await new Promise((resolve) => {
              setTimeout(resolve, 60)
            })
            firstStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return firstLogs.push(entry)
      },
    })

    assert.equal(firstExitCode, 0)

    const unfinished = firstLogs.find((entry) => {
      return entry.type === 'discord_shutdown_unfinished'
    })

    assert.ok(unfinished !== undefined, JSON.stringify(firstLogs))
    assert.deepEqual(unfinished.messageIds, [stuckId])

    const stateAfterFirst = readDiscordBotState(dataDir)

    assert.ok(stateAfterFirst !== null)
    assert.equal(stateAfterFirst.lastSeenMessageId, seedCursor)
    assert.deepEqual(
      stateAfterFirst.unfinishedMessageIds,
      [stuckId],
      '置き去りにした ids は state.json に保存する',
    )

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
      stopSignal: secondStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push({ content, requestId })

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            secondStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [liveChatMessage(stuckId, '終わらない turn')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return secondLogs.push(entry)
      },
    })

    assert.equal(secondExitCode, 0)
    assert.deepEqual(
      submits.map((entry) => entry.requestId),
      [stuckId],
      'age 上限（15 分）を大きく越えていても取り直す',
    )
    assert.ok(
      !secondLogs.some((entry) => {
        return entry.type === 'discord_backfill_ignored' && entry.messageId === stuckId
      }),
      JSON.stringify(secondLogs),
    )

    const restored = secondLogs.find((entry) => {
      return entry.type === 'discord_unfinished_restored'
    })

    assert.ok(restored !== undefined, JSON.stringify(secondLogs))
    assert.deepEqual(restored.messageIds, [stuckId])

    const received = secondLogs.find((entry) => {
      return entry.type === 'discord_backfill_received'
    })

    assert.ok(received !== undefined, JSON.stringify(secondLogs))
    assert.ok(
      (received.ageMs as number) > 3 * 60 * 60_000,
      `ageMs=${String(received.ageMs)}（incident の stale と同じ条件）`,
    )

    const stateAfterSecond = readDiscordBotState(dataDir)

    assert.ok(stateAfterSecond !== null)
    assert.equal(stateAfterSecond.lastSeenMessageId, stuckId)
    assert.deepEqual(stateAfterSecond.unfinishedMessageIds, [], '取り直した unfinished は state から出す')
  } finally {
    firstStop.abort()
    secondStop.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 応答を送った message を restart 後の backfill で二度処理しない（nonce ではなく answeredMessageIds で止める）', async () => {
  // 応答を送った message でも、より古い unfinished のせいで cursor が届いていないことがある。
  // Discord が同じ author + 同じ nonce を 1 通にまとめるのは過去数分のあいだだけ（discord-api-types の docs）
  // なので、restart が空いたケースは nonce では抑えられない。answeredMessageIds を state.json に保存して止める
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-answered-test-')),
  )
  const seedCursor = snowflakeAge(300_000)
  const unfinishedId = snowflakeAge(200_000)
  const answeredId = snowflakeAge(50_000)
  const firstStop = new AbortController()
  const secondStop = new AbortController()
  const firstLogs: Record<string, unknown>[] = []
  const secondLogs: Record<string, unknown>[] = []
  const submits: { content: string; requestId: string }[] = []

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: seedCursor,
    unfinishedMessageIds: [unfinishedId],
  })

  try {
    const firstExitCode = await runDiscordBot({
      fetch: noticeStubFetch,
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: firstStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push({ content, requestId })

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // turn は終わるが、より古い unfinished が cursor を止める
            await handlers.onMessage(liveChatMessage(answeredId, '完了する turn'), async () => {})
            await new Promise((resolve) => {
              setTimeout(resolve, 100)
            })
            firstStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return firstLogs.push(entry)
      },
    })

    assert.equal(firstExitCode, 0)
    assert.deepEqual(
      submits.map((entry) => entry.requestId),
      [answeredId],
      'live で 1 通応答している',
    )

    const stateAfterFirst = readDiscordBotState(dataDir)

    assert.ok(stateAfterFirst !== null)
    assert.equal(stateAfterFirst.lastSeenMessageId, seedCursor, 'unfinished が cursor を止める')
    assert.deepEqual(stateAfterFirst.unfinishedMessageIds, [unfinishedId])
    assert.deepEqual(
      stateAfterFirst.answeredMessageIds,
      [answeredId],
      '応答を送った事実を state.json に保存する',
    )

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
      stopSignal: secondStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push({ content, requestId })

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            secondStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            // gateway の history は新しい順（応答済みの message が unfinished より新しい側に残っている）
            return [liveChatMessage(answeredId, '完了する turn'), liveChatMessage(unfinishedId, '終わらない turn')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return secondLogs.push(entry)
      },
    })

    assert.equal(secondExitCode, 0)
    assert.deepEqual(
      submits.map((entry) => entry.requestId),
      [answeredId, unfinishedId],
      '取り直すのは unfinished だけ（応答済み message は再応答しない）',
    )
    assert.ok(
      secondLogs.some((entry) => {
        return entry.type === 'discord_backfill_ignored' && entry.reason === 'already_handled' && entry.messageId === answeredId
      }),
      JSON.stringify(secondLogs),
    )

    const stateAfterSecond = readDiscordBotState(dataDir)

    assert.ok(stateAfterSecond !== null)
    assert.equal(stateAfterSecond.lastSeenMessageId, unfinishedId, '取り直した unfinished まで cursor が進む')
    assert.deepEqual(stateAfterSecond.unfinishedMessageIds, [])
    assert.deepEqual(
      stateAfterSecond.answeredMessageIds,
      [answeredId],
      'cursor が届いていない answered は記録に残す',
    )
  } finally {
    firstStop.abort()
    secondStop.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: live で処理中の message を backfill は reason:"live_processing" で飛ばす（live と backfill の排他）', async () => {
  // ready 直後に live で受信した message は backfill の history にも出てくる。backfill がそこに turn を
  // 走らせると応答が二重になる。live gate は「受理した事実」ではなく「実行中」なので、discord.log の
  // reason でどちらで止まったか確かめる（受理の事実だけで飛ばすと unfinished が取り直せなくなる）
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-live-processing-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const replies: string[] = []
  const cursor = snowflakeAge(60_000)
  const liveId = snowflakeAge(20_000)
  let releaseHistory: () => void = () => {}
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve
  })
  let releaseSubmit: () => void = () => {}
  const submitGate = new Promise<void>((resolve) => {
    releaseSubmit = resolve
  })

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)
            // live の turn を実行中に保つ（backfill の history fetch より先に終わらせない）
            await submitGate

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            void handlers.onMessage(liveChatMessage(liveId, 'live で処理中'), async (content) => {
              replies.push(content)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 60)
            })
            // live が受理して turn が動いた後に history を返す（同じ id が backfill 側にも出る状態）
            releaseHistory()
            await new Promise((resolve) => {
              setTimeout(resolve, 150)
            })
            releaseSubmit()
            await new Promise((resolve) => {
              setTimeout(resolve, 150)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            await historyGate

            return [liveChatMessage(liveId, 'live で処理中')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submits, [liveId], 'live の turn だけ走る（backfill は同じ id に turn を走らせない）')
    assert.equal(replies.length, 1, '応答は 1 通')
    assert.ok(
      logs.some(
        (entry) =>
          entry.type === 'discord_backfill_ignored' && entry.messageId === liveId && entry.reason === 'live_processing',
      ),
      JSON.stringify(logs),
    )
    assert.equal(
      logs.some(
        (entry) =>
          entry.type === 'discord_backfill_ignored' && entry.messageId === liveId && entry.reason === 'already_handled',
      ),
      false,
      '受理した事実だけでは飛ばさない（実行中であることを理由にする）',
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, liveId, 'turn が終わってから cursor が進む')
    assert.deepEqual(state.unfinishedMessageIds, [])
    assert.deepEqual(
      state.answeredMessageIds,
      [],
      'cursor が越えた answered 記録は prune される（backfill は cursor より古い id を取り直さない）',
    )
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 会話機能不可の案内だけ送った message は answered に記録せず、cursor が届いていなければ restart 後に再処理する', async () => {
  // CHAT_UNAVAILABLE_REPLY は「会話機能を走らせなかった」という送信結果。これを answered にすると notice が
  // 届いたかどうかで再応答を止めることになる（2026-11-24 の incident では self notice 自体が
  // discord_chat_reply_failed で Discord に届いていない）。turn を終えた id は unfinished から出すので、
  // cursor がその id を越えた場合は取り直さない（恒久的な stop を防ぐ）
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-notice-only-test-')),
  )
  const seedCursor = snowflakeAge(400_000)
  const unfinishedId = snowflakeAge(300_000)
  const noticeId = snowflakeAge(100_000)
  const firstStop = new AbortController()
  const secondStop = new AbortController()
  const firstLogs: Record<string, unknown>[] = []
  const secondLogs: Record<string, unknown>[] = []
  const firstReplies: string[] = []
  const submits: string[] = []

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: seedCursor,
    unfinishedMessageIds: [unfinishedId],
  })

  try {
    const firstExitCode = await runDiscordBot({
      fetch: noticeStubFetch,
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: firstStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        throw new Error('synthetic chat session failure')
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await handlers.onMessage(liveChatMessage(noticeId, '案内だけ送られる message'), async (content) => {
              firstReplies.push(content)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 120)
            })
            firstStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return firstLogs.push(entry)
      },
    })

    assert.equal(firstExitCode, 0)
    assert.ok(
      firstReplies.includes(CHAT_UNAVAILABLE_REPLY),
      JSON.stringify(firstReplies),
    )

    const stateAfterFirst = readDiscordBotState(dataDir)

    assert.ok(stateAfterFirst !== null)
    assert.deepEqual(
      stateAfterFirst.answeredMessageIds,
      [],
      '案内だけ送った id を応答済みとして記録しない',
    )
    assert.deepEqual(
      stateAfterFirst.unfinishedMessageIds,
      [unfinishedId],
      '案内だけ送った id は turn を終えているので unfinished には残さない（cursor が止まり続けるのを防ぐ）',
    )
    assert.equal(stateAfterFirst.lastSeenMessageId, seedCursor, 'より古い unfinished が cursor を止める')

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
      stopSignal: secondStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push(requestId)

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            secondStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [liveChatMessage(noticeId, '案内だけ送られた message'), liveChatMessage(unfinishedId, '置き去り')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return secondLogs.push(entry)
      },
    })

    assert.equal(secondExitCode, 0)
    assert.deepEqual(
      submits,
      [unfinishedId, noticeId],
      '案内だけ送った message は cursor が届いていれば restart 後に再処理する',
    )
    assert.equal(
      secondLogs.some(
        (entry) =>
          entry.type === 'discord_backfill_ignored' && entry.messageId === noticeId && entry.reason === 'already_handled',
      ),
      false,
      JSON.stringify(secondLogs),
    )
  } finally {
    firstStop.abort()
    secondStop.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: state.json で unfinished と answered 両方に載った id は unfinished を優先して取り直す', async () => {
  // 案内だけ送った id が answered に混ざった state file でも取り直されること（unfinished 側が優先）。
  // Discord が同じ author + 同じ nonce を 1 通にまとめるのは過去数分のあいだだけなので、 answered 記録が
  // unfinished より強いと処理されないまま残る
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-unfinished-wins-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const seedCursor = snowflakeAge(300_000)
  const replayId = snowflakeAge(100_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: seedCursor,
    unfinishedMessageIds: [replayId],
    answeredMessageIds: [replayId],
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push(requestId)

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [liveChatMessage(replayId, 'unfinished として取り直す message')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submits, [replayId])
    assert.equal(
      logs.some(
        (entry) =>
          entry.type === 'discord_backfill_ignored' && entry.messageId === replayId && entry.reason === 'already_handled',
      ),
      false,
      JSON.stringify(logs),
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.deepEqual(state.unfinishedMessageIds, [])
    assert.equal(state.lastSeenMessageId, replayId)
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: state.json の unfinished が cursor より古い側にあっても backfill が取り直す（cursor は戻さない）', async () => {
  // cursor の invariant が壊れた state file（cursor gate 以前に書かれた・手で編集した）。cursor を後ろへ
  // 戻して history を続けると cursor より新しい message も再処理して応答が重複するので、cursor はそのまま
  // unfinished の id だけ取り直す。saveDiscordState の prune で unfinished を消さないこともここで確かめる
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-unfinished-behind-cursor-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const cursor = snowflakeAge(100_000)
  const behindId = snowflakeAge(300_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [behindId],
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push(requestId)

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [liveChatMessage(behindId, 'cursor より古い unfinished')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    const restored = logs.find((entry) => {
      return entry.type === 'discord_unfinished_restored'
    })

    assert.ok(restored !== undefined, JSON.stringify(logs))
    assert.equal(restored.behindCursor, 1, 'cursor より古い unfinished であることを log に出す')
    assert.deepEqual(submits, [behindId], 'unfinished の id だけ取り直す')

    const backfillSummary = logs.find((entry) => {
      return entry.type === 'discord_backfill'
    })

    assert.ok(backfillSummary !== undefined, JSON.stringify(logs))
    assert.equal(backfillSummary.cursor, cursor)
    assert.equal(backfillSummary.cursorAfter, cursor, 'cursor を後ろへ戻さない')

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, cursor)
    assert.deepEqual(state.unfinishedMessageIds, [], '取り直しを終えた unfinished は消える（次回もう取り直さない）')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 同じ message id を 2 度受け取っても会話は 1 回だけ（Discord の echo・重複 delivery）', async () => {
  // Discord が同じ message を 2 度配信する case（echo・再接続後の再 delivery）で、live 側が同じ id に
  // 2 度 turn を走らせないこと。noteLiveMessageReceived は message ごとに state を書くので、同じ id が
  // state file の集合に 2 度載ることもない（Set 側で畳む）
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-duplicate-delivery-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const replies: string[] = []
  const cursor = snowflakeAge(60_000)
  const echoId = snowflakeAge(20_000)
  let releaseSubmit: () => void = () => {}
  const submitGate = new Promise<void>((resolve) => {
    releaseSubmit = resolve
  })

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push(`${requestId}:${content}`)
            // 1 度目の turn を実行中に保つ（同じ id の 2 度目が処理中に届く）
            await submitGate

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // 1 度目の delivery。turn を実行中に 2 度目が届く（処理中であることを理由に飛ばす）
            void handlers.onMessage(liveChatMessage(echoId, 'echo 1 度目'), async (content) => {
              replies.push(content)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 80)
            })
            void handlers.onMessage(liveChatMessage(echoId, 'echo 2 度目'), async (content) => {
              replies.push(content)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 80)
            })
            releaseSubmit()
            await new Promise((resolve) => {
              setTimeout(resolve, 120)
            })
            // turn が終わった後にも echo が届く（処理済みであることを理由に飛ばす）
            void handlers.onMessage(liveChatMessage(echoId, 'echo 3 度目'), async (content) => {
              replies.push(content)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 80)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(submits.length, 1, '会話は 1 回だけ走る')
    assert.ok(submits[0]!.startsWith(`${echoId}:`), JSON.stringify(submits))
    assert.equal(replies.length, 1, '応答は 1 通')

    const duplicates = logs.filter((entry) => {
      return entry.type === 'discord_chat_duplicate_skipped'
    })

    assert.equal(duplicates.length, 2, JSON.stringify(logs))
    assert.deepEqual(
      duplicates.map((entry) => {
        return entry.reason
      }),
      ['already_processing', 'already_processed'],
      '実行中と処理完了のどちらで止まったか log から読める',
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, echoId)
    assert.deepEqual(state.unfinishedMessageIds, [])

    const answered = state.answeredMessageIds ?? []

    assert.equal(
      new Set(answered).size,
      answered.length,
      '同じ id が集合に 2 度載らない',
    )
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: state.json が書けない状況でも受理済みの会話を止めない（discord_state_write_failed だけ出す）', async () => {
  // state file の書き込み失敗は observability の問題であって会話停止の理由ではない。noteLiveMessageReceived
  // も commitLiveMessageSeen も同じ saveDiscordState 経由なので、ここが失敗しても turn は走る
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-state-write-failed-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const replies: string[] = []
  const stateDir = path.join(dataDir, 'discord')
  const cursor = snowflakeAge(60_000)
  const messageId = snowflakeAge(20_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 120)
            })
            // ready での state 書き込みの後に directory を書き込み不可にする（以降の state 書き込みが失敗する）
            await fs.chmod(stateDir, 0o500)
            void handlers.onMessage(liveChatMessage(messageId, 'state が書けない状況'), async (content) => {
              replies.push(content)
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submits, [messageId], 'state が書けない事も会話停止の理由にしない')
    assert.equal(replies.length, 1, '応答は送れている')
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_state_write_failed'
      }),
      JSON.stringify(logs),
    )
  } finally {
    stopController.abort()
    await fs.chmod(stateDir, 0o700).catch(() => {})
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 処理を終えた id は state file に溜め続けらない（cursor が越えた unfinished / answered を prune する）', async () => {
  // 会話を実行して応答を送る message を 5 件連続で処理する。cursor が前に進むので、受理・応答の記録は
  // 1 件も残らない（unfinishedMessageIds / answeredMessageIds が restart ごとに膨れない）
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-id-prune-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const cursor = snowflakeAge(300_000)
  const messageIds: string[] = []

  for (let index = 0; index < 5; index += 1) {
    messageIds.push(snowflakeAge(200_000 - index * 10_000))
  }

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')

            for (const messageId of messageIds) {
              await handlers.onMessage(liveChatMessage(messageId, 'prune される id'), async () => {})
            }

            await new Promise((resolve) => {
              setTimeout(resolve, 150)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submits, messageIds, '5 件とも会話を走らせる')

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, messageIds[4], 'cursor が一番新しい id まで進む')
    assert.deepEqual(state.unfinishedMessageIds, [], 'turn を終えた id は unfinished に残らない')
    assert.deepEqual(
      state.answeredMessageIds,
      [],
      'cursor が越えた answered 記録は state file に溜めない（backfill は cursor より古い id を取り直さない）',
    )
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 取り直せない unfinished（history に届かず cursor が既に越えている）は落として log に出す', async () => {
  // cursor gate の無い build が書いた state の legacy unfinished かつ、history の fetch 範囲（新しい 100 件）の外（fetch は
  // 成功したが 0 件）という状態。unfinished に持ち続けると集合が膨れ続けて取り直し対象にもならないので、
  // state file から落とし、落とした事を discord_unfinished_pruned に出す
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-unfinished-prune-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const cursor = snowflakeAge(200_000)
  const legacyId = snowflakeAge(400_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [legacyId],
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit() {
            return 'unused'
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)

    const restored = logs.find((entry) => {
      return entry.type === 'discord_unfinished_restored'
    })

    assert.ok(restored !== undefined, JSON.stringify(logs))
    assert.equal(restored.behindCursor, 1)

    const pruned = logs.find((entry) => {
      return entry.type === 'discord_unfinished_pruned'
    })

    assert.ok(pruned !== undefined, '落とした unfinished を log に出す')
    assert.deepEqual(pruned.messageIds, [legacyId])
    assert.equal(pruned.cursor, cursor)

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, cursor, 'cursor を後ろへは戻さない')
    assert.deepEqual(state.unfinishedMessageIds, [], '取り直せない id を state file に溜めない')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: history fetch が失敗した起動では cursor より古い unfinished を落とさない（取り直せる可能性を残す）', async () => {
  // 上の prune は「取り直しを試みられた起動」だけが行う。history を読めなかった起動で cursor より古い
  // unfinished を落とすと、fetch が戻った次の restart で取り直せたはずの id を黙って捨てる
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-unfinished-keep-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const cursor = snowflakeAge(200_000)
  const legacyId = snowflakeAge(400_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-24T00:00:00.000Z',
    lastSeenMessageId: cursor,
    unfinishedMessageIds: [legacyId],
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit() {
            return 'unused'
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          fetchRecentMessages: async () => {
            throw new Error('synthetic history fetch failure')
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_backfill_skipped' && entry.reason === 'history_fetch_failed'
      }),
      JSON.stringify(logs),
    )
    assert.equal(
      logs.some((entry) => {
        return entry.type === 'discord_unfinished_pruned'
      }),
      false,
      'history を読めていない起動では prune しない',
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.deepEqual(state.unfinishedMessageIds, [legacyId], '次の restart の取り直し対象として残す')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: cursor が無い起動で unfinished があるとき、seed は unfinished より後ろへ進まない', async () => {
  // cursor が無い起動の seed は「history の newest を cursor に置く」が、unfinished がある状態でこれを
  // 素通りさせると cursor が unfinished を越える（越えた unfinished は candidate から外れて prune で
  // state file から消える = 2026-11-24 の incident の形）。seed できないときは cursor を null のまま置く
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-seed-gate-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const pendingId = snowflakeAge(200_000)
  const newerId = snowflakeAge(20_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-25T00:00:00.000Z',
    lastSeenMessageId: null,
    unfinishedMessageIds: [pendingId],
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [liveChatMessage(newerId, 'unfinished より新しい message')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submits, [], 'seed を置かない起動では history を処理しない')
    assert.ok(
      logs.some((entry) => {
        return (
          entry.type === 'discord_backfill_skipped' &&
          entry.reason === 'no_seedable_history' &&
          entry.unfinishedCount === 1 &&
          entry.historyCount === 1
        )
      }),
      JSON.stringify(logs),
    )
    assert.equal(
      logs.some((entry) => {
        return entry.type === 'discord_unfinished_pruned'
      }),
      false,
      'cursor が null の間は prune しない（prune は cursor が越えた id を落とす操作）',
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, null, 'unfinished より後ろへ seed しない')
    assert.deepEqual(state.unfinishedMessageIds, [pendingId], 'unfinished は次の restart の取り直し対象')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 未知 key（cursor / backoff）を持つ state.json でも起動し、key を log に出して次の write で落とす', async () => {
  // #29 で撤去した通知配送 retry 用の cursor・backoff を持った file が稼働環境に残っている。未知 key を
  // 理由に起動を止めると rollback や手当てで書いた file を壊す。state へ引き込まない事を log に出す
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-extra-keys-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const statePath = path.join(dataDir, 'discord', 'state.json')
  const lastSeen = snowflakeAge(300_000)

  await fs.mkdir(path.join(dataDir, 'discord'), { recursive: true })
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      cursor: 602,
      backoff: null,
      unit: 'araya-discord-seed',
      readyId: 'ready-seed',
      lastReadyAt: '2026-11-25T00:00:00.000Z',
      lastSeenMessageId: lastSeen,
    }),
  )

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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit() {
            return 'unused'
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0, '未知 key を理由に起動を止めない')
    assert.ok(
      logs.some((entry) => {
        return entry.type === 'discord_state_extra_keys' && (entry.keys as string[]).includes('cursor')
      }),
      JSON.stringify(logs),
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.version, 3, 'read 時に v3 の形へ揃う')
    assert.equal(
      Object.keys(state as Record<string, unknown>).includes('cursor'),
      false,
      '未知 key を state に引き込まない',
    )

    const written = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>

    assert.equal(written.cursor, undefined, '次の state 書き込みで file から消える')
    assert.equal(written.backoff, undefined)
    assert.equal(written.version, 3)
    assert.equal(written.lastSeenMessageId, lastSeen, 'cursor 値（lastSeenMessageId）は保持する')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: backfill 実行中に live が受理した unfinished より後ろへ cursor を進めない', async () => {
  // state file の invariant「cursor より古い unfinished が在るなら、その unfinished は取り直し対象として
  // 残る」を確かめる。backfill は history を古い順に処理するが、実行中に live が受理した（実行中の）id より
  // 後ろへ cursor を進めると、そこで kill された message は history の cursor gate で外れて prune 対象になる
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-live-unfinished-gate-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const releasePending: (() => void)[] = []
  let markBackfillNewerStarted: (() => void) | undefined
  const backfillNewerStarted = new Promise<void>((resolve) => {
    markBackfillNewerStarted = resolve
  })
  const cursorBefore = snowflakeAge(900_000)
  const backfillOlderId = snowflakeAge(700_000)
  const livePendingId = snowflakeAge(450_000)
  const backfillNewerId = snowflakeAge(300_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-25T00:00:00.000Z',
    lastSeenMessageId: cursorBefore,
  })

  const hang = () => {
    return new Promise<string>((resolve) => {
      releasePending.push(() => {
        resolve('release')
      })
    })
  }

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
      // 実行中の turn を置き去りにして閉じる（drain budget を短くして test を速くする）
      shutdownWaits: { hootMs: 50, drainMs: 300, gatewayMs: 300, sessionMs: 300 },
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(content: string, requestId: string) {
            submits.push(requestId)

            if (content.includes('backfill 新しい側の turn')) {
              markBackfillNewerStarted?.()

              return hang()
            }

            if (content.includes('live で受理した実行中の turn')) {
              return hang()
            }

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            // backfill は古い側（backfillOlderId）を処理して cursor をそこへ進め、新しい側の turn にいる
            await backfillNewerStarted
            // その最中に live が届いた id（backfill の新しい側より古い）が unfinished に入る。
            // 実行中の turn を await すると live 側が完了してしまうので、発射して並走させる
            void handlers.onMessage(liveChatMessage(livePendingId, 'live で受理した実行中の turn'), async () => {})
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          // gateway の history は新しい順
          async fetchRecentMessages() {
            return [
              liveChatMessage(backfillNewerId, 'backfill 新しい側の turn'),
              liveChatMessage(backfillOlderId, 'backfill 古い側の turn'),
            ]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(
      submits,
      [backfillOlderId, backfillNewerId],
      'backfill は古い順で走る。live の turn は同じ queue を待つので backfill の turn の間 submit まで到達しない',
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(
      state.lastSeenMessageId,
      backfillOlderId,
      JSON.stringify({ state, submits, backfillOlderId, livePendingId, backfillNewerId }),
    )
    assert.ok(
      (state.unfinishedMessageIds ?? []).includes(livePendingId),
      JSON.stringify(state.unfinishedMessageIds),
    )
  } finally {
    stopController.abort()

    for (const release of releasePending) {
      release()
    }

    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: chatHandler が無い状態で受け取った message は log に出て unfinished に残る', async () => {
  // onReady より前に messageCreate が届くと chatHandler が無い。turn を走らせていないのに「処理終えた」扱いに
  // すると、 unfinished にも answered にも入らないまま cursor だけが進む（discord_chat_received にも
  // discord_chat_ignored にも載らない）。受理したが未処理なので unfinished に書き、cursor は進めない
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-handler-not-ready-test-')),
  )
  const stopController = new AbortController()
  const logs: Record<string, unknown>[] = []
  const submits: string[] = []
  const cursorBefore = snowflakeAge(300_000)
  const earlyId = snowflakeAge(30_000)

  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-25T00:00:00.000Z',
    lastSeenMessageId: cursorBefore,
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
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)

            return `answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onMessage(liveChatMessage(earlyId, 'ready 前に届いた message'), async () => {})
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 200)
            })
            stopController.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return logs.push(entry)
      },
    })

    assert.equal(exitCode, 0)
    assert.deepEqual(submits, [], 'chatHandler が無いので会話を走らせない')
    assert.ok(
      logs.some((entry) => {
        return (
          entry.type === 'discord_chat_ignored' &&
          entry.reason === 'handler_not_ready' &&
          entry.messageId === earlyId
        )
      }),
      JSON.stringify(logs),
    )

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.lastSeenMessageId, cursorBefore, '処理していない message で cursor を進めない')
    assert.deepEqual(state.unfinishedMessageIds, [earlyId], '受理した未処理の id は取り直し対象に残す')
  } finally {
    stopController.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('discord bot: 実応答の send に失敗した message は answered に記録して取り直さない（attempted send である）', async () => {
  // chat.ts は Discord への send 失敗を discord_chat_reply_failed として握る（turn 自体は完走している）。
  // bot は reply の chunk を数えて answered に記録するので、この message は restart 後の取り直し対象にならない。
  // 会話 input は既に consume 済みで、turn を再実行すると会話を二重に処理する（reply だけの再送は別 issue）
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-reply-failed-answered-test-')),
  )
  const firstStop = new AbortController()
  const secondStop = new AbortController()
  const firstLogs: Record<string, unknown>[] = []
  const secondLogs: Record<string, unknown>[] = []
  const submits: string[] = []
  const olderCursor = snowflakeAge(900_000)
  const blockerId = snowflakeAge(700_000)
  const failedId = snowflakeAge(100_000)
  const SENTINEL = 'SENTINEL-SEND-FAILED'

  // より古い unfinished（history の fetch が 0 件なので unreachable 判定されない）が cursor を止める形で、
  // answered の記録が cursor の prune で消えない状態を作る
  writeDiscordBotState(dataDir, {
    ...newState(),
    unit: 'araya-discord-seed',
    readyId: 'ready-seed',
    lastReadyAt: '2026-11-25T00:00:00.000Z',
    lastSeenMessageId: olderCursor,
    unfinishedMessageIds: [blockerId],
  })

  try {
    const firstExitCode = await runDiscordBot({
      fetch: noticeStubFetch,
      dataDir,
      env: {
        ARAYA_DISCORD_BOT_TOKEN: BOT_TOKEN,
        ARAYA_DISCORD_APPLICATION_ID: APPLICATION_ID,
        ARAYA_DISCORD_GUILD_ID: GUILD_ID,
        ARAYA_DISCORD_CHANNEL_ID: CHANNEL_ID,
        ARAYA_DISCORD_ALLOWED_USER_IDS: USER_ID,
      },
      stopSignal: firstStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)

            return `${SENTINEL} answer ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await handlers.onMessage(liveChatMessage(failedId, '応答の send に失敗する turn'), async () => {
              throw new Error('synthetic send failure')
            })
            await new Promise((resolve) => {
              setTimeout(resolve, 150)
            })
            firstStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return []
          },
          async close() {},
        }
      },
      log: (entry) => {
        return firstLogs.push(entry)
      },
    })

    assert.equal(firstExitCode, 0)
    assert.deepEqual(submits, [failedId], '会話は走っている（consume 済み）')
    assert.ok(
      firstLogs.some((entry) => {
        return entry.type === 'discord_chat_reply_failed' && entry.messageId === failedId
      }),
      JSON.stringify(firstLogs),
    )

    const stateAfterFirst = readDiscordBotState(dataDir)

    assert.ok(stateAfterFirst !== null)
    assert.deepEqual(
      stateAfterFirst.answeredMessageIds,
      [failedId],
      'send 失敗でも answered に記録される（attempted send であり delivered answer ではない）',
    )
    assert.deepEqual(stateAfterFirst.unfinishedMessageIds, [blockerId], 'unfinished が cursor を止める')
    assert.equal(stateAfterFirst.lastSeenMessageId, olderCursor)

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
      stopSignal: secondStop.signal,
      verifyUnit: false,
      createChatSession: async () => {
        return {
          describe: () => {
            return { conversationId: 7 }
          },
          async submit(_content: string, requestId: string) {
            submits.push(requestId)

            return `取り直しました ${requestId}`
          },
          async reset() {},
          async close() {},
        }
      },
      createGateway: async (_config, handlers) => {
        return {
          async connect() {
            await handlers.onReady('998877665544332211')
            await new Promise((resolve) => {
              setTimeout(resolve, 250)
            })
            secondStop.abort()
          },
          async sendText() {},
          async registerCommands() {
            return 2
          },
          async fetchRecentMessages() {
            return [liveChatMessage(failedId, '応答の send に失敗する turn')]
          },
          async close() {},
        }
      },
      log: (entry) => {
        return secondLogs.push(entry)
      },
    })

    assert.equal(secondExitCode, 0)
    assert.deepEqual(submits, [failedId], 'send 失敗の message は restart 後に取り直さない')
    assert.ok(
      secondLogs.some((entry) => {
        return (
          entry.type === 'discord_backfill_ignored' &&
          entry.reason === 'already_handled' &&
          entry.messageId === failedId
        )
      }),
      JSON.stringify(secondLogs),
    )
  } finally {
    firstStop.abort()
    secondStop.abort()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
