import fs from 'node:fs/promises'
import path from 'node:path'

import type { Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { formatModel, type DevelopmentModel } from '../../src/config/model.ts'
import { runnerUnitName, scopePattern } from '../../src/infrastructure/systemd.ts'
import { openTaskLedger } from '../../src/runner/ledger.ts'
import { runTaskRunner, type RunnerDependencies } from '../../src/runner/runner.ts'
import { createFakeSystemd, type FakeSystemdOptions } from './fake-systemd.ts'
import { createFauxModels } from './faux-shiki.ts'
import { createRunnerFixture, removeRunnerFixture, waitUntil, type RunnerFixture } from './runner-fixture.ts'

// runner の本体を同じ process の中で動かす test の support。偽物の systemd、faux の model、差し替えた時計で runTaskRunner を呼ぶ

const STOP_TIMEOUT_MS = 30_000

export type RunnerSetup = Awaited<ReturnType<typeof createRunnerSetup>>

// monotonic な時計と壁時計。test から進める（壁時計は本物の時刻に、進めた分を足したもの）
export function createClock() {
  let monotonic = 1_000_000
  let wallOffset = 0

  return {
    monotonicNow() {
      return monotonic
    },
    wallNow() {
      return new Date(Date.now() + wallOffset)
    },
    advance(ms: number) {
      monotonic += ms
      wallOffset += ms
    }
  }
}

export async function createRunnerSetup(options: {
  env?: Record<string, string>
  reasoning?: boolean
  systemd?: FakeSystemdOptions
} = {}) {
  const fixture = await createRunnerFixture()
  const env: Record<string, string | undefined> = {
    ...fixture.env,
    ARAYA_DEV_ROOT: fixture.devRoot,
    ARAYA_VERIFICATION_TIMEOUT_MS: '10000',
    INVOCATION_ID: 'test-invocation-0001',
    ...options.env
  }
  const models = await createFauxModels(fixture, { reasoning: options.reasoning ?? false })
  const systemd = createFakeSystemd(options.systemd ?? {})
  const clock = createClock()

  return { fixture, env, models, systemd, clock }
}

// 設定ファイル（<dataDir>/config.json）に開発用の model を書く
export async function writeModelConfig(fixture: RunnerFixture, model: DevelopmentModel) {
  const development = model.thinkingLevel === null
    ? { model: formatModel(model) }
    : { model: formatModel(model), thinkingLevel: model.thinkingLevel }
  await fs.writeFile(path.join(fixture.dataDir, 'config.json'), JSON.stringify({ development }), 'utf8')
}

export type StartedRunner = ReturnType<typeof startRunner>

// runner を起動する。done は runTaskRunner の終了 code。stop() は SIGTERM と同じく止めるように求めて終わりを待つ
export function startRunner(setup: RunnerSetup, overrides: Partial<RunnerDependencies> = {}) {
  const controller = new AbortController()
  const storageOpened: string[] = []
  const done = runTaskRunner({
    dataDir: setup.fixture.dataDir,
    env: setup.env,
    platform: 'linux',
    stopSignal: controller.signal,
    readCgroup: async () => {
      return `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${runnerUnitName(setup.fixture.hash)}\n`
    },
    monotonicNow: setup.clock.monotonicNow,
    now: setup.clock.wallNow,
    openStorage: async (storagePath: string) => {
      storageOpened.push(storagePath)
      const storage: Storage = await openNodeSqliteStorage(storagePath)

      return storage
    },
    createModels: async () => {
      return setup.models.runtime
    },
    createSystemdOps: async () => {
      return setup.systemd.ops
    },
    pollMs: 20,
    draftPrDelivery: overrides.draftPrDelivery ?? false,
    ...overrides
  })

  async function stop() {
    controller.abort()

    return withTimeout(done, 'runner stop')
  }

  return { done, controller, stop, storageOpened }
}

export async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = STOP_TIMEOUT_MS) {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out: ${label}`))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// runner を止め、偽物の systemd の印の付いた process を止めて、一時 directory を消す
export async function teardownRunner(setup: RunnerSetup, runner?: StartedRunner) {
  try {
    if (runner !== undefined) {
      runner.controller.abort()
      await withTimeout(runner.done, 'runner stop').catch(() => {})
    }

    await setup.systemd.ops.stopScopes(scopePattern(setup.fixture.hash))
  } finally {
    await removeRunnerFixture(setup.fixture)
  }
}

// CLI と同じく、runner とは別の接続で台帳を開く
export function openLedger(setup: RunnerSetup) {
  return openTaskLedger(setup.fixture.dataDir)
}

export async function waitForTaskStatus(setup: RunnerSetup, taskId: number, statuses: readonly string[], timeoutMs = 30_000) {
  const ledger = openLedger(setup)

  try {
    await waitUntil(() => {
      return statuses.includes(ledger.getTask(taskId).status)
    }, `Task ${taskId} becomes ${statuses.join(' or ')}`, timeoutMs)

    return ledger.showTask(taskId, { events: 500 })
  } finally {
    ledger.close()
  }
}

export async function readRunnerLog(fixture: RunnerFixture) {
  try {
    return await fs.readFile(path.join(fixture.dataDir, 'logs', 'runner.log'), 'utf8')
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseLogLines(text: string) {
  return text.split('\n').filter((line) => {
    return line !== ''
  }).map((line) => {
    const value: unknown = JSON.parse(line)

    return isRecord(value) ? value : {}
  })
}
