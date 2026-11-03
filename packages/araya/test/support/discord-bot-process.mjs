import { runDiscordBot } from '../../src/discord/bot.ts'

const dataDir = process.argv[2]
if (!dataDir) throw new Error('dataDir argument is required')

const stopController = new AbortController()
process.on('SIGTERM', () => {
  stopController.abort()
})

const exitCode = await runDiscordBot({
  dataDir,
  env: {
    ARAYA_DISCORD_BOT_TOKEN: 'synthetic-token',
    ARAYA_DISCORD_APPLICATION_ID: '12345678901234567',
    ARAYA_DISCORD_GUILD_ID: '22345678901234567',
    ARAYA_DISCORD_CHANNEL_ID: '32345678901234567',
    ARAYA_DISCORD_ALLOWED_USER_IDS: '42345678901234567',
  },
  stopSignal: stopController.signal,
  verifyUnit: false,
  pollMs: 60_000,
  createGateway: async (_config, handlers) => ({
    connect: async () => {
      handlers.onReady()
      process.stdout.write('ready\n')
    },
    sendText: async () => {},
    close: async () => {},
  }),
  log: () => {},
})

process.exitCode = exitCode
