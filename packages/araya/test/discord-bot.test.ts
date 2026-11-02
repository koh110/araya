import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openTaskLedger } from '../src/runner/ledger.ts'
import { runDiscordBot } from '../src/discord/bot.ts'
import { dataDirHash, discordUnitName, runnerUnitName } from '../src/infrastructure/systemd.ts'

const BOT_TOKEN = 'synthetic-token'
const APPLICATION_ID = '12345678901234567'
const GUILD_ID = '22345678901234567'
const CHANNEL_ID = '32345678901234567'
const USER_ID = '42345678901234567'

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
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            await handlers.onInteraction(
              {
                interactionId: 'interaction-unit-name',
                userId: USER_ID,
                guildId: GUILD_ID,
                channelId: CHANNEL_ID,
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

test('discord bot: discord.env 由来の bot token を task・retry note・reply・notification に残さない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-bot-secret-test-')),
  )
  const stopController = new AbortController()
  const replies: string[] = []
  const notifications: string[] = []
  const envFile = path.join(dataDir, 'discord.env')

  await fs.writeFile(
    envFile,
    [
      `ARAYA_DISCORD_BOT_TOKEN=${BOT_TOKEN}`,
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
      env: {},
      stopSignal: stopController.signal,
      verifyUnit: false,
      sleep: async () => {},
      createGateway: async (_config, handlers) => {
        return {
          connect: async () => {
            handlers.onReady()
            const request = {
              interactionId: 'secret-task',
              userId: USER_ID,
              guildId: GUILD_ID,
              channelId: CHANNEL_ID,
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
