import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'

// 設定ファイルと SHIKI の実行（model の選択と、使った model の記録）で共有する、開発 agent の model の規則

export type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ThinkingLevel[]

// Pi に thinking level が増えて一覧から漏れると、ここが typecheck で失敗する
const THINKING_LEVELS_COVER_PI: [Exclude<ThinkingLevel, (typeof THINKING_LEVELS)[number]>] extends [never] ? true : never = true

// 設定ファイルで指定した model。thinkingLevel が null なら Pi の設定に従う
export type DevelopmentModel = {
  provider: string
  id: string
  thinkingLevel: ThinkingLevel | null
}

// Pi session が実際に使う model と丸めた後の thinking level
export type SessionModel = {
  provider: string
  id: string
  thinkingLevel: ThinkingLevel
}

const MAX_MODEL_CHARS = 200
// 設定できる provider と model id は、空でなく、空白（\s）と制御文字を含まない
const CONFIGURABLE_MODEL_PART_PATTERN = /^[^\s\p{Cc}]+$/u

export const MODEL_REFERENCE_RULE = `a "<provider>/<model id>" string of at most ${MAX_MODEL_CHARS} characters without whitespace or control characters`
export const THINKING_LEVEL_RULE = `one of ${THINKING_LEVELS.join(', ')}`

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => {
    return level === value
  })
}

// provider は最初の / より前なので / を含めない。model id は / を含めてよい
function isConfigurableModel(provider: string, id: string) {
  return !provider.includes('/') &&
    CONFIGURABLE_MODEL_PART_PATTERN.test(provider) &&
    CONFIGURABLE_MODEL_PART_PATTERN.test(id) &&
    formatModel({ provider, id }).length <= MAX_MODEL_CHARS
}

export function formatModel(model: { provider: string; id: string }) {
  return `${model.provider}/${model.id}`
}

// `<provider>/<model id>` を最初の / で分ける。規則に合わなければ undefined を返す
export function parseModelReference(value: unknown) {
  if (typeof value !== 'string') {
    return undefined
  }

  const separator = value.indexOf('/')

  if (separator === -1) {
    return undefined
  }

  const provider = value.slice(0, separator)
  const id = value.slice(separator + 1)

  return isConfigurableModel(provider, id) ? { provider, id } : undefined
}
