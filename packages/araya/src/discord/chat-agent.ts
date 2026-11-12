import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { arr, obj, opt, str } from '@earendil-works/pi-schema'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  ResetEntry,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { Message } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { loadConfig, loadPiSdk } from '../config/environment.ts'
import { loadConfigFile } from '../config/file.ts'
import type { ThinkingLevel } from '../config/model.ts'
import { isLedgerError, parseTaskInput, type TaskLedger } from '../runner/ledger.ts'
import type { Redactor } from '../infrastructure/redaction.ts'

export const DISCORD_CHAT_TASK_TOOL_NAME = 'araya_submit_task'
export const DISCORD_CHAT_EXTENSION_NAME = 'araya-discord-chat'

const DISCORD_CHAT_INSTRUCTIONS = [
  'あなたは Araya の指定 Discord channel で続く会話を担当します。日本語で、前の会話を踏まえて返答してください。',
  'この session は会話専用です。repository の読み書き、shell、git、外部 API の tool は使えません。',
  'コード変更を求められた場合は、唯一の実行手段 araya_submit_task で既存 Task runner に依頼を登録します。',
  'araya_submit_task は、現在の user message が実装・変更の実行を明確に求めている場合だけ呼んでください。質問、アイデア、仕様相談、実行可能性の確認だけでは登録しないでください。不明確なら先に質問してください。',
  'Task の title / goal / constraints / targets は、現在の依頼と会話で合意した要件から具体的に組み立ててください。permissions を勝手に追加せず、Task ID を含めて登録結果を伝えてください。',
  'Task 登録後のコード変更・検証・Draft PR は既存 Task runner が行います。この会話内で実施したと主張しないでください。',
].join('\n')

export type DiscordChatAgentModel = {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

export type OpenDiscordChatAgentInput = {
  dataDir: string
  ledger: TaskLedger
  redactor: Redactor
  models: ModelRuntime
  model: DiscordChatAgentModel
  context: Context
}

function textResult(text: string, isError = false) {
  return {
    output: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  } satisfies ToolExecutionResult
}

export function createDiscordChatTaskTool(input: { ledger: TaskLedger; redactor: Redactor }) {
  return defineTool({
    name: DISCORD_CHAT_TASK_TOOL_NAME,
    description: [
      '利用者が現在の message で実装・変更の実行を明確に依頼したときだけ、Task を Araya の既存 Task runner に登録します。',
      '質問や設計相談では使いません。title と具体的な goal を必須にし、必要な constraints / targets だけを設定します。',
      'repository を直接変更する tool ではありません。permissions は変更できず、空のままです。',
    ].join(''),
    parameters: obj({
      title: str({ description: 'Task の短い題名' }),
      goal: str({ description: '実行する変更・完了条件を具体的に記述した本文' }),
      constraints: opt(arr(str(), { description: '作業上の制約。指定しない場合は空配列' })),
      targets: opt(arr(str(), { description: '作業対象の手がかり。指定しない場合は空配列' })),
    }),
    executionMode: 'sequential',
    async execute(args, api) {
      try {
        const parsed = parseTaskInput(
          Buffer.from(
            JSON.stringify({
              title: args.title,
              goal: args.goal,
              constraints: args.constraints ?? [],
              targets: args.targets ?? [],
              permissions: [],
              idempotencyKey: `discord-chat-${createHash('sha256').update(api.callId).digest('hex').slice(0, 32)}`,
            }),
          ),
        )
        const { created, task } = input.ledger.createTask({
          ...parsed,
          title: input.redactor.redact(parsed.title),
          goal: input.redactor.redact(parsed.goal),
          constraints: parsed.constraints.map((value) => {
            return input.redactor.redact(value)
          }),
          targets: parsed.targets.map((value) => {
            return input.redactor.redact(value)
          }),
          permissions: [],
        })

        return textResult(
          created
            ? `Task #${task.id} を既存 Task runner に登録しました（待ち）。`
            : `Task #${task.id} は同じ依頼から既に登録されています。`,
        )
      } catch (error) {
        return textResult(
          `Task を登録できませんでした（${isLedgerError(error) ? error.code : 'task_submission_failed'}）。依頼内容を確認してください。`,
          true,
        )
      }
    },
  })
}

function assistantText(messages: readonly Message[]) {
  const message = messages.findLast((candidate) => {
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

export async function openDiscordChatAgent(input: OpenDiscordChatAgentInput) {
  const directory = path.join(input.dataDir, 'discord')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const storagePath = path.join(directory, 'chat.sqlite')
  const storage = await openNodeSqliteStorage(storagePath)
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined

  try {
    await fs.chmod(storagePath, 0o600)
    const taskTool = createDiscordChatTaskTool(input)
    const extension = defineExtension({ name: DISCORD_CHAT_EXTENSION_NAME, tools: [taskTool] })
    const registry = createRegistry()
    registry.install(extension)
    harness = await Harness.open(storage, { models: input.models, registry }, input.context)
    const root = await harness.root(input.context, {
      agent: {
        model: { provider: input.model.provider, modelId: input.model.modelId },
        thinkingLevel: input.model.thinkingLevel,
        extensions: [extension],
        tools: [taskTool],
        modelTools: [taskTool],
        instructions: DISCORD_CHAT_INSTRUCTIONS,
      },
    })
    harness.resume()
    let closed = false

    return {
      submit: async (content: string, requestId: string) => {
        const settled = await (
          await root.submit({ type: 'input', content, requestId }, input.context)
        ).wait(input.context)

        if (settled.status !== 'done') {
          throw new Error('discord_chat_unanswered')
        }

        return assistantText((await root.context(input.context, { at: settled.answer })).messages)
      },
      reset: async (requestId: string) => {
        const submission = await root.submit(
          {
            type: 'write',
            requestId,
            entry: { kind: ResetEntry.kind, head: 'self' },
          },
          input.context,
        )
        await submission.wait(input.context)
      },
      close: async () => {
        if (closed) {
          return
        }

        closed = true
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

export async function createDefaultDiscordChatSession(input: {
  dataDir: string
  env: Readonly<Record<string, string | undefined>>
  ledger: TaskLedger
  redactor: Redactor
}) {
  const config = loadConfig({ ...input.env, ARAYA_DATA_DIR: input.dataDir })
  const { createRunnerModelRuntime } = await import('../runner/runner.ts')
  const { resolveShikiModel } = await import('../runner/attempt.ts')
  const models = await createRunnerModelRuntime({
    agentDir: config.piAgentDir,
    dataDir: path.join(config.dataDir, 'discord'),
  })
  const settingsDirectory = path.join(config.dataDir, 'discord', 'chat-settings')
  await fs.mkdir(settingsDirectory, { recursive: true, mode: 0o700 })
  await fs.chmod(settingsDirectory, 0o700)
  const { SettingsManager } = await loadPiSdk(config.piAgentDir)
  const resolved = resolveShikiModel(
    models,
    {
      devRoot: config.devRoot,
      agentDir: config.piAgentDir,
      model: (await loadConfigFile(config.configPath)).developmentModel,
      timeoutMs: config.developmentTimeoutMs,
      verificationTimeoutMs: config.verificationTimeoutMs,
    },
    await SettingsManager.create(settingsDirectory, config.piAgentDir, { projectTrusted: false }),
  )

  if (!resolved.ok) {
    throw new Error('discord_chat_model_unavailable')
  }

  return await openDiscordChatAgent({
    dataDir: config.dataDir,
    ledger: input.ledger,
    redactor: input.redactor,
    models,
    model: {
      provider: resolved.model.provider,
      modelId: resolved.model.id,
      thinkingLevel: resolved.model.thinkingLevel,
    },
    context: BACKGROUND_CONTEXT,
  })
}
