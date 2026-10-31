import fs from 'node:fs/promises'
import path from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import type { Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { answer, toolCall, worktreePathFrom, type FauxView } from './faux-shiki.ts'
import { createRepository, taskInput, waitUntil, type RunnerFixture } from './runner-fixture.ts'
import { createRunnerSetup, openLedger, writeModelConfig, type RunnerSetup } from './runner-loop.ts'

// runner の test で共有する、SHIKI の応答、台帳の event の読み出し、process の確認、storage の誤りの注入

export const PASS_COMMAND = [process.execPath, '-e', "console.log('verified')"]
export const FAIL_COMMAND = [process.execPath, '-e', 'process.exit(3)']

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function records(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('not an array')
  }

  return value.filter(isRecord)
}

export function readEvents(fixture: RunnerFixture) {
  const db = new DatabaseSync(path.join(fixture.dataDir, 'tasks.sqlite'))

  try {
    return db.prepare('SELECT seq, task_id, attempt, type, data_json FROM task_events ORDER BY seq').all().map((row) => {
      const data: unknown = JSON.parse(String(row.data_json))

      return { seq: Number(row.seq), taskId: Number(row.task_id), attempt: row.attempt === null ? null : Number(row.attempt), type: String(row.type), data }
    })
  } finally {
    db.close()
  }
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function readPid(file: string) {
  await waitUntil(async () => {
    try {
      return (await fs.readFile(file, 'utf8')).trim() !== ''
    } catch {
      return false
    }
  }, `pid file ${file}`)

  return Number((await fs.readFile(file, 'utf8')).trim())
}

// worktree を作り、bash で編集し、検証を登録して、報告で終わる SHIKI
export function completingStep(view: FauxView, options: { command?: readonly string[]; report?: string; repository?: string } = {}) {
  const results = view.toolResults
  const repository = options.repository ?? 'repo'

  switch (results.length) {
    case 0:
      return toolCall('araya_create_worktree', { repository, base: 'HEAD' })
    case 1:
      return toolCall('bash', { command: `printf 'changed\\n' >> ${worktreePathFrom(results[0])}/README.md` })
    case 2:
      return toolCall('araya_register_verification', { repository, command: [...(options.command ?? PASS_COMMAND)] })
    default:
      return answer(options.report ?? `${view.taskKey} の作業を終えました`)
  }
}

export async function setupWithRepository(options: Parameters<typeof createRunnerSetup>[0] = {}) {
  const setup = await createRunnerSetup(options)
  await createRepository(setup.fixture, 'repo')
  await writeModelConfig(setup.fixture, setup.models.model)

  return setup
}

export function createTasks(setup: RunnerSetup, count: number) {
  const ledger = openLedger(setup)

  try {
    return Array.from({ length: count }, (_value, index) => {
      return ledger.createTask(taskInput({ title: `Task ${index + 1}` })).task.id
    })
  } finally {
    ledger.close()
  }
}

// runner の loop の回数を数える（RunnerFaults.afterCancelCheck に渡す）。loop の期限と中止の確認が、進めた時計で行われたことを待つのに使う
export function createLoopCounter() {
  let count = 0

  return {
    afterCancelCheck() {
      count += 1
    },
    async waitForLoops(loops: number) {
      const target = count + loops
      await waitUntil(() => {
        return count >= target
      }, `${loops} runner loops`)
    }
  }
}

// 次の commit を1回だけ失敗させる storage（pi-durable の storage の誤りの再現）。armed を true にすると、次の commit が失敗する。
// message は失敗の誤りの message
export function createFailingStorage(message = 'injected storage failure') {
  const inject = { armed: false, hits: 0 }

  async function open(storagePath: string) {
    const storage = await openNodeSqliteStorage(storagePath)
    const commit: Storage['commit'] = async (writes, context) => {
      if (inject.armed) {
        inject.armed = false
        inject.hits += 1
        throw new Error(message)
      }

      return storage.commit(writes, context)
    }
    const wrapped: Storage = new Proxy(storage, {
      get(target, property) {
        if (property === 'commit') {
          return commit
        }

        const value: unknown = Reflect.get(target, property, target)

        return typeof value === 'function' ? value.bind(target) : value
      }
    })

    return wrapped
  }

  return { inject, open }
}
