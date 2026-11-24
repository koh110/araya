import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { launchChildAndWait, stderrLineWriter } from '../src/infrastructure/child-launcher.ts'
import { installShutdownSignals } from '../src/discord/shutdown-signals.ts'

const SIGNAL_HELPER_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../src/discord/shutdown-signals.ts',
)

test('shutdown signals: listener を張り続け、同じ signal が 2 回届いても abort は 1 回だけ', () => {
  const handlers: (() => void)[] = []
  const registered: string[] = []
  let aborts = 0
  const target = {
    on: (signal: string, handler: () => void) => {
      registered.push(signal)
      handlers.push(handler)
    },
  }
  const status = installShutdownSignals(target, () => {
    aborts += 1
  })

  assert.deepEqual(registered, ['SIGTERM', 'SIGINT'])

  // systemd（control group 全体）と runner（child へ forward）の両方が届けるので、同じ signal が複数回届く。
  // listener を外さないため 2 回目も requestStop に入り、abort は 1 回だけになる
  for (const handler of handlers) {
    handler()
  }

  assert.equal(aborts, 1)
  assert.equal(status.stopRequested(), true)
})

const BOT_SOURCE = `
import process from 'node:process'
import { installShutdownSignals } from '${SIGNAL_HELPER_PATH}'

const controller = new AbortController()
installShutdownSignals(process, () => {
  controller.abort()
})
process.stderr.write('CHILD_UP\\n')
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    if (controller.signal.aborted) {
      clearInterval(timer)
      resolve()
    }
  }, 20)
})
// signal 後に drain する時間（ここで process が死ぬと #36 の打ち切りになる）
await new Promise((resolve) => {
  setTimeout(resolve, 600)
})
process.stderr.write('CHILD_STOPPED\\n')
process.exit(0)
`

async function runLauncherWithSignals() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-shutdown-signal-')),
  )
  const botPath = path.join(root, 'fake-bot.mts')
  const lines: string[] = []
  let child: ChildProcess | null = null

  await fs.writeFile(botPath, BOT_SOURCE, 'utf8')

  try {
    const stopping = launchChildAndWait({
      command: process.execPath,
      args: [botPath],
      env: { ...process.env },
      stopWaitMs: 8_000,
      secretValues: [],
      label: 'probe-runner',
      writeError: stderrLineWriter((line) => {
        lines.push(line)
      }),
      spawnChild: (input) => {
        const spawned = spawn(input.command, input.args, {
          env: input.env,
          shell: false,
          stdio: ['ignore', 'ignore', 'pipe'],
        })

        child = spawned

        return spawned
      },
    })

    // child が signal を受け取れる状態になってから送る（起動前に送ると race する）
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (lines.some((line) => line.includes('CHILD_UP'))) {
        break
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 30)
      })
    }

    // 1 本目: runner 自体へ（systemd が main へ送る分）。runner が bot へ forward する
    process.kill(process.pid, 'SIGTERM')

    // 2 本目: systemd が control group 経由で bot 自身へ送る分
    const spawned = child as ChildProcess | null

    if (spawned !== null) {
      spawned.kill('SIGTERM')
    }

    const outcome = await stopping

    return {
      outcome,
      log: lines.join(''),
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('launcher + bot: SIGTERM が 2 本届いても bot は drain を終わらせて code 0 で抜ける（#36）', async () => {
  const { outcome, log } = await runLauncherWithSignals()

  assert.equal(outcome.killedByLauncher, false, log)
  assert.equal(outcome.signal, null, log)
  assert.equal(outcome.exitCode, 0, log)
  assert.ok(log.includes('CHILD_STOPPED'), log)
  // child の終了理由と、drain まで含めた stderr の最後の行が launcher log に残っている
  assert.match(log, /CHILD_STOPPED[^\n]*\nprobe-runner: child 終了（code=0, signal=none）/u)
})
