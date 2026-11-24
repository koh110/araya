import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { test } from 'vite-plus/test'
import { fileURLToPath } from 'node:url'

import { installShutdownSignals } from './shutdown-signals.ts'

const SRC_DIR = path.resolve(fileURLToPath(import.meta.url), '../../')
const SIGNAL_HELPER_PATH = path.join(SRC_DIR, 'discord/shutdown-signals.ts')
const CHILD_LAUNCHER_PATH = path.join(SRC_DIR, 'infrastructure/child-launcher.ts')

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

const RUNNER_SOURCE = `
import process from 'node:process'
import { launchChildAndWait, launcherStopWaitMs, stderrLineWriter } from '${CHILD_LAUNCHER_PATH}'

const outcome = await launchChildAndWait({
  command: process.execPath,
  args: [process.argv[2]],
  env: { ...process.env },
  stopWaitMs: launcherStopWaitMs(process.env),
  secretValues: [],
  label: 'probe-runner',
  writeError: stderrLineWriter(),
})
process.stderr.write('RUNNER_RESOLVED ' + JSON.stringify(outcome) + '\\n')
process.exitCode = outcome.exitCode
`

function botSource(signalMode: 'persistent' | 'once') {
  const signalSetup =
    signalMode === 'persistent'
      ? `
import { installShutdownSignals } from '${SIGNAL_HELPER_PATH}'
installShutdownSignals(process, () => {
  controller.abort()
})
`
      : `
process.once('SIGTERM', () => {
  controller.abort()
})
process.once('SIGINT', () => {
  controller.abort()
})
`

  return `
import process from 'node:process'

const controller = new AbortController()
${signalSetup}
process.stderr.write('CHILD_UP ' + process.pid + '\\n')
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (controller.signal.aborted) {
      clearInterval(timer)
      resolve(null)
    }
  }, 20)
})
// signal 後に drain する時間。ここで process が kill されると #36 の drain 打ち切りになる
await new Promise((resolve) => {
  setTimeout(resolve, 600)
})
process.stderr.write('CHILD_STOPPED\\n')
process.exit(0)
`
}

// systemd の stop は main（runner）と control group 内の bot の両方へ SIGTERM を送る。
// runner は自分の child にも SIGTERM を forward するので、bot には外から 2 本届く。その順番を再現する
async function runWithTwoExternalSignals(signalMode: 'persistent' | 'once') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-shutdown-signal-')))
  const botPath = path.join(root, 'fake-bot.mts')
  const runnerPath = path.join(root, 'fake-runner.mts')

  await fs.writeFile(botPath, botSource(signalMode), 'utf8')
  await fs.writeFile(runnerPath, RUNNER_SOURCE, 'utf8')

  const lines: string[] = []

  try {
    const runner = spawn(process.execPath, [runnerPath, botPath], {
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const childStderr = runner.stderr
    childStderr.setEncoding('utf8')
    childStderr.on('data', (chunk: string) => {
      lines.push(chunk)
    })

    // bot が起動して signal を受け取れる状態になるまで待つ
    let botPid = 0

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const match = lines.join('').match(/CHILD_UP (\d+)/u)

      if (match !== null) {
        botPid = Number(match[1])

        break
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }

    assert.notEqual(botPid, 0, lines.join(''))

    // 1 本目: main process（runner）へ。runner が bot へ forward する
    runner.kill('SIGTERM')

    // bot が 1 本目を処理して listener を外した後に 2 本目が届く（systemd の stop job と同じ順番）
    await new Promise((resolve) => {
      setTimeout(resolve, 120)
    })

    // 2 本目: control group 経由で bot 自身へ届く分
    process.kill(botPid, 'SIGTERM')

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      runner.once('exit', (code, signal) => {
        resolve({ code, signal })
      })
    })

    return {
      exit,
      log: lines.join(''),
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('launcher + bot: 外から 2 本 SIGTERM が届いても persistent listener の bot は drain を終わらせる（#36）', async () => {
  const { exit, log } = await runWithTwoExternalSignals('persistent')

  assert.ok(log.includes('CHILD_STOPPED'), log)
  assert.match(log, /child 終了（code=0, signal=none）/u)
  assert.match(log, /RUNNER_RESOLVED \{"exitCode":0,"signal":null,"killedByLauncher":false\}/u)
  assert.equal(exit.code, 0, log)
  assert.equal(exit.signal, null, log)
})

test('launcher + bot: process.once の bot は 2 本目の external SIGTERM で drain の途中で kill される（#36 の実測）', async () => {
  const { exit, log } = await runWithTwoExternalSignals('once')

  // 2 本目 listener を外した bot は node の default 動作で kill され、drain が最後まで進まない
  assert.ok(!log.includes('CHILD_STOPPED'), log)
  assert.match(log, /child 終了（code=null, signal=SIGTERM）/u)
  assert.match(log, /RUNNER_RESOLVED \{"exitCode":1,"signal":"SIGTERM","killedByLauncher":false\}/u)
  assert.equal(exit.code, 1, log)
})
