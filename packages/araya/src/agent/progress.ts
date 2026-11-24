import { createHash } from 'node:crypto'

import type { Context, JsonValue } from '@earendil-works/chord'
import {
  defineDoc,
  LiveDoc,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type DocumentWatch,
  type Harness,
  type TaskGraph,
  type TaskGraphWatch,
  type ConversationWatch,
} from '@earendil-works/pi-durable'

export type ProgressOperation =
  | 'generation'
  | 'read'
  | 'write'
  | 'edit'
  | 'bash'
  | 'task'
  | 'compaction'
  | 'waiting'
  | 'preparing'
  | 'other'

export type ProgressActivity = {
  operation: ProgressOperation
  phaseStartedAtMs: number | null
  phaseStartedAtIsEstimated: boolean
  requestStartedAtMs?: number | null
}

export type ProgressSnapshot = {
  main: ProgressActivity | null
  children: readonly (ProgressActivity & { name: string })[]
}

export type SubagentRecord = { conversationId: ConversationId; updatedAt: number }
export type SubagentsState = { agents: Record<string, SubagentRecord> }

export const SubagentsDoc = defineDoc<SubagentsState>({
  kind: 'araya.subagents',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  initial: () => {
    return { agents: {} }
  },
  checkpointWhen: () => {
    return false
  },
})

export const PROGRESS_OPERATION_LABELS: Record<ProgressOperation, string> = {
  generation: 'モデル応答を生成中',
  read: 'ファイルを読み取り中',
  write: 'ファイルを書き込み中',
  edit: 'ファイルを編集中',
  bash: 'コマンドを実行中',
  task: 'background task を操作中',
  compaction: '会話文脈を整理中',
  waiting: 'ツールの実行待ち',
  preparing: '次の処理を準備中',
  other: 'その他の処理中',
}

type LiveSignal = {
  operation: ProgressOperation
  runKey: string
  eventKey: string
}

type TrackedActivity = ProgressActivity & {
  runKey: string
  eventKey: string
}

type TrackedConversation = {
  id: ConversationId
  kind: 'main' | 'child'
  notifyInitial: boolean
  current: TrackedActivity | null
  lastNotifiedOperation: ProgressOperation | null
}

type ChildMetadata = {
  name: string
  requestStartedAtMs: number
}

type ProgressMonitorInput = {
  harness: Pick<Harness, 'getTask' | 'watchDoc' | 'watchTaskGraph'> & {
    conversation(
      id: ConversationId,
      context: Context,
    ): Promise<Pick<Conversation, 'id' | 'watch'> | undefined>
  }
  root: Pick<Conversation, 'id' | 'watch'>
  context: Context
  deliverProgress?: (text: string, nonce: string) => Promise<void>
  log?: (entry: Record<string, unknown>) => void
  nowMs?: () => number
}

export type ArayaProgressMonitor = {
  snapshot(): ProgressSnapshot
  registerChild(name: string, conversationId: ConversationId, requestStartedAtMs: number): void
  close(): Promise<void>
}

function asObject(value: JsonValue | undefined) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  return value
}

function asArray(value: JsonValue | undefined) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
}

function fieldString(object: ReturnType<typeof asObject>, key: string) {
  const value = object?.[key]

  return typeof value === 'string' ? value : undefined
}

function fieldKey(object: ReturnType<typeof asObject>, key: string) {
  const value = object?.[key]

  if (typeof value === 'string' || typeof value === 'number') {
    return value.toString()
  }

  return undefined
}

function operationForTool(name: string) {
  if (name === 'read') {
    return 'read' satisfies ProgressOperation
  }

  if (name === 'write') {
    return 'write' satisfies ProgressOperation
  }

  if (name === 'edit') {
    return 'edit' satisfies ProgressOperation
  }

  if (name === 'bash') {
    return 'bash' satisfies ProgressOperation
  }

  if (name === 'task') {
    return 'task' satisfies ProgressOperation
  }

  return 'other' satisfies ProgressOperation
}

function toolSignal(
  value: JsonValue | undefined,
  runKey: string,
  wantedStatus: 'running' | 'pending',
) {
  const slots = asArray(value)

  for (const [index, candidate] of slots.entries()) {
    const slot = asObject(candidate)

    if (slot === undefined || fieldString(slot, 'status') !== wantedStatus) {
      continue
    }

    const name = fieldString(slot, 'name')

    if (name === undefined) {
      continue
    }

    return {
      operation: wantedStatus === 'running' ? operationForTool(name) : 'waiting',
      runKey,
      eventKey: `tool:${fieldString(slot, 'callId') ?? index.toString()}`,
    } satisfies LiveSignal
  }

  return undefined
}

function liveSignal(view: ConversationView, conversationId: ConversationId) {
  const live = asObject(view.docs[LiveDoc.definition.kind])
  const run = asObject(live?.run)

  if (live === undefined || run === undefined) {
    return null
  }

  const inputIds: string[] = []

  for (const value of asArray(run.inputs)) {
    if (typeof value === 'string' || typeof value === 'number') {
      inputIds.push(value.toString())
    }
  }

  const runKey = `${conversationId.toString()}:${inputIds.length > 0 ? inputIds.join(',') : (fieldKey(run, 'taskId') ?? 'active')}`
  const compactions = asArray(live.compactions)

  if (compactions.length > 0) {
    return {
      operation: 'compaction',
      runKey,
      eventKey: `compaction:${fieldKey(asObject(compactions[0]), 'taskId') ?? 'active'}`,
    } satisfies LiveSignal
  }

  const nestedTool = toolSignal(live.nestedTools, runKey, 'running')

  if (nestedTool !== undefined) {
    return nestedTool
  }

  const runningTool = toolSignal(live.tools, runKey, 'running')

  if (runningTool !== undefined) {
    return runningTool
  }

  const generation = asObject(live.generation)

  if (generation !== undefined) {
    return {
      operation: 'generation',
      runKey,
      eventKey: `generation:${fieldKey(generation, 'attempt') ?? 'active'}`,
    } satisfies LiveSignal
  }

  const pendingTool =
    toolSignal(live.nestedTools, runKey, 'pending') ?? toolSignal(live.tools, runKey, 'pending')

  if (pendingTool !== undefined) {
    return { ...pendingTool, operation: 'waiting' } satisfies LiveSignal
  }

  return { operation: 'preparing', runKey, eventKey: `preparing:${runKey}` } satisfies LiveSignal
}

function progressNonce(signal: LiveSignal, conversationId: ConversationId) {
  return `araya-progress-${createHash('sha256')
    .update(`${conversationId.toString()}:${signal.runKey}:${signal.eventKey}:${signal.operation}`)
    .digest('hex')
    .slice(0, 8)}`
}

function safeLog(log: ProgressMonitorInput['log'], entry: Record<string, unknown>) {
  try {
    log?.(entry)
  } catch {
    // progress 通知と診断の失敗で会話処理を止めない
  }
}

export async function createArayaProgressMonitor(input: ProgressMonitorInput) {
  let closed = false
  let ready = false
  let graph: TaskGraph | undefined
  let mainWatch: ConversationWatch | undefined
  let graphWatch: TaskGraphWatch | undefined
  let subagentsWatch: DocumentWatch<SubagentsState> | undefined
  let childSyncTail = Promise.resolve()
  const main: TrackedConversation = createTracker(input.root.id, 'main', false)
  const childMetadata = new Map<ConversationId, ChildMetadata>()
  const newlyRegisteredChildren = new Set<ConversationId>()
  const activeChildIds = new Set<ConversationId>()
  const childTrackers = new Map<ConversationId, TrackedConversation>()
  const childWatches = new Map<ConversationId, ConversationWatch>()
  const attachingChildren = new Set<ConversationId>()
  const pendingDeliveries = new Set<Promise<void>>()
  const deliveryTails = new Map<ConversationId, Promise<void>>()

  function createTracker(id: ConversationId, kind: 'main' | 'child', notifyInitial: boolean) {
    return { id, kind, notifyInitial, current: null, lastNotifiedOperation: null }
  }

  function notify(state: TrackedConversation, signal: LiveSignal) {
    const deliver = input.deliverProgress

    if (deliver === undefined) {
      return
    }

    const content = `${state.kind === 'child' ? 'background task: ' : ''}${PROGRESS_OPERATION_LABELS[signal.operation]}`
    const nonce = progressNonce(signal, state.id)
    const delivery = (deliveryTails.get(state.id) ?? Promise.resolve())
      .then(async () => {
        await deliver(content, nonce)
      })
      .catch(() => {
        safeLog(input.log, {
          type: 'discord_progress_delivery_failed',
          operation: signal.operation,
        })
      })

    deliveryTails.set(state.id, delivery)
    pendingDeliveries.add(delivery)
    void delivery.then(() => {
      pendingDeliveries.delete(delivery)

      if (deliveryTails.get(state.id) === delivery) {
        deliveryTails.delete(state.id)
      }
    })
  }

  function applyView(state: TrackedConversation, view: ConversationView, initial: boolean) {
    const signal = liveSignal(view, state.id)

    if (signal === null) {
      state.current = null
      state.lastNotifiedOperation = null
      state.notifyInitial = false

      return
    }

    const previous = state.current
    const suppressInitial = initial && !state.notifyInitial

    if (previous === null || previous.runKey !== signal.runKey) {
      state.lastNotifiedOperation = null
    }

    state.current = {
      ...signal,
      phaseStartedAtMs:
        previous !== null &&
        previous.operation === signal.operation &&
        previous.eventKey === signal.eventKey
          ? previous.phaseStartedAtMs
          : (input.nowMs ?? Date.now)(),
      phaseStartedAtIsEstimated: true,
    }

    if (suppressInitial) {
      state.lastNotifiedOperation = signal.operation
    }

    if (
      !suppressInitial &&
      signal.operation !== 'waiting' &&
      signal.operation !== 'preparing' &&
      signal.operation !== 'generation' &&
      signal.operation !== state.lastNotifiedOperation
    ) {
      state.lastNotifiedOperation = signal.operation
      notify(state, signal)
    }

    state.notifyInitial = false
  }

  async function childIdsInGraph(nextGraph: TaskGraph) {
    const ids = new Set<string>()

    for (const node of Object.values(nextGraph.tasks)) {
      if (
        node.kind !== 'araya-task-report' ||
        !('phase' in node.state) ||
        node.state.phase !== 'deliver'
      ) {
        continue
      }

      const childId = fieldKey(
        asObject((await input.harness.getTask(node.id, input.context))?.input),
        'childConversationId',
      )

      if (childId !== undefined) {
        ids.add(childId)
      }
    }

    return ids
  }

  function reconcileAgents(agents: Readonly<Record<string, SubagentRecord>>, allowNew: boolean) {
    const next = new Map<ConversationId, ChildMetadata>()

    for (const [name, record] of Object.entries(agents)) {
      next.set(record.conversationId, { name, requestStartedAtMs: record.updatedAt })
    }

    if (allowNew && ready) {
      for (const id of next.keys()) {
        if (!childMetadata.has(id)) {
          newlyRegisteredChildren.add(id)
        }
      }
    }

    for (const id of newlyRegisteredChildren) {
      if (!next.has(id)) {
        newlyRegisteredChildren.delete(id)
      }
    }

    childMetadata.clear()

    for (const [id, metadata] of next) {
      childMetadata.set(id, metadata)
    }
  }

  async function attachChild(id: ConversationId) {
    const conversation = await input.harness.conversation(id, input.context)

    if (conversation === undefined) {
      return
    }

    const watch = await conversation.watch(input.context, { min: 1, max: 1 })

    if (closed || childMetadata.get(id) === undefined || !activeChildIds.has(id)) {
      await watch.stop()

      return
    }

    const state: TrackedConversation = createTracker(id, 'child', newlyRegisteredChildren.has(id))
    childTrackers.set(id, state)
    childWatches.set(id, watch)
    applyView(state, watch.value, true)
    newlyRegisteredChildren.delete(id)
    watch.start(async (call) => {
      if (closed || call.kind !== 'value') {
        return
      }

      if (childMetadata.has(id)) {
        await applyView(state, call.value, false)
      }
    })
  }

  async function reconcileChildWatches() {
    if (closed || graph === undefined) {
      return
    }

    const graphIds = await childIdsInGraph(graph)
    activeChildIds.clear()

    for (const id of childMetadata.keys()) {
      if (graphIds.has(id.toString())) {
        activeChildIds.add(id)
      }
    }

    for (const [id, watch] of childWatches) {
      if (!activeChildIds.has(id)) {
        childWatches.delete(id)
        childTrackers.delete(id)
        void watch.stop().catch(() => {})
      }
    }

    for (const id of activeChildIds) {
      if (childTrackers.has(id)) {
        continue
      }

      if (attachingChildren.has(id)) {
        continue
      }

      attachingChildren.add(id)

      try {
        await attachChild(id)
      } catch {
        safeLog(input.log, { type: 'discord_progress_watch_failed', source: 'child' })
      } finally {
        attachingChildren.delete(id)
      }
    }
  }

  function queueChildReconciliation() {
    childSyncTail = childSyncTail
      .then(async () => {
        await reconcileChildWatches()
      })
      .catch(() => {
        safeLog(input.log, { type: 'discord_progress_watch_failed', source: 'children' })
      })

    return childSyncTail
  }

  function registerChild(name: string, conversationId: ConversationId, requestStartedAtMs: number) {
    if (ready && !childTrackers.has(conversationId)) {
      newlyRegisteredChildren.add(conversationId)
    }

    childMetadata.set(conversationId, { name, requestStartedAtMs })

    void queueChildReconciliation()
  }

  async function close() {
    if (closed) {
      return
    }

    closed = true
    await childSyncTail.catch(() => {})

    const stops: Promise<unknown>[] = []

    if (mainWatch !== undefined) {
      stops.push(mainWatch.stop())
    }

    if (graphWatch !== undefined) {
      stops.push(graphWatch.stop())
    }

    if (subagentsWatch !== undefined) {
      stops.push(subagentsWatch.stop())
    }

    for (const watch of childWatches.values()) {
      stops.push(watch.stop())
    }

    await Promise.allSettled(stops)
    pendingDeliveries.clear()
    deliveryTails.clear()
  }

  try {
    mainWatch = await input.root.watch(input.context, { min: 1, max: 1 })
    applyView(main, mainWatch.value, true)
    mainWatch.start(async (call) => {
      if (closed || call.kind !== 'value') {
        return
      }

      applyView(main, call.value, false)
    })

    graphWatch = await input.harness.watchTaskGraph(input.context)
    graph = graphWatch.value
    graphWatch.start(async (call) => {
      if (closed || call.kind !== 'value') {
        return
      }

      graph = call.value
      await queueChildReconciliation()
    })

    subagentsWatch = await input.harness.watchDoc(SubagentsDoc, input.root.id, input.context)

    if (subagentsWatch !== undefined) {
      reconcileAgents(subagentsWatch.value.agents, false)
      subagentsWatch.start(async (call) => {
        if (closed || call.kind !== 'value') {
          return
        }

        reconcileAgents(call.value.agents, true)
        await queueChildReconciliation()
      })
    }

    ready = true
    await queueChildReconciliation()
  } catch (error) {
    await close()
    throw error
  }

  return {
    snapshot: () => {
      const currentMain = main.current
      const children: (ProgressActivity & { name: string })[] = []

      for (const id of activeChildIds) {
        const metadata = childMetadata.get(id)

        if (metadata === undefined) {
          continue
        }

        const activity = childTrackers.get(id)?.current

        children.push({
          name: metadata.name,
          operation: activity?.operation ?? 'preparing',
          phaseStartedAtMs: activity?.phaseStartedAtMs ?? null,
          phaseStartedAtIsEstimated: activity?.phaseStartedAtIsEstimated ?? false,
          requestStartedAtMs: metadata.requestStartedAtMs,
        })
      }

      children.sort((left, right) => {
        if (left.name < right.name) {
          return -1
        }

        if (left.name > right.name) {
          return 1
        }

        return 0
      })

      return {
        main:
          currentMain === null
            ? null
            : {
                operation: currentMain.operation,
                phaseStartedAtMs: currentMain.phaseStartedAtMs,
                phaseStartedAtIsEstimated: currentMain.phaseStartedAtIsEstimated,
              },
        children,
      }
    },
    registerChild,
    close,
  }
}

export async function createArayaProgressMonitorBestEffort(input: ProgressMonitorInput) {
  try {
    return await createArayaProgressMonitor(input)
  } catch {
    safeLog(input.log, { type: 'discord_progress_monitor_initialization_failed' })

    return undefined
  }
}
