import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import type { WatchEnd } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  type JsonObject,
  type TaskGraph,
  type TaskGraphNode,
  type TaskGraphWatch,
  type TaskId,
} from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'

import { createArayaProgressMonitor, PROGRESS_OPERATION_LABELS } from './progress.ts'

function liveView(live: JsonObject) {
  return {
    conversation: { id: ROOT_CONVERSATION_ID },
    entries: [],
    docs: { [LiveDoc.definition.kind]: live },
  } satisfies ConversationView
}

const testIdStorage = new MemoryStorage()
const CHILD_CONVERSATION_ID = await testIdStorage.mintId<ConversationId>()
const REPORT_TASK_ID = await testIdStorage.mintId<TaskId>()
const NEXT_REPORT_TASK_ID = await testIdStorage.mintId<TaskId>()
const stopped = { kind: 'stopped' } satisfies WatchEnd

function makeConversationWatch(value: ConversationView) {
  let listener: Parameters<ConversationWatch['start']>[0] | undefined

  return {
    watch: {
      value,
      start: (next) => {
        listener = next
      },
      stop: async () => {
        return stopped
      },
      closed: Promise.resolve(stopped),
    } satisfies ConversationWatch,
    update: async (next: ConversationView) => {
      if (listener === undefined) {
        throw new Error('Conversation watcher is not ready')
      }

      await listener({ kind: 'value', value: next, ops: [], retired: false }, BACKGROUND_CONTEXT)
    },
  }
}

function reportTaskGraph(taskId: TaskId, phase: string) {
  return {
    tasks: {
      [taskId.toString()]: {
        id: taskId,
        kind: 'araya-task-report',
        conversationId: ROOT_CONVERSATION_ID,
        background: true,
        abortRequested: false,
        state: { status: 'running', phase },
        conversations: [CHILD_CONVERSATION_ID],
      } satisfies TaskGraphNode,
    },
  } satisfies TaskGraph
}

function makeProgressFixture(
  input: {
    graph?: TaskGraph
    rootView?: ConversationView
    childView?: ConversationView
    deliverProgress?: (text: string) => Promise<void>
  } = {},
) {
  let graphListener: Parameters<TaskGraphWatch['start']>[0] | undefined
  let childWatchCount = 0
  const delivered: string[] = []
  const graphWatch: TaskGraphWatch = {
    value: input.graph ?? { tasks: {} },
    start: (listener) => {
      graphListener = listener
    },
    stop: async () => {
      return stopped
    },
    closed: Promise.resolve(stopped),
  }
  const rootWatch = makeConversationWatch(input.rootView ?? liveView({}))

  function childView(index: number) {
    return liveView({
      run: { inputs: [`child-run-${index}`] },
      tools: [{ status: 'running', name: 'bash', callId: `child-bash-${index}` }],
    })
  }

  return {
    monitorPromise: createArayaProgressMonitor({
      harness: {
        conversation: async (id) => {
          childWatchCount += 1

          return {
            id,
            watch: async () => {
              return makeConversationWatch(input.childView ?? childView(childWatchCount)).watch
            },
          }
        },
        getTask: async <Result>(id: TaskId<Result>) => {
          return {
            id,
            conversationId: ROOT_CONVERSATION_ID,
            kind: 'araya-task-report',
            version: 1,
            input: { childConversationId: CHILD_CONVERSATION_ID },
            background: true,
            abortRequested: false,
            state: { status: 'running' as const, checkpoint: { phase: 'deliver' } },
          }
        },
        watchDoc: async () => {
          return undefined
        },
        watchTaskGraph: async () => {
          return graphWatch
        },
      },
      root: {
        id: ROOT_CONVERSATION_ID,
        watch: async () => {
          return rootWatch.watch
        },
      },
      context: BACKGROUND_CONTEXT,
      deliverProgress: async (text) => {
        delivered.push(text)
        await input.deliverProgress?.(text)
      },
    }),
    delivered,
    childWatchCount: () => {
      return childWatchCount
    },
    updateGraph: async (graph: TaskGraph) => {
      if (graphListener === undefined) {
        throw new Error('Task graph watcher is not ready')
      }

      await graphListener(
        { kind: 'value', value: graph, ops: [], retired: false },
        BACKGROUND_CONTEXT,
      )
    },
    updateRoot: async (view: ConversationView) => {
      await rootWatch.update(view)
    },
  }
}

test('progress monitor: watch 開始時点ですでに進行中なら経過時間を推定し、同じ状態を再通知しない', async () => {
  const stopped = { kind: 'stopped' } satisfies WatchEnd
  let rootListener: Parameters<ConversationWatch['start']>[0] | undefined
  const rootWatch: ConversationWatch = {
    value: liveView({
      run: { inputs: ['initial-input'] },
      tools: [{ status: 'running', name: 'bash', callId: 'restored-tool' }],
    }),
    start: (listener) => {
      rootListener = listener
    },
    stop: async () => {
      return stopped
    },
    closed: Promise.resolve(stopped),
  }
  const graphWatch: TaskGraphWatch = {
    value: { tasks: {} },
    start: () => {},
    stop: async () => {
      return stopped
    },
    closed: Promise.resolve(stopped),
  }
  const delivered: string[] = []
  const monitor = await createArayaProgressMonitor({
    harness: {
      conversation: async () => {
        return undefined
      },
      getTask: async () => {
        return undefined
      },
      watchDoc: async () => {
        return undefined
      },
      watchTaskGraph: async () => {
        return graphWatch
      },
    },
    root: {
      id: ROOT_CONVERSATION_ID,
      watch: async () => {
        return rootWatch
      },
    },
    context: BACKGROUND_CONTEXT,
    nowMs: () => {
      return 123_456
    },
    deliverProgress: async (text) => {
      delivered.push(text)
    },
  })

  try {
    assert.equal(monitor.snapshot().main?.operation, 'bash')
    assert.equal(monitor.snapshot().main?.phaseStartedAtMs, 123_456)
    assert.equal(monitor.snapshot().main?.phaseStartedAtIsEstimated, true)
    assert.deepEqual(delivered, [])
    assert.ok(rootListener)
    await rootListener(
      {
        kind: 'value',
        value: rootWatch.value,
        ops: [],
        retired: false,
      },
      BACKGROUND_CONTEXT,
    )
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    assert.deepEqual(delivered, [])
  } finally {
    await monitor.close()
  }
})

test('progress monitor: 同じ child conversation への再依頼でも、新しい工程を通知する', async () => {
  const fixture = makeProgressFixture()
  const monitor = await fixture.monitorPromise

  try {
    monitor.registerChild('worker', CHILD_CONVERSATION_ID, 1_000)
    await fixture.updateGraph(reportTaskGraph(REPORT_TASK_ID, 'deliver'))
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    assert.equal(fixture.delivered.length, 1)

    await fixture.updateGraph({ tasks: {} })
    monitor.registerChild('worker', CHILD_CONVERSATION_ID, 2_000)
    await fixture.updateGraph(reportTaskGraph(NEXT_REPORT_TASK_ID, 'deliver'))
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    assert.equal(fixture.delivered.length, 2)
  } finally {
    await monitor.close()
  }
})

test('progress monitor: reporter が report phase に進んだ child を実行中 status から除外する', async () => {
  const fixture = makeProgressFixture({ graph: reportTaskGraph(REPORT_TASK_ID, 'report') })
  const monitor = await fixture.monitorPromise

  try {
    monitor.registerChild('worker', CHILD_CONVERSATION_ID, 1_000)
    await fixture.updateGraph(reportTaskGraph(REPORT_TASK_ID, 'report'))

    assert.deepEqual(monitor.snapshot().children, [])
    assert.equal(fixture.childWatchCount(), 0)
  } finally {
    await monitor.close()
  }
})

test('progress monitor: 処理観測前の child は汎用の準備中として表示する', async () => {
  const fixture = makeProgressFixture({
    graph: reportTaskGraph(REPORT_TASK_ID, 'deliver'),
    childView: liveView({}),
  })
  const monitor = await fixture.monitorPromise

  try {
    monitor.registerChild('worker', CHILD_CONVERSATION_ID, 1_000)
    await fixture.updateGraph(reportTaskGraph(REPORT_TASK_ID, 'deliver'))

    const child = monitor.snapshot().children[0]
    assert.ok(child)
    assert.equal(child.operation, 'preparing')
    assert.equal(PROGRESS_OPERATION_LABELS[child.operation], '次の処理を準備中')
  } finally {
    await monitor.close()
  }
})

test('progress monitor: 汎用待機と明示的なtool待機を別ラベルにする', async () => {
  const preparingMonitor = await makeProgressFixture({
    rootView: liveView({ run: { inputs: ['main-run'] } }),
  }).monitorPromise

  try {
    const main = preparingMonitor.snapshot().main
    assert.ok(main)
    assert.equal(main.operation, 'preparing')
    assert.equal(PROGRESS_OPERATION_LABELS[main.operation], '次の処理を準備中')
  } finally {
    await preparingMonitor.close()
  }

  const waitingMonitor = await makeProgressFixture({
    rootView: liveView({
      run: { inputs: ['main-run'] },
      tools: [{ status: 'pending', name: 'bash', callId: 'pending-bash' }],
    }),
  }).monitorPromise

  try {
    const main = waitingMonitor.snapshot().main
    assert.ok(main)
    assert.equal(main.operation, 'waiting')
    assert.equal(PROGRESS_OPERATION_LABELS[main.operation], 'ツールの実行待ち')
  } finally {
    await waitingMonitor.close()
  }
})

test('progress monitor: 同じ conversation の工程通知を作業順に直列配送する', async () => {
  let deliveryCalls = 0
  const firstDelivery = Promise.withResolvers<void>()
  const fixture = makeProgressFixture({
    rootView: liveView({
      run: { inputs: ['main-run'] },
      tools: [{ status: 'running', name: 'read', callId: 'first-read' }],
    }),
    deliverProgress: async () => {
      deliveryCalls += 1

      if (deliveryCalls === 1) {
        await firstDelivery.promise
      }
    },
  })
  await fixture.monitorPromise

  try {
    await fixture.updateRoot(
      liveView({
        run: { inputs: ['main-run'] },
        tools: [{ status: 'running', name: 'bash', callId: 'second-bash' }],
      }),
    )
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    assert.equal(deliveryCalls, 1)

    await fixture.updateRoot(
      liveView({
        run: { inputs: ['main-run'] },
        tools: [{ status: 'running', name: 'edit', callId: 'third-edit' }],
      }),
    )
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    assert.equal(deliveryCalls, 1)

    firstDelivery.resolve()
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    assert.equal(deliveryCalls, 2)
    assert.deepEqual(
      fixture.delivered.map((text) => {
        return text.match(/(?:コマンドを実行中|ファイルを編集中)/u)?.[0]
      }),
      ['コマンドを実行中', 'ファイルを編集中'],
    )
  } finally {
    firstDelivery.resolve()
    await fixture.monitorPromise.then((monitor) => {
      return monitor.close()
    })
  }
})
