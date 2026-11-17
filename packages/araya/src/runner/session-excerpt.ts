import { AssistantEntry, UserEntry, type EntryRecord } from '@earendil-works/pi-durable'

import type { Redactor } from '../infrastructure/redaction.ts'

export const MAX_SESSION_SCAN_ENTRIES = 256
export const MAX_SESSION_MESSAGES = 24
export const MAX_SESSION_MESSAGE_CHARS = 2_000
export const MAX_SESSION_CHARS = 12_000

export type SessionExcerptMessage = { role: 'user' | 'assistant'; text: string }
export type SessionExcerpt = {
  contentScope: 'user-assistant-text'
  messages: SessionExcerptMessage[]
  truncated: boolean
}

type SessionExcerptEntry = Pick<EntryRecord, 'kind' | 'model'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundSessionMessages(
  messages: readonly SessionExcerptMessage[],
  initiallyTruncated: boolean,
  redactor: Pick<Redactor, 'redact'>,
) {
  let truncated = initiallyTruncated || messages.length > MAX_SESSION_MESSAGES
  const recent = messages.slice(-MAX_SESSION_MESSAGES)
  const bounded: SessionExcerptMessage[] = []
  let remainingChars = MAX_SESSION_CHARS

  for (const message of [...recent].reverse()) {
    const redacted = redactor.redact(message.text)
    const maxChars = Math.min(redacted.length, MAX_SESSION_MESSAGE_CHARS, remainingChars)

    if (maxChars === 0) {
      truncated = true
      break
    }

    let text: string

    if (redacted.length > maxChars) {
      truncated = true
      const marker = message.role === 'assistant' ? '[…先頭省略…]\n' : '\n[…末尾省略…]'
      const textChars = maxChars - marker.length

      if (textChars <= 0) {
        break
      }

      const visible =
        message.role === 'assistant' ? redacted.slice(-textChars) : redacted.slice(0, textChars)
      text = message.role === 'assistant' ? `${marker}${visible}` : `${visible}${marker}`
    } else {
      text = redacted
    }

    bounded.push({ role: message.role, text })
    remainingChars -= text.length

    if (remainingChars === 0 && bounded.length < recent.length) {
      truncated = true
      break
    }
  }

  return {
    contentScope: 'user-assistant-text',
    messages: bounded.reverse(),
    truncated,
  } satisfies SessionExcerpt
}

// user / assistant の可視テキストだけを残し、tool message・非テキストblock・hidden reasoningは含めない。
export function createSessionExcerpt(
  entries: readonly SessionExcerptEntry[],
  hasMore: boolean,
  redactor: Pick<Redactor, 'redact'>,
) {
  const messages: SessionExcerptMessage[] = []

  for (const entry of [...entries].reverse()) {
    if (entry.kind !== UserEntry.kind && entry.kind !== AssistantEntry.kind) {
      continue
    }

    for (const message of entry.model ?? []) {
      if (message.role !== 'user' && message.role !== 'assistant') {
        continue
      }

      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .flatMap((block) => {
                return block.type === 'text' ? [block.text] : []
              })
              .join('')

      if (text.trim() !== '') {
        messages.push({ role: message.role, text })
      }
    }
  }

  return boundSessionMessages(messages, hasMore, redactor)
}

// 別プロセスから読んだ evidence は、返す前に形式を検証し、既知の秘密を再度 redact する。
export function sanitizeSessionExcerpt(value: unknown, redactor: Pick<Redactor, 'redact'>) {
  if (
    !isRecord(value) ||
    value.contentScope !== 'user-assistant-text' ||
    !Array.isArray(value.messages)
  ) {
    return null
  }

  let truncated =
    (typeof value.truncated === 'boolean' ? value.truncated : true) ||
    value.messages.length > MAX_SESSION_MESSAGES
  const messages: SessionExcerptMessage[] = []

  // evidence_json はローカル保存だが、旧形式・不正データがあり得るため最新の上限件数だけを調べる。
  for (const item of value.messages.slice(-MAX_SESSION_MESSAGES)) {
    if (
      !isRecord(item) ||
      (item.role !== 'user' && item.role !== 'assistant') ||
      typeof item.text !== 'string'
    ) {
      truncated = true
      continue
    }

    messages.push({ role: item.role, text: item.text })
  }

  return boundSessionMessages(messages, truncated, redactor)
}
