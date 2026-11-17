import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AssistantEntry,
  CompactionEntry,
  UserEntry,
  type EntryRecord,
} from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai'

import { createRedactor } from '../src/infrastructure/redaction.ts'
import {
  MAX_SESSION_CHARS,
  MAX_SESSION_MESSAGES,
  MAX_SESSION_MESSAGE_CHARS,
  createSessionExcerpt,
  sanitizeSessionExcerpt,
} from '../src/runner/session-excerpt.ts'

function excerpt(messages: unknown[], truncated = false) {
  return {
    contentScope: 'user-assistant-text',
    messages,
    truncated,
  }
}

test('session excerpt: includes visible user/assistant text but excludes tool blocks and synthetic compaction summaries', () => {
  const toolOnly = 'TOOL_ARGUMENT_AND_RESULT_ONLY_12345'
  const entries = [
    {
      kind: CompactionEntry.kind,
      model: [
        {
          role: 'user',
          content: `Synthetic compaction summary with tool result ${toolOnly}`,
          timestamp: 3,
        },
      ],
    },
    {
      kind: AssistantEntry.kind,
      model: [
        fauxAssistantMessage([
          fauxThinking('hidden reasoning must not be exposed'),
          fauxToolCall('bash', { command: toolOnly }),
          { type: 'text', text: 'Visible assistant reply' },
        ]),
      ],
    },
    {
      kind: UserEntry.kind,
      model: [{ role: 'user', content: 'Visible user request', timestamp: 1 }],
    },
  ] satisfies Pick<EntryRecord, 'kind' | 'model'>[]
  const result = createSessionExcerpt(entries, false, createRedactor([toolOnly]))

  assert.deepEqual(result.messages, [
    { role: 'user', text: 'Visible user request' },
    { role: 'assistant', text: 'Visible assistant reply' },
  ])
  assert.equal(
    result.messages.some((message) => {
      return message.text.includes(toolOnly)
    }),
    false,
  )
  assert.equal(
    result.messages.some((message) => {
      return message.text.includes('hidden reasoning')
    }),
    false,
  )
})

test('session excerpt: message count and aggregate text are bounded, secrets redacted, and non-text roles excluded', () => {
  const secret = 'session-secret-value-12345'
  const rawMessages = Array.from({ length: 30 }, (_value, index) => {
    return { role: 'user', text: `message-${index}` }
  })
  rawMessages[29] = { role: 'user', text: secret }
  rawMessages.push({ role: 'tool', text: 'tool result must not be exposed' })
  const result = sanitizeSessionExcerpt(excerpt(rawMessages), createRedactor([secret]))

  assert.ok(result)
  assert.ok(result.messages.length <= MAX_SESSION_MESSAGES)
  assert.equal(result.truncated, true)
  assert.equal(result.messages.at(-1)?.text, '[REDACTED]')
  assert.equal(
    result.messages.some((message) => {
      return message.text.includes(secret)
    }),
    false,
  )
  assert.equal(
    result.messages.some((message) => {
      return message.text.includes('tool result')
    }),
    false,
  )
  assert.ok(
    result.messages.every((message) => {
      return message.role === 'user' || message.role === 'assistant'
    }),
  )
  assert.ok(
    result.messages.reduce((sum, message) => {
      return sum + message.text.length
    }, 0) <= MAX_SESSION_CHARS,
  )
})

test('session excerpt: long assistant text keeps its end and marks truncation within per-message and total limits', () => {
  const result = sanitizeSessionExcerpt(
    excerpt([
      { role: 'assistant', text: `${'a'.repeat(MAX_SESSION_MESSAGE_CHARS + 500)}END-MARKER` },
    ]),
    createRedactor([]),
  )

  assert.ok(result)
  assert.equal(result.truncated, true)
  assert.equal(result.messages.length, 1)
  assert.ok(result.messages[0]?.text.startsWith('[…先頭省略…]'))
  assert.ok(result.messages[0]?.text.endsWith('END-MARKER'))
  assert.ok((result.messages[0]?.text.length ?? 0) <= MAX_SESSION_MESSAGE_CHARS)
  assert.ok(
    result.messages.reduce((sum, message) => {
      return sum + message.text.length
    }, 0) <= MAX_SESSION_CHARS,
  )
})

test('session excerpt: aggregate character limit keeps only the newest messages and reports truncation', () => {
  const result = sanitizeSessionExcerpt(
    excerpt(
      Array.from({ length: MAX_SESSION_MESSAGES }, (_value, index) => {
        return {
          role: index % 2 === 0 ? 'user' : 'assistant',
          text: String(index).padEnd(MAX_SESSION_MESSAGE_CHARS, 'x'),
        }
      }),
    ),
    createRedactor([]),
  )

  assert.ok(result)
  assert.equal(result.truncated, true)
  assert.ok(result.messages.length < MAX_SESSION_MESSAGES)
  assert.ok(
    result.messages.reduce((sum, message) => {
      return sum + message.text.length
    }, 0) <= MAX_SESSION_CHARS,
  )
  assert.equal(result.messages.at(-1)?.text.startsWith(String(MAX_SESSION_MESSAGES - 1)), true)
})
