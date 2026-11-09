#!/usr/bin/env node
// Discord bot のstandalone process。標準 env-file launcher または任意の1Password launcherから起動する。
// launcherが設定値を環境変数へ渡し、1Password modeでは<dataDir>/.envのop://参照を解決する。

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
