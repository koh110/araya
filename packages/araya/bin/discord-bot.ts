#!/usr/bin/env node
// Discord bot の standalone process。systemd の unit（araya-discord-<hash>.service）の ExecStart はこの file を使う。
// 設定は <dataDir>/discord.env（EnvironmentFile）から読む。設定が無ければ log して exit 1

import process from 'node:process'
import { parseArgs } from 'node:util'
import { runDiscordBot } from '../src/discord/bot.ts'

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    'data-dir': { type: 'string' },
  },
  strict: true,
})

const dataDir = parsed.values['data-dir']

if (typeof dataDir !== 'string' || dataDir === '') {
  console.error('使い方: discord-bot --data-dir <dataDir>')
  process.exit(2)
}

const controller = new AbortController()
function onSignal() {
  controller.abort()
}

process.once('SIGTERM', onSignal)
process.once('SIGINT', onSignal)

const exitCode = await runDiscordBot({
  dataDir,
  env: process.env,
  stopSignal: controller.signal,
})

process.exit(exitCode)
