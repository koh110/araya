import path from 'node:path'

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import type { DevelopmentModel } from '../../src/development-model.ts'

// faux provider の model と応答。応答は、会話の中の課題の識別子と tool の結果だけで決め、process の memory に状態を持たない
// （process をまたぐ test でも同じ応答の関数を使えるように）

const MAX_RESPONSES = 5000

export type FauxToolResult = {
  toolName: string
  isError: boolean
  text: string
}

export type FauxView = {
  taskKey: string
  // 最初の user message（課題の prompt）の text
  prompt: string
  toolResults: FauxToolResult[]
}

export type FauxStep = (view: FauxView) => AssistantMessage

function textOf(content: Message['content']) {
  if (typeof content === 'string') {
    return content
  }

  return content.map((block) => {
    return block.type === 'text' ? block.text : ''
  }).join('')
}

function viewOf(messages: readonly Message[]) {
  const prompt = messages.find((message) => {
    return message.role === 'user'
  })
  const promptText = prompt === undefined ? '' : textOf(prompt.content)
  const taskKey = /^課題の識別子: (\S+)$/mu.exec(promptText)?.[1] ?? ''
  const toolResults = messages.flatMap((message) => {
    return message.role === 'toolResult'
      ? [{ toolName: message.toolName, isError: message.isError, text: textOf(message.content) }]
      : []
  })
  const view: FauxView = { taskKey, prompt: promptText, toolResults }

  return view
}

export function toolCall(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
}

export function answer(text: string) {
  return fauxAssistantMessage(text)
}

// faux の model と、それを登録した ModelRuntime（runner と同じ options。実際の Pi の auth は読まない）。
// reasoning を true にすると、thinking level に対応する model（faux-reasoning-1）にする
export async function createFauxModels(input: { agentDir: string; dataDir: string }, options: { reasoning?: boolean } = {}) {
  const faux = fauxProvider(options.reasoning === true ? { models: [{ id: 'faux-reasoning-1', reasoning: true }] } : {})
  const runtime = await ModelRuntime.create({
    authPath: path.join(input.agentDir, 'auth.json'),
    modelsPath: path.join(input.agentDir, 'models.json'),
    modelsStorePath: path.join(input.dataDir, 'runner', 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  runtime.registerNativeProvider(faux.provider)
  await runtime.refresh({ allowNetwork: false })
  const model: DevelopmentModel = { provider: faux.models[0].provider, id: faux.models[0].id, thinkingLevel: null }

  function script(step: FauxStep) {
    faux.setResponses(Array.from({ length: MAX_RESPONSES }, () => {
      return (context: { messages: Message[] }) => {
        return step(viewOf(context.messages))
      }
    }))
  }

  return { faux, runtime, model, script }
}

// tool の結果の JSON（araya_create_worktree の worktreePath など）を読む
export function parseToolJson(result: FauxToolResult | undefined) {
  if (result === undefined) {
    throw new Error('no tool result')
  }

  const value: unknown = JSON.parse(result.text)

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`tool result is not an object: ${result.text}`)
  }

  return value
}

export function worktreePathFrom(result: FauxToolResult | undefined) {
  const value = parseToolJson(result)

  if (!('worktreePath' in value) || typeof value.worktreePath !== 'string') {
    throw new Error(`no worktreePath in ${result?.text ?? ''}`)
  }

  return value.worktreePath
}
