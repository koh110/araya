#!/usr/bin/env node
// Discord bot のstandalone process。systemd unitから1Password launcher経由で起動する。
// launcherがop runで解決した環境変数を優先し、<dataDir>/discord.envにはop://参照を置く。

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
