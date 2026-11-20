import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ThinkingLevel } from '@earendil-works/pi-ai'
import { obj, opt, str } from '@earendil-works/pi-schema'
import {
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type ToolExecutionResult,
  type TaskId,
  type ToolRegistration,
  type Tx,
} from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools'

import { loadConfig } from '../config/environment.ts'
import { loadConfigFile } from '../config/file.ts'
import type { Redactor } from '../infrastructure/redaction.ts'
import { createModelRuntime, createPiModelSettings, resolveAgentModel } from './model.ts'

// session-first の Araya agent host。Discord bot の process が pi-durable の Harness を持ち、
// main conversation が coding tools（read / write / edit / bash）を直接使って作業する。
// Task は Araya 側の runner を持たず、main agent が task tool で作る background child conversation が担う。

export const ARAYA_AGENT_EXTENSION_NAME = 'araya-agent'
export const ARAYA_TASK_TOOL_NAME = 'task'

const SUBAGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u

type CodingTool = ToolRegistration

function mainInstructions(devRoot: string) {
  return [
    'あなたは Araya。このサーバーの開発作業を直接実行する agent で、応答は日本語です。',
    `read / write / edit / bash tool と cwd ${devRoot} を使い、git・gh・npm などの CLI を自由に実行して作業を完了させてください。説明だけで終わらせず、tool を使って実際に確認・実装・検証します。`,
    '作業対象（repository・branch・path）が曖昧なときは git status などの実測で確認してから進めます。完了の報告は tool output の実測に基づきます。',
    'production deploy・merge・外部送信・破壊的な操作は、その依頼が明確でない限り実行前に利用者に確認します。',
    '時間がかかる作業・並行したい作業は task tool で background child に任せ、main の会話は止めません。child の完了報告は自動でこの会話に届くので、それを踏まえて利用者に報告します。',
    'task tool: spawn で child を作成し名前で管理、send で追加の依頼・問い合わせ、stop で中止、status で一覧。',
    '秘密（token・password・credential file の値）は応答や child への依頼文に書かないでください。',
  ].join('\n')
}

function workerInstructions(devRoot: string) {
  return [
    'あなたは Araya の task worker。依頼された作業をこの cwd（開発 root は ' + devRoot + '）で実行し、最後の message で日本語で結果を報告してください。',
    '報告内容: 実施したこと、実行したコマンドと実測結果、変更した file、残っている課題。判断が必要な点は選択肢とともに挙げてください。',
    'task tool は使いません。依頼が明確でない破壊的操作・外部送信は実行せず、わからない点として報告します。',
  ].join('\n')
}

function textResult(text: string, isError = false) {
  return {
    output: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  } satisfies ToolExecutionResult
}

async function answerText(tx: Tx, conversationId: ConversationId, entryId: EntryId) {
  const page = await tx.scanEntries({ conversationId, minEntryId: entryId, maxEntryId: entryId }, 1)
  const entry: EntryRecord | undefined = page.items[0]
  const message = entry?.model?.findLast((candidate) => {
    return candidate.role === 'assistant'
  })

  if (message === undefined || message.role !== 'assistant') {
    return ''
  }

  return message.content
    .flatMap((block) => {
      return block.type === 'text' ? [block.text] : []
    })
    .join('')
}

// name -> child conversation の対応。tool task ではなく session-scoped document に保持し、restart でも復元する
type SubagentRecord = { conversationId: ConversationId; updatedAt: number }
type SubagentsState = { agents: Record<string, SubagentRecord> }

const SubagentsDoc = defineDoc<SubagentsState>({
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

type ReporterInput = {
  name: string
  childConversationId: ConversationId
  mainConversationId: ConversationId
  message: string
}
type ReporterCheckpoint =
  | { phase: 'deliver' }
  | { phase: 'report'; report: string }
  | { phase: 'send'; report: string; answer: string }
type ReporterResult = { report: string }

// Discord の nonce は 25 文字上限。taskId から決めるので配送リトライで同じ nonce になる
function reportNonce(taskId: TaskId<ReporterResult>, tag: string) {
  return `araya-report-${createHash('sha256').update(`${taskId}:${tag}`).digest('hex').slice(0, 8)}`
}

// child conversation への submit と、完了報告の main への followUp + Discord への deliver を担う background task。
// requestId を taskId から決めるので、restart 後も同じ submit を重複しない
function createReporterTask(deps: {
  deliverReport: (name: string, text: string, nonce: string) => Promise<void>
  deliveryRetryMs: number
}) {
  const completed = (report: string) => {
    return {
      status: 'terminal',
      outcome: { status: 'completed', result: { report } },
    } as const
  }

  return defineTask<ReporterInput, ReporterCheckpoint, ReporterResult>({
    name: 'araya-task-report',
    version: 1,
    initial: () => {
      return { phase: 'deliver' }
    },
    phases: {
      deliver: async (task, runtime, context) => {
        const input = task.input
        const child = await runtime.conversation(input.childConversationId, context)

        if (child === undefined) {
          await runtime.commit(
            () => {
              return completed('（child conversation が見つかりませんでした）')
            },
            context,
          )

          return
        }

        const submission = await child.submit(
          {
            type: 'input',
            content: input.message,
            requestId: `araya-send-${runtime.taskId}`,
          },
          context,
        )
        const settled = await submission.wait(context)
        const answerId = settled.status === 'done' ? settled.answer : undefined

        await runtime.commit(
          async (tx) => {
            const report =
              answerId === undefined
                ? ''
                : await answerText(tx, input.childConversationId, answerId)

            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                report: report === '' ? '（child の回答を取得できませんでした）' : report,
              },
            }
          },
          context,
        )
      },
      report: async (task, runtime, context) => {
        const input = task.input
        const checkpoint = task.state.checkpoint
        const main = await runtime.conversation(input.mainConversationId, context)
        let answer = ''

        if (main !== undefined) {
          const submission = await main.submit(
            {
              type: 'input',
              content: `task[${input.name}] の報告:\n${checkpoint.report}`,
              requestId: `araya-report-${runtime.taskId}`,
              whenBusy: 'followUp',
            },
            context,
          )
          const settled = await submission.wait(context)
          const answerId = settled.status === 'done' ? settled.answer : undefined

          await runtime.commit(
            async (tx) => {
              if (answerId !== undefined) {
                answer = await answerText(tx, input.mainConversationId, answerId)
              }

              return {
                status: 'running',
                checkpoint: {
                  phase: 'send',
                  report: checkpoint.report,
                  answer,
                },
              }
            },
            context,
          )

          return
        }

        await runtime.commit(
          () => {
            return {
              status: 'running',
              checkpoint: {
                phase: 'send',
                report: '（main conversation が見つかりませんでした）',
                answer: '',
              },
            }
          },
          context,
        )
      },
      send: async (task, runtime, context) => {
        const input = task.input
        const checkpoint = task.state.checkpoint
        const text =
          checkpoint.answer === ''
            ? `task[${input.name}] の報告を main 側で処理できませんでした`
            : checkpoint.answer

        // 配送完了を確かめてから terminal 化する。途中終了でも resume は同じ nonce で再送する
        try {
          await deps.deliverReport(input.name, text, reportNonce(runtime.taskId, 'send'))
        } catch {
          // 配送の例外で task を faulted にしない。durable state 保持で再試行する。
          // nonce 同一なので短時間の再送は Discord 側で重複排除されるが、排除に期限があるため配送は at-least-once として扱う
          await runtime.commit(
            () => {
              return {
                status: 'sleeping',
                checkpoint,
                until: runtime.now() + deps.deliveryRetryMs,
              }
            },
            context,
          )

          return
        }

        await runtime.commit(
          () => {
            return completed(checkpoint.report)
          },
          context,
        )
      },
    },
    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint
      const report =
        checkpoint.phase === 'report' || checkpoint.phase === 'send' ? checkpoint.report : ''

      await deps
        .deliverReport(
          task.input.name,
          `task[${task.input.name}] が中止されました` +
            (report === '' ? '' : `（時点の報告:\n${report}）`),
          reportNonce(runtime.taskId, 'abort'),
        )
        .catch(() => {})
      await runtime.commit(
        () => {
          return {
            status: 'terminal',
            outcome: { status: 'aborted', reason: 'user_abort', result: { report } },
          }
        },
        context,
      )
    },
  })
}

type TaskToolDependencies = {
  codingTools: readonly CodingTool[]
  reporterTask: ReturnType<typeof createReporterTask>
  devRoot: string
  getHarness: () => HarnessInstance | undefined
}

type HarnessInstance = Awaited<ReturnType<typeof Harness.open>>

// main agent が自分で background child を作る tool。Pi の durable task graph が lifecycle を持つ
function createTaskTool(deps: TaskToolDependencies) {
  const worker = workerInstructions(deps.devRoot)

  return defineTool({
    name: ARAYA_TASK_TOOL_NAME,
    description: [
      'background child conversation を管理する。spawn: 名前付き child を作って依頼を送る。',
      'send: 既存 child に追加の依頼・問い合わせを送る。stop: child の作業中止を要求する。status: child 一覧。',
      'child の完了報告は自動的に main 会話へ届き、Discord にも送られる。spawn/send の依頼文に秘密を書かないでください。',
    ].join(' '),
    parameters: obj({
      action: str({ description: 'spawn | send | stop | status' }),
      name: str({ description: 'child の名前（英数字と -、先頭は英数字）' }),
      message: opt(str({ description: 'spawn / send で child に渡す依頼文' })),
    }),
    executionMode: 'sequential',
    async execute(args, api) {
      const context = BACKGROUND_CONTEXT
      const action = args.action.trim().toLowerCase()
      const name = args.name.trim()

      if (!SUBAGENT_NAME_PATTERN.test(name)) {
        return textResult('name は英数字と - だけで 64 文字以内、先頭は英数字にしてください。', true)
      }

      if (action === 'spawn') {
        if (args.message === undefined || args.message.trim() === '') {
          return textResult('spawn には message が必要です。', true)
        }

        const message = args.message

        const created = await api.commit(
          async (tx) => {
            const doc = await tx.doc(SubagentsDoc, api.conversationId)

            if (doc.agents[name] !== undefined) {
              return { alreadyExists: true, conversationId: null }
            }

            const child = await tx.createConversation({
              ownership: { kind: 'task', taskId: api.taskId },
            })
            // task-owned conversation は main の agent をコピーして始まるので、worker 用に上書きする
            await configure(tx, child.id, {
              instructions: worker,
              tools: [...deps.codingTools],
              modelTools: [...deps.codingTools],
              cwd: deps.devRoot,
            })
            // child・名前対応・reporter を同一 commit で作る。途中終了で依頼が失われない
            await tx.createTask(
              deps.reporterTask,
              {
                name,
                childConversationId: child.id,
                mainConversationId: api.conversationId,
                message,
              },
              { background: true, ownership: { kind: 'conversation' } },
            )
            doc.agents[name] = { conversationId: child.id, updatedAt: api.now() }

            return { alreadyExists: false }
          },
          context,
        )

        if (created.alreadyExists) {
          return textResult(`task[${name}] は既にあります。send か stop を使ってください。`, true)
        }

        return textResult(`task[${name}] を開始しました。完了したら報告がこの会話に届きます。`)
      }

      if (action === 'send') {
        if (args.message === undefined || args.message.trim() === '') {
          return textResult('send には message が必要です。', true)
        }

        const conversationId = await api.commit(
          async (tx) => {
            const doc = await tx.doc(SubagentsDoc, api.conversationId)
            const entry = doc.agents[name]

            if (entry === undefined) {
              return null
            }

            entry.updatedAt = api.now()

            return entry.conversationId
          },
          context,
        )

        if (conversationId === null) {
          return textResult(`task[${name}] はありません。status で一覧を確認してください。`, true)
        }

        await api.createTask(
          deps.reporterTask,
          {
            name,
            childConversationId: conversationId,
            mainConversationId: api.conversationId,
            message: args.message,
          },
          { background: true, ownership: { kind: 'conversation' } },
          context,
        )

        return textResult(`task[${name}] に送りました。完了したら報告がこの会話に届きます。`)
      }

      if (action === 'stop') {
        const conversationId = await api.commit(
          async (tx) => {
            const doc = await tx.doc(SubagentsDoc, api.conversationId)
            const entry = doc.agents[name]

            return entry === undefined ? null : entry.conversationId
          },
          context,
        )

        if (conversationId === null) {
          return textResult(`task[${name}] はありません。`, true)
        }

        const harness = deps.getHarness()
        const child = harness === undefined ? undefined : await harness.conversation(conversationId, context)

        if (child === undefined) {
          return textResult('task を中止できませんでした（conversation がありません）。', true)
        }

        await child.abort(context, { background: true })

        return textResult(`task[${name}] の中止を要求しました。`)
      }

      if (action === 'status') {
        const agents = await api.commit(
          async (tx) => {
            const doc = await tx.doc(SubagentsDoc, api.conversationId)

            return Object.entries(doc.agents).map(([agentName, entry]) => {
              return { name: agentName, updatedAt: entry.updatedAt }
            })
          },
          context,
        )

        return textResult(JSON.stringify({ agents }))
      }

      return textResult(`action ${args.action} は使えません（spawn / send / stop / status）。`, true)
    },
  })
}

export type OpenArayaAgentHostInput = {
  dataDir: string
  devRoot: string
  models: ModelRuntime
  model: { provider: string; modelId: string; thinkingLevel: ThinkingLevel }
  redactor: Redactor
  deliverReport: (name: string, text: string, nonce: string) => Promise<void>
  /** 配送失敗時の再試行間隔 (ms)。既定 15000 */
  deliveryRetryMs?: number
  context: Context
}

export type ArayaAgentSession = {
  submit(content: string, requestId: string): Promise<string>
  reset(requestId: string): Promise<void>
  stop?(): Promise<void>
  close(): Promise<void>
  // HOOT 判断 run を 1 回走らせる。main 会話とは別の、tool を持たない専用の会話を使う
  hootDecide?(input: HootDecideRequest): Promise<HootDecideResult>
}

export type HootDecideRequest = {
  prompt: string
  // 同じ requestId の submit を繰り返さないための stable key（HOOT は schedule occurrence を使う）
  requestId: string
  // 前に使った HOOT 会話の id（pi-durable の conversation id）。再起動後に同じ会話を続ける
  conversationId: number | null
  instructions: string
}

export type HootDecideResult = {
  text: string
  conversationId: number
}

export async function openArayaAgentHost(
  input: OpenArayaAgentHostInput,
): Promise<ArayaAgentSession> {
  const directory = path.join(input.dataDir, 'agent')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const storagePath = path.join(directory, 'agent.sqlite')
  const storage = await openNodeSqliteStorage(storagePath)
  let harness: HarnessInstance | undefined

  try {
    await fs.chmod(storagePath, 0o600)
    const codingTools: CodingTool[] = [
      createReadTool(),
      createWriteTool(),
      createEditTool(),
      createBashTool(),
    ]
    // deliveryRetryMs は有限な正値だけ受け、NaN・Infinity・負値は既定に戻す
    const deliveryRetryMs =
      typeof input.deliveryRetryMs === 'number' &&
      Number.isFinite(input.deliveryRetryMs) &&
      input.deliveryRetryMs > 0
        ? input.deliveryRetryMs
        : 15_000
    const reporterTask = createReporterTask({
      deliverReport: input.deliverReport,
      deliveryRetryMs,
    })
    const taskTool = createTaskTool({
      codingTools,
      reporterTask,
      devRoot: input.devRoot,
      getHarness: () => {
        return harness
      },
    })
    const extension = defineExtension({
      name: ARAYA_AGENT_EXTENSION_NAME,
      // task 定義は extension 経由で harness に登録しないと scheduled されない
      tasks: [reporterTask],
      tools: [...codingTools, taskTool],
    })
    const registry = createRegistry()
    registry.install(extension)
    harness = await Harness.open(
      storage,
      {
        models: input.models,
        registry,
        // worker も含む全 conversation に dev root を基点の shell 環境を与える。実行制限は instructions 側で示す
        env: ({ cwd }) => {
          return new NodeExecutionEnv({ cwd: cwd ?? input.devRoot })
        },
      },
      input.context,
    )
    const root = await harness.root(
      input.context,
      {
        agent: {
          model: { provider: input.model.provider, modelId: input.model.modelId },
          thinkingLevel: input.model.thinkingLevel,
          extensions: [extension],
          tools: [...codingTools, taskTool],
          modelTools: [...codingTools, taskTool],
          instructions: mainInstructions(input.devRoot),
          cwd: input.devRoot,
        },
      },
    )
    harness.resume()
    const activeHarness = harness

    // HOOT 判断 run 用の conversation。coding tool・task tool を持たないので、判断 run は file も
    // child も変更できない。id を覚えておき、再起動後は同じ transcript を続ける
    let hootConversation: Conversation | undefined

    const startHootConversation = async () => {
      return await activeHarness.createConversation(
        {
          ownership: { kind: 'ownerless' },
        },
        input.context,
      )
    }

    const ensureHootConversation = async (request: HootDecideRequest) => {
      let conversation: Conversation

      if (request.conversationId === null) {
        // 会話 reset の依頼。前の判断の続きにすると noop が自己強化するので、新しい会話から始める
        conversation = await startHootConversation()
      } else {
        const cached = hootConversation

        if (cached !== undefined && cached.id === request.conversationId) {
          conversation = cached
        } else {
          try {
            // hoot state に number で保存した id。pi-durable の ConversationId は branded number
            const resumed = await activeHarness.conversation(request.conversationId as ConversationId, input.context)
            // state の conversationId がこの storage に無い（dataDir を書き換えた等）ときは新しい会話で続ける。
            // 失敗を繰り返させない。id の変化は tick 側が state に書き直す
            conversation = resumed ?? (await startHootConversation())
          } catch {
            conversation = await startHootConversation()
          }
        }
      }

      hootConversation = conversation
      // policy は毎回書き直す。古い conversation に tool が残っていても判断 run には渡さない
      await conversation.configure(
        {
          instructions: request.instructions,
          tools: [],
          modelTools: [],
          cwd: input.devRoot,
          model: { provider: input.model.provider, modelId: input.model.modelId },
          thinkingLevel: input.model.thinkingLevel,
        },
        input.context,
      )

      return conversation
    }

    return {
      submit: async (content: string, requestId: string) => {
        const settled = await (
          await root.submit({ type: 'input', content, requestId }, input.context)
        ).wait(input.context)

        if (settled.status !== 'done') {
          throw new Error('araya_agent_unanswered')
        }

        const messages = (await root.context(input.context, { at: settled.answer })).messages
        const last = messages.findLast((candidate) => {
          return candidate.role === 'assistant'
        })
        const text =
          last === undefined || last.role !== 'assistant'
            ? ''
            : last.content
                .flatMap((block) => {
                  return block.type === 'text' ? [block.text] : []
                })
                .join('')

        return input.redactor.redact(text)
      },
      reset: async () => {
        await root.reset(undefined, input.context)
      },
      hootDecide: async (request: HootDecideRequest) => {
        const conversation = await ensureHootConversation(request)
        const settled = await (
          await conversation.submit(
            {
              type: 'input',
              content: request.prompt,
              requestId: request.requestId,
              whenBusy: 'reject',
            },
            input.context,
          )
        ).wait(input.context)

        if (settled.status !== 'done') {
          throw new Error('araya_hoot_unanswered')
        }

        const messages = (await conversation.context(input.context, { at: settled.answer })).messages
        const last = messages.findLast((candidate) => {
          return candidate.role === 'assistant'
        })
        const text =
          last === undefined || last.role !== 'assistant'
            ? ''
            : last.content
                .flatMap((block) => {
                  return block.type === 'text' ? [block.text] : []
                })
                .join('')

        return { text: input.redactor.redact(text), conversationId: conversation.id }
      },
      // main の実行中 run・queued input と、その background child まで止める
      stop: async () => {
        await root.abort(input.context, { background: true })
      },
      close: async () => {
        await harness?.close(input.context)
      },
    }
  } catch (error) {
    if (harness === undefined) {
      await storage.close(input.context)
    } else {
      await harness.close(input.context)
    }

    throw error
  }
}

// bot process から見た既定 session。model 解決は settings ファイル -> Pi の既定の順
export async function createDefaultArayaAgentSession(input: {
  dataDir: string
  env: Readonly<Record<string, string | undefined>>
  redactor: Redactor
  deliverReport: (name: string, text: string, nonce: string) => Promise<void>
  deliveryRetryMs?: number
}) {
  const config = loadConfig({ ...input.env, ARAYA_DATA_DIR: input.dataDir })
  const runtime = await createModelRuntime({
    agentDir: config.piAgentDir,
    storeDir: path.join(config.dataDir, 'agent', 'models-store.json'),
  })
  const resolved = resolveAgentModel(
    runtime,
    (await loadConfigFile(config.configPath)).agentModel,
    await createPiModelSettings({
      agentDir: config.piAgentDir,
      settingsDir: path.join(config.dataDir, 'agent', 'agent-settings'),
    }),
  )

  if (!resolved.ok) {
    throw new Error(`araya_agent_model_unavailable: ${resolved.message}`)
  }

  return await openArayaAgentHost({
    dataDir: config.dataDir,
    devRoot: config.devRoot,
    models: runtime,
    model: {
      provider: resolved.model.provider,
      modelId: resolved.model.id,
      thinkingLevel: resolved.model.thinkingLevel,
    },
    redactor: input.redactor,
    deliverReport: input.deliverReport,
    deliveryRetryMs: input.deliveryRetryMs,
    context: BACKGROUND_CONTEXT,
  })
}
