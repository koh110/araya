#!/usr/bin/env node
import path from 'node:path'
import { parseArgs } from 'node:util'

import { collectSecretValues } from '../src/redaction.ts'
import { createRunnerLog, installRunnerProcessHandlers, runTaskRunner } from '../src/task-runner.ts'

// runner の entrypoint。systemd の user service（araya runner install が書く unit）の ExecStart から起動する
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { 'data-dir': { type: 'string' } },
  strict: true
})
const dataDir = values['data-dir']

if (dataDir === undefined || dataDir === '') {
  console.error('--data-dir が必要です')
  process.exit(1)
}

const controller = new AbortController()
installRunnerProcessHandlers(controller, createRunnerLog(path.resolve(dataDir), collectSecretValues(process.env)))

const code = await runTaskRunner({
  dataDir,
  env: process.env,
  platform: process.platform,
  stopSignal: controller.signal
})
process.exit(code)
