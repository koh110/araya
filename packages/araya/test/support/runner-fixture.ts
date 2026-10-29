import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createRegistry, Harness, type SettledTask } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import type { DevelopmentModel } from '../../src/config/model.ts'
import { collectSecretValues } from '../../src/infrastructure/redaction.ts'
import { dataDirHash, scopePattern, type SystemdOps } from '../../src/infrastructure/systemd.ts'
import {
  AttemptsDoc,
  buildAttemptInput,
  createShikiExtension,
  type AttemptFaults,
  type AttemptInput,
  type PiModelSettings
} from '../../src/runner/attempt.ts'
import { openTaskLedger, type AttemptResult, type AttemptSettings, type TaskInput } from '../../src/runner/ledger.ts'

// 試行の task の test の fixture（一時 dataDir、開発 root と git の repository、Pi の agentDir）と、
// runner の loop の代わりに試行を1件ずつ動かす小さな driver（台帳で取り込み → root の commit で task と document → 終わりを待つ）

export const ctx = BACKGROUND_CONTEXT
const WAIT_TIMEOUT_MS = 60_000

export type RunnerFixture = Awaited<ReturnType<typeof createRunnerFixture>>

// git の author の値は 8 文字未満にする（名前に AUTH を含む変数の値は、8 文字以上だと秘密として置き換えられる）
export async function createRunnerFixture(extraEnv: Record<string, string> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-attempt-test-')))
  const home = path.join(root, 'home')
  const devRoot = path.join(root, 'dev')
  const dataDir = path.join(root, 'data')
  const agentDir = path.join(root, 'pi-agent')
  const gitConfig = path.join(home, 'gitconfig')
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.mkdir(dataDir, { mode: 0o700 })
  await fs.mkdir(agentDir)
  await fs.writeFile(gitConfig, '', 'utf8')
  await fs.writeFile(path.join(agentDir, 'auth.json'), '{}\n', { encoding: 'utf8', mode: 0o600 })
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Araya',
    GIT_AUTHOR_EMAIL: 'a@e.io',
    GIT_COMMITTER_NAME: 'Araya',
    GIT_COMMITTER_EMAIL: 'a@e.io',
    PI_CODING_AGENT_DIR: agentDir,
    ...extraEnv
  }

  return { root, home, devRoot, dataDir, agentDir, env, hash: dataDirHash(dataDir) }
}

export async function removeRunnerFixture(fixture: RunnerFixture) {
  await fs.rm(fixture.root, { recursive: true, force: true })
}

export function git(fixture: RunnerFixture, cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export async function createRepository(fixture: RunnerFixture, name: string) {
  const repositoryPath = path.join(fixture.devRoot, name)
  await fs.mkdir(repositoryPath)
  git(fixture, repositoryPath, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# fixture\n', 'utf8')
  git(fixture, repositoryPath, 'add', '--all')
  git(fixture, repositoryPath, 'commit', '-q', '-m', 'initial fixture')

  return repositoryPath
}

export function taskInput(overrides: Partial<TaskInput> = {}) {
  const input: TaskInput = {
    title: 'README を直す',
    goal: 'README に1行足し、検証を登録する',
    constraints: [],
    targets: [],
    permissions: [],
    idempotencyKey: null,
    ...overrides
  }

  return input
}

export function defaultSettings(fixture: RunnerFixture, model: DevelopmentModel | null) {
  const settings: AttemptSettings = {
    devRoot: fixture.devRoot,
    agentDir: fixture.agentDir,
    model,
    timeoutMs: 600_000,
    verificationTimeoutMs: 10_000
  }

  return settings
}

function withTimeout<T>(promise: Promise<T>, label: string) {
  let timer: NodeJS.Timeout | undefined

  return Promise.race([
    promise.finally(() => {
      clearTimeout(timer)
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out: ${label}`))
      }, WAIT_TIMEOUT_MS)
    })
  ])
}

export async function waitUntil(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs

  while (!await condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${label}`)
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
}

export type AttemptHarnessOptions = {
  models: ModelRuntime
  systemd: Pick<SystemdOps, 'launchInScope' | 'bashScopeCommand' | 'stopScopes'>
  faults?: AttemptFaults
  createPiSettings?: (stateDir: string, agentDir: string) => PiModelSettings
  draftPrDelivery?: boolean
}

// 試行の task を動かす Harness を開く。runner と同じく、storage は <dataDir>/runner/durable.sqlite
export async function openAttemptHarness(fixture: RunnerFixture, options: AttemptHarnessOptions) {
  const secretValues = collectSecretValues(fixture.env)
  const ledger = openTaskLedger(fixture.dataDir, { secretValues })
  const logs: Record<string, unknown>[] = []
  const reports: { type: string; message: string }[] = []
  const { extension, attemptTask } = createShikiExtension({
    dataDir: fixture.dataDir,
    hash: fixture.hash,
    ledger,
    systemd: options.systemd,
    models: options.models,
    env: fixture.env,
    draftPrDelivery: options.draftPrDelivery ?? false,
    secretValues,
    log: (entry) => {
      logs.push(entry)
    },
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.createPiSettings === undefined ? {} : { createPiSettings: options.createPiSettings })
  })
  const registry = createRegistry()
  registry.install(extension)
  const storageDir = path.join(fixture.dataDir, 'runner')
  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(storageDir, 'durable.sqlite')), {
    models: options.models,
    registry,
    env: ({ cwd }) => {
      return new NodeExecutionEnv({ cwd: cwd ?? fixture.devRoot, shellEnv: fixture.env })
    },
    onReport: (error, info) => {
      reports.push({ type: info.type, message: error instanceof Error ? error.message : String(error) })
    }
  }, ctx)
  harness.resume()

  // 台帳で取り込み、試行の task を作る（Phase 4 の runner の取り込みの手順 2・3 と同じ）
  async function startAttempt(input: TaskInput, settings: AttemptSettings, mutate?: (attemptInput: AttemptInput) => AttemptInput) {
    const created = ledger.createTask(input)
    const claimed = ledger.claimNextAttempt(1, settings)

    if (claimed === null) {
      throw new Error('no attempt was claimed')
    }

    const attemptInput = mutate === undefined ? buildAttemptInput(claimed) : mutate(buildAttemptInput(claimed))
    const root = await harness.root(ctx)
    const taskId = await root.commit(async (tx) => {
      const id = await tx.createTask(attemptTask, attemptInput, { ownership: { kind: 'conversation' }, background: true })
      const attempts = await tx.doc(AttemptsDoc)
      attempts.byTaskKey[claimed.taskKey] = { taskId: id }

      return id
    }, ctx)

    return { taskId, taskKey: claimed.taskKey, ledgerTaskId: created.task.id, attemptInput }
  }

  // 試行の task の終わりを待ち、outcome の result を台帳に記録する
  async function finishAttempt(started: Awaited<ReturnType<typeof startAttempt>>) {
    const settled: SettledTask<AttemptResult> = await withTimeout(harness.waitForTask(started.taskId, ctx), started.taskKey)
    const outcome = settled.state.outcome
    const result = outcome.status === 'completed' || outcome.status === 'aborted' ? outcome.result : undefined

    if (result !== undefined) {
      ledger.recordResult(started.taskKey, result, { taskKey: started.taskKey, addMs: 0 })
    }

    return { ...started, outcome, result }
  }

  async function runAttempt(input: TaskInput, settings: AttemptSettings, mutate?: (attemptInput: AttemptInput) => AttemptInput) {
    return finishAttempt(await startAttempt(input, settings, mutate))
  }

  async function close() {
    await harness.close(ctx)
    await options.systemd.stopScopes(scopePattern(fixture.hash))
    ledger.close()
  }

  return { harness, ledger, logs, reports, attemptTask, startAttempt, finishAttempt, runAttempt, close, secretValues }
}
