import fs from 'node:fs/promises'
import path from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { SettledTask } from '@earendil-works/pi-durable'

import { loadConfig } from '../config/environment.ts'
import { openControlPlane, type OpportunitySummary } from './store.ts'
import { formatModel } from '../config/model.ts'
import { ensureScoutTask, openArayaRuntime, MAIN_GOAL_ID, readTaskGraph } from './runtime.ts'
import { TASK_NAMES, type ScoutResult } from './tasks.ts'

export type ArayaConfig = ReturnType<typeof loadConfig>

export type StatusSnapshot = {
  capturedAt: number
  config: {
    dataDir: string
    configPath: string
    developmentModel: { model: string; thinkingLevel: string | null } | null
    inboxDir: string
    statusFile: string
    controlPlanePath: string
    piDurablePath: string
    intervalMs: number
    maxActions: number
  }
  controlPlane: OpportunitySummary
  activeTasks: {
    id: string
    kind: string
    phase: string
    status: string
  }[]
  tick?: TickResult
}

export type TickResult = {
  status: 'idle' | 'due' | 'failed'
  tickId: string
  capturedAt: number
  goalId: string
  taskId?: string
  settled?: SettledTask<ScoutResult>
  error?: string
}

// model が実際に使えるかは表示しない（status は Pi の認証を読まない）
function publicConfig(config: ArayaConfig) {
  const developmentModel = config.developmentModel

  return {
    dataDir: config.dataDir,
    configPath: config.configPath,
    developmentModel: developmentModel === null
      ? null
      : { model: formatModel(developmentModel), thinkingLevel: developmentModel.thinkingLevel },
    inboxDir: config.inboxDir,
    statusFile: config.statusFile,
    controlPlanePath: config.controlPlanePath,
    piDurablePath: config.piDurablePath,
    intervalMs: config.intervalMs,
    maxActions: config.maxActions
  }
}

export async function writeStatusFile(config: ArayaConfig, snapshot: StatusSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(config.statusFile), { recursive: true })
  await fs.writeFile(config.statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

async function collectStatus(config: ArayaConfig, capturedAt = Date.now()): Promise<StatusSnapshot> {
  const runtime = await openArayaRuntime(config, { resumeTasks: false })

  try {
    const graphState = await readTaskGraph(runtime.harness)
    const graph = graphState.value
    graphState.dispose()

    const activeTasks = Object.values(graph.tasks).map((node) => {
      const state = node.state

      return {
        id: String(node.id),
        kind: node.kind,
        phase: 'phase' in state ? state.phase : '',
        status: state.status
      }
    })

    return {
      capturedAt,
      config: publicConfig(config),
      controlPlane: runtime.controlPlane.summarize(config.maxActions),
      activeTasks
    }
  } finally {
    await runtime.close()
  }
}

export async function statusAraya(config: ArayaConfig): Promise<StatusSnapshot> {
  const snapshot = await collectStatus(config)
  await writeStatusFile(config, snapshot)

  return snapshot
}

export async function initAraya(config: ArayaConfig): Promise<StatusSnapshot> {
  await fs.mkdir(config.inboxDir, { recursive: true })
  await fs.mkdir(path.dirname(config.statusFile), { recursive: true })

  const seedPath = path.join(config.inboxDir, 'seed.jsonl')
  const seedCandidates = [
    {
      id: 'candidate:design-review',
      kind: 'investigate',
      title: '設計方針と現在の実装の対応を点検する',
      risk: 'read-only',
      payload: {
        source: 'design-notes',
        goal: '採用済み要件と現在の実装との差分を確認する'
      }
    },
    {
      id: 'candidate:notification-visibility',
      kind: 'investigate',
      title: '活動状況を利用者へ見えるようにする経路を点検する',
      risk: 'read-only',
      payload: {
        source: 'demo',
        goal: '通知経路が未接続の場合に状態を pending として保持する'
      }
    },
    {
      id: 'candidate:external-action-gate',
      kind: 'validate',
      title: '外部書き込み候補を人間承認へ送る流れを確認する',
      risk: 'external',
      payload: {
        source: 'demo',
        goal: '実行機能がない場合に承認済み候補を自動実行しない'
      }
    }
  ]

  try {
    await fs.writeFile(
      seedPath,
      `${seedCandidates.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error
    }
  }

  const runtime = await openArayaRuntime(config, { resumeTasks: false })

  try {
    runtime.controlPlane.ensureGoal(MAIN_GOAL_ID, '常時 scout', config.intervalMs, Date.now())
  } finally {
    await runtime.close()
  }

  return statusAraya(config)
}

export async function tickAraya(config: ArayaConfig): Promise<TickResult> {
  const now = Date.now()
  const tickId = `tick:${now}`
  const runtime = await openArayaRuntime(config)

  try {
    runtime.controlPlane.ensureGoal(MAIN_GOAL_ID, '常時 scout', config.intervalMs, now)
    const dueGoalIds = runtime.controlPlane.dueGoalIds(Date.now())

    if (dueGoalIds.length === 0) {
      return {
        status: 'idle',
        tickId,
        capturedAt: Date.now(),
        goalId: MAIN_GOAL_ID
      }
    }

    const taskId = await ensureScoutTask(runtime, {
      tickId,
      maxActions: config.maxActions
    })
    const settled = await runtime.harness.waitForTask(taskId, BACKGROUND_CONTEXT)
    const outcomeStatus = settled.state.outcome.status

    return {
      status: outcomeStatus === 'completed' ? 'due' : 'failed',
      tickId,
      capturedAt: Date.now(),
      goalId: MAIN_GOAL_ID,
      taskId: String(taskId),
      settled
    }
  } catch (error) {
    runtime.controlPlane.appendEvent(
      'tick.failed',
      'tick',
      tickId,
      { error: error instanceof Error ? error.message : String(error) },
      Date.now()
    )

    return {
      status: 'failed',
      tickId,
      capturedAt: Date.now(),
      goalId: MAIN_GOAL_ID,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await runtime.close()
  }
}

export async function runAraya(config: ArayaConfig): Promise<void> {
  let stopped = false
  let resumeAfterWait: (() => void) | undefined

  const stop = () => {
    stopped = true
    resumeAfterWait?.()
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    while (!stopped) {
      const result = await tickAraya(config)
      const snapshot = await collectStatus(config, Date.now())
      await writeStatusFile(config, { ...snapshot, tick: result })

      if (stopped) {
        break
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resumeAfterWait = undefined
          resolve()
        }, Math.max(1000, config.intervalMs))

        resumeAfterWait = () => {
          clearTimeout(timer)
          resumeAfterWait = undefined
          resolve()
        }
      })
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export function approveOpportunity(config: ArayaConfig, opportunityId: string, note: string) {
  const controlPlane = openControlPlane(config.controlPlanePath)

  try {
    return controlPlane.recordDecision(opportunityId, 'approved', 'user', note, Date.now())
  } finally {
    controlPlane.close()
  }
}

export function rejectOpportunity(config: ArayaConfig, opportunityId: string, note: string) {
  const controlPlane = openControlPlane(config.controlPlanePath)

  try {
    return controlPlane.recordDecision(opportunityId, 'rejected', 'user', note, Date.now())
  } finally {
    controlPlane.close()
  }
}

export async function showTaskNames(): Promise<string[]> {
  return [TASK_NAMES.scout, TASK_NAMES.work]
}
