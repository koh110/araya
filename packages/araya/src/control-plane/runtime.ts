import fs from 'node:fs/promises'
import path from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AttachedReplicatedState, Context } from '@earendil-works/chord'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  createRegistry,
  defineExtension,
  Harness,
  type TaskGraph,
  type TaskId
} from '@earendil-works/pi-durable'

import { openControlPlane, type ControlPlane } from './store.ts'
import { createArayaTasks, TASK_NAMES, type ArayaTasks, type ScoutInput, type ScoutResult } from './tasks.ts'

export const MAIN_GOAL_ID = 'araya:goal:main'

export type ArayaRuntime = {
  controlPlane: ControlPlane
  tasks: ArayaTasks
  harness: Harness
  root: Awaited<ReturnType<Harness['root']>>
  close: () => Promise<void>
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export async function createArayaModelRuntime(agentDir?: string) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const options = agentDir === undefined
    ? {}
    : {
        authPath: path.join(agentDir, 'auth.json'),
        modelsPath: path.join(agentDir, 'models.json')
      }

  return ModelRuntime.create({ refreshOnCreate: false, ...options })
}

export async function openArayaRuntime(
  config: {
    controlPlanePath: string
    inboxDir: string
    piDurablePath: string
    intervalMs: number
    piAgentDir?: string
  },
  options: { resumeTasks?: boolean } = {}
): Promise<ArayaRuntime> {
  await ensureParentDir(config.controlPlanePath)
  await ensureParentDir(config.piDurablePath)

  const controlPlane = openControlPlane(config.controlPlanePath)
  const tasks = createArayaTasks(
    controlPlane,
    config.inboxDir,
    MAIN_GOAL_ID,
    config.intervalMs
  )

  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  const storage = await openNodeSqliteStorage(config.piDurablePath)
  const registry = createRegistry()

  registry.install(
    defineExtension({
      name: 'araya',
      tasks: [tasks.ScoutTask, tasks.WorkTask]
    })
  )

  const models = options.resumeTasks === false ? createModels() : await createArayaModelRuntime(config.piAgentDir)
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      onReport: (error: unknown) => {
        console.error('[pi-durable report]', error)
      }
    },
    BACKGROUND_CONTEXT
  )

  if (options.resumeTasks !== false) {
    await harness.resume()
  }
  const root = await harness.root(BACKGROUND_CONTEXT)

  return {
    controlPlane,
    tasks,
    harness,
    root,
    close: async () => {
      await harness.close(BACKGROUND_CONTEXT)
      controlPlane.close()
    }
  }
}

export async function readTaskGraph(harness: Harness): Promise<AttachedReplicatedState<TaskGraph>> {
  return harness.taskGraph(BACKGROUND_CONTEXT)
}

export async function ensureScoutTask(
  runtime: ArayaRuntime,
  input: ScoutInput,
  context: Context = BACKGROUND_CONTEXT
): Promise<TaskId<ScoutResult>> {
  const graphState = await runtime.harness.taskGraph(context)
  const graph = graphState.value
  graphState.dispose()
  const activeScout = Object.values(graph.tasks).find((node) => node.kind === TASK_NAMES.scout)

  if (activeScout !== undefined) {
    return activeScout.id as TaskId<ScoutResult>
  }

  return runtime.root.commit(
    (tx) => tx.createTask(runtime.tasks.ScoutTask, input, {
      ownership: { kind: 'conversation' }
    }),
    context
  )
}
