import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CONTROL_REQUEST_TTL_MS,
  claimControlRequest,
  controlRequestId,
  controlRequestsDir,
  controlResultsDir,
  finishControlRequest,
  pruneControlFiles,
  readControlRequest,
  readControlResult,
  readPendingControlRequests,
  writeControlRequest,
} from '../src/infrastructure/control-bus.ts'
import { createCliControlLoop } from '../src/discord/cli-control.ts'
import { runControlCommand } from '../src/cli/control-commands.ts'

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function tempDataDir(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function requestOf(id: string, command: 'status' | 'stop' | 'reset', createdAtMs: number) {
  return {
    version: 1 as const,
    id,
    command,
    source: 'cli' as const,
    createdAt: new Date(createdAtMs).toISOString(),
  }
}

test('control bus: request を claim して result を返し、同じ request を 2 回実行しない', async () => {
  const dataDir = await tempDataDir('araya-control-bus-')
  const createdAt = Date.now()
  const id = controlRequestId(createdAt, 'status:test')

  await writeControlRequest(dataDir, requestOf(id, 'status', createdAt))
  const pending = await readPendingControlRequests(dataDir)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.id, id)
  assert.equal((await readControlRequest(dataDir, id))?.command, 'status')

  const claimed = await claimControlRequest(dataDir, id)
  assert.equal(claimed?.command, 'status')
  // claim 後は pending に見えない（rename しているので CLI 側の cancel は効かない）
  assert.equal((await readPendingControlRequests(dataDir)).length, 0)
  assert.equal(await claimControlRequest(dataDir, id), null)

  await finishControlRequest(dataDir, id, {
    command: 'status',
    ok: true,
    output: '会話: main conversation #7 / 実行中 0 / 待ち 0',
    finishedAt: new Date().toISOString(),
  })
  const result = await readControlResult(dataDir, id)
  assert.equal(result?.ok, true)
  assert.match(result?.output ?? '', /main conversation #7/)
  // finish で request 側（claim file）も消える
  assert.deepEqual(await fs.readdir(controlRequestsDir(dataDir)), [])
})

test('control bus: 期限を超えた request は実行せずに「stale」の result で閉じる', async () => {
  const dataDir = await tempDataDir('araya-control-bus-stale-')
  const createdAt = Date.now() - CONTROL_REQUEST_TTL_MS - 60_000
  const id = controlRequestId(createdAt, 'stop:stale')

  await writeControlRequest(dataDir, requestOf(id, 'stop', createdAt))
  const pruned = await pruneControlFiles(dataDir, Date.now())
  assert.ok(pruned >= 1)
  assert.equal((await readPendingControlRequests(dataDir)).length, 0)

  const result = await readControlResult(dataDir, id)
  assert.equal(result?.ok, false)
  assert.match(result?.error ?? '', /araya_control_stale/)
  assert.equal(result?.command, 'stop')
})

test('control bus: 未知の command の request は読まない（注入された file を実行しない）', async () => {
  const dataDir = await tempDataDir('araya-control-bus-unknown-')
  const requestsDir = controlRequestsDir(dataDir)
  await fs.mkdir(requestsDir, { recursive: true })
  await fs.writeFile(
    path.join(requestsDir, 'evil.json'),
    JSON.stringify({ version: 1, id: 'evil', command: 'dispatch', source: 'cli', createdAt: new Date().toISOString() }),
    'utf8',
  )
  assert.equal((await readPendingControlRequests(dataDir)).length, 0)
})

test('cli control loop: request を拾って run を呼び、result と log を書く（command 名だけ log に残す）', async () => {
  const dataDir = await tempDataDir('araya-cli-control-loop-')
  const createdAt = Date.now()
  const id = controlRequestId(createdAt, 'reset:loop')
  const logs: Record<string, unknown>[] = []
  const calls: { command: string; requestId: string }[] = []

  await writeControlRequest(dataDir, requestOf(id, 'reset', createdAt))

  const loop = createCliControlLoop({
    dataDir,
    nowMs: () => Date.now(),
    log: (entry) => {
      return logs.push(entry)
    },
    run: async (command, requestId) => {
      calls.push({ command, requestId })

      return 'この channel の会話をリセットしました'
    },
  })

  assert.equal(await loop.drainOnce(), 1)
  assert.deepEqual(calls, [{ command: 'reset', requestId: id }])
  const result = await readControlResult(dataDir, id)
  assert.equal(result?.ok, true)
  assert.match(result?.output ?? '', /リセットしました/)
  assert.equal(logs[0]?.type, 'discord_control_cli')
  assert.equal(logs[0]?.command, 'reset')
  // 2 周目は空（claim 済みなので再実行しない）
  assert.equal(await loop.drainOnce(), 0)
})

test('cli control loop: run が失敗したら result を ok:false で閉じ、discord_control_cli_failed に log する', async () => {
  const dataDir = await tempDataDir('araya-cli-control-loop-failed-')
  const createdAt = Date.now()
  const id = controlRequestId(createdAt, 'stop:failed')
  const logs: Record<string, unknown>[] = []

  await writeControlRequest(dataDir, requestOf(id, 'stop', createdAt))

  const loop = createCliControlLoop({
    dataDir,
    nowMs: () => Date.now(),
    log: (entry) => {
      return logs.push(entry)
    },
    run: async () => {
      throw new Error('chat_session_unavailable: 会話 session がまだ ready ではありません')
    },
  })

  assert.equal(await loop.drainOnce(), 1)
  const result = await readControlResult(dataDir, id)
  assert.equal(result?.ok, false)
  assert.match(result?.error ?? '', /chat_session_unavailable/)
  assert.equal(logs[0]?.type, 'discord_control_cli_failed')
})

// bot の poll 役：溜まっている request を拾って応答を書く
async function fakeBot(dataDir: string, respond: (command: string, id: string) => string, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const pending = await readPendingControlRequests(dataDir)

    for (const request of pending) {
      const claimed = await claimControlRequest(dataDir, request.id)

      if (claimed === null) {
        continue
      }

      await finishControlRequest(dataDir, claimed.id, {
        command: claimed.command,
        ok: true,
        output: respond(claimed.command, claimed.id),
        finishedAt: new Date().toISOString(),
      })

      return
    }

    await sleep(20)
  }
}

test('araya status・stop・reset: 稼働中の bot の応答を stdout に出す', async () => {
  const dataDir = await tempDataDir('araya-cli-control-respond-')
  const outputs: string[] = []

  const bot = fakeBot(dataDir, (command) => {
    return command === 'stop' ? '実行中・実行待ちの作業があれば中止を要求しました' : 'bot の応答'
  })

  await runControlCommand(
    ['stop'],
    {
      dataDir,
      stdout: (text) => {
        return outputs.push(text)
      },
      nowMs: () => Date.now(),
      env: {},
      waitMs: 5_000,
      pollMs: 20,
    },
  )
  await bot
  assert.match(outputs.join('\n'), /中止を要求しました/)
})

test('bot が応答しないとき: stop / reset は araya_control_unavailable、status は読み取りだけ返す', async () => {
  const dataDir = await tempDataDir('araya-cli-control-timeout-')
  const outputs: string[] = []
  const deps = {
    dataDir,
    stdout: (text: string) => {
      return outputs.push(text)
    },
    nowMs: () => Date.now(),
    env: {},
    waitMs: 400,
    pollMs: 30,
  }

  await assert.rejects(
    async () => {
      return await runControlCommand(['reset'], deps)
    },
    /araya_control_unavailable/,
  )
  await assert.rejects(
    async () => {
      return await runControlCommand(['stop'], deps)
    },
    /araya_control_unavailable/,
  )

  // status は読み取りなので、bot が居なくても HOOT の状態と案内を返す（exit code を壊さない）
  await runControlCommand(['status'], deps)
  const text = outputs.join('\n')
  assert.match(text, /enabled/u)
  assert.match(text, /araya discord status/)
  // 待ち切れにした要求は bot が後で実行しないよう消えている（status 分も消す）
  assert.equal((await readPendingControlRequests(dataDir)).length, 0)
})

test('araya status・stop・reset: 未知の command は拒否する（control bus に file を書かない）', async () => {
  const dataDir = await tempDataDir('araya-cli-control-invalid-')

  await assert.rejects(
    async () => {
      return await runControlCommand(['dispatch'], {
        dataDir,
        stdout: () => {},
        nowMs: () => Date.now(),
        env: {},
        waitMs: 200,
        pollMs: 20,
      })
    },
    /不明な control の command/,
  )

  try {
    assert.deepEqual(await fs.readdir(controlResultsDir(dataDir)), [])
  } catch (error) {
    // results dir 未作成（要求を書いていない）も可
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
  }
})


test('bot 側の run は slash command と同じ control kernel を通す（runControl の text を result に書く）', async () => {
  const dataDir = await tempDataDir('araya-cli-control-kernel-')
  const calls: string[] = []

  const loop = createCliControlLoop({
    dataDir,
    nowMs: () => Date.now(),
    log: () => {},
    pollMs: 20,
    // bot.ts は chat handler の runControl をここで呼ぶ（fake は同じ応答文を返す）
    run: async (command, requestId) => {
      calls.push(`${command}:${requestId}`)

      return command === 'status' ? '会話: main conversation #9 / 実行中 0 / 待ち 0' : 'できませんでした'
    },
  })
  loop.start()

  try {
    const outputs: string[] = []
    await runControlCommand(['status'], {
      dataDir,
      stdout: (text) => {
        return outputs.push(text)
      },
      nowMs: () => Date.now(),
      env: {},
      waitMs: 3_000,
      pollMs: 20,
    })
    assert.match(outputs.join('\n'), /main conversation #9/)
  } finally {
    loop.stop()
  }

  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? '', /^status:cli-/u)
})

test('cli control loop: result file に書く文字列は redact する（error 文の secret を残さない）', async () => {
  const dataDir = await tempDataDir('araya-cli-control-redact-')
  const createdAt = Date.now()
  const id = controlRequestId(createdAt, 'status:redact')

  await writeControlRequest(dataDir, requestOf(id, 'status', createdAt))

  const loop = createCliControlLoop({
    dataDir,
    nowMs: () => Date.now(),
    log: () => {},
    redact: (text) => {
      return text.replaceAll('synthetic-bot-token', '[REDACTED]')
    },
    run: async () => {
      throw new Error('discord_send_failed: synthetic-bot-token を使う送信に失敗')
    },
  })

  await loop.drainOnce()
  const result = await readControlResult(dataDir, id)
  assert.equal(result?.ok, false)
  assert.match(result?.error ?? '', /\[REDACTED\]/)
  assert.ok(!JSON.stringify(result).includes('synthetic-bot-token'))
  const fileText = await fs.readFile(path.join(controlResultsDir(dataDir), `${id}.json`), 'utf8')
  assert.ok(!fileText.includes('synthetic-bot-token'))
})
