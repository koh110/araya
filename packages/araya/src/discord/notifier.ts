// 台帳の task_events を Discord へ送る loop。状態は <dataDir>/discord/state.json の 1 file だけで、
// 送信待ち列を作らない（cursor より後の event を台帳から読み直す = 落ちても続きから送る）
// 送信失敗はその event だけ exponential backoff で送り直し、backoff 中は後続の event を送らない（到着順を保つ）

import { type NotificationEvent, type TaskLedger } from '../runner/ledger.ts'
import { type Redactor } from '../infrastructure/redaction.ts'
import { renderNotification } from './render.ts'
import { type DiscordBotState, writeDiscordBotState } from './state.ts'

export const NOTIFICATION_POLL_MS = 5_000
export const NOTIFICATION_BATCH = 25
export const MAX_NOTIFICATION_ATTEMPTS = 20

const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000

export function notificationBackoffMs(attempts: number) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 6))
}

export type NotificationTickDeps = {
  dataDir: string
  ledger: TaskLedger
  state: DiscordBotState
  redactor: Redactor
  // Discord へ 1 通送る。失敗して throw してよい（この関数が backoff を記録する）
  send(content: string, nonce: string): Promise<void>
  nowMs: () => number
  log(entry: Record<string, unknown>): void
}

export type NotificationTickResult = { sent: number; skipped: number }

function renderSafeNotification(event: NotificationEvent, redactor: Redactor) {
  // 先に全フィールドを伏せてからclipし、長い秘密値の途中だけが通知に残るのを防ぐ
  return renderNotification({
    ...event,
    at: redactor.redact(event.at),
    type: redactor.redact(event.type),
    data: redactor.redactRecord(event.data),
    taskTitle: redactor.redact(event.taskTitle),
  })
}

// 1 通分の処理を前に進める。Discord operation が失敗したら state に backoff を書いて return する
export async function notificationTick(deps: NotificationTickDeps) {
  const { ledger, state } = deps
  let sent = 0
  let skipped = 0

  // 進行中の retry を先に終わらせる（backoff 中は後続の event に進まない）
  if (state.backoff !== null) {
    const backoff = state.backoff

    if (backoff.nextAttemptAtMs > deps.nowMs()) {
      return { sent: 0, skipped: 0 }
    }

    const event = ledger.getEvent(backoff.eventSeq)
    const content = event === null ? null : renderSafeNotification(event, deps.redactor)

    if (content === null) {
      // 台帳に無い・対象外の event なら待たない。送れる event だけ待って送り直す
      state.cursor = Math.max(state.cursor ?? 0, backoff.eventSeq)
      state.backoff = null
      writeDiscordBotState(deps.dataDir, state)
      deps.log({
        type: 'discord_notification_skipped',
        eventSeq: backoff.eventSeq,
        reason: 'unrenderable',
      })

      return { sent: 0, skipped: 1 }
    }

    try {
      await deps.send(content, `araya-ev${backoff.eventSeq}`)
    } catch (error) {
      const attempts = backoff.attempts + 1

      if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
        // 同じ Task の後続の通知は新しい状況なので、この 1 通を諦めて次へ進む
        state.cursor = Math.max(state.cursor ?? 0, backoff.eventSeq)
        state.backoff = null
        writeDiscordBotState(deps.dataDir, state)
        deps.log({ type: 'discord_notification_abandoned', eventSeq: backoff.eventSeq, attempts })

        return { sent: 0, skipped: 1 }
      }

      state.backoff = {
        eventSeq: backoff.eventSeq,
        attempts,
        nextAttemptAtMs: deps.nowMs() + notificationBackoffMs(attempts),
      }
      writeDiscordBotState(deps.dataDir, state)
      deps.log({
        type: 'discord_notification_retry_scheduled',
        eventSeq: backoff.eventSeq,
        attempts,
        waitMs: notificationBackoffMs(attempts),
        errorName: error instanceof Error ? error.name : 'unknown',
      })

      return { sent: 0, skipped: 0 }
    }

    state.cursor = backoff.eventSeq
    state.backoff = null
    writeDiscordBotState(deps.dataDir, state)

    return { sent: 1, skipped: 0 }
  }

  const cursor = state.cursor ?? 0
  const events = ledger.listEventsSince(cursor, NOTIFICATION_BATCH)

  for (const event of events) {
    const content = renderSafeNotification(event, deps.redactor)

    if (content === null) {
      // 通知対象でない event（control event・agent の tool 記録）は飛ばす
      state.cursor = event.seq
      skipped += 1
      writeDiscordBotState(deps.dataDir, state)
      continue
    }

    try {
      await deps.send(content, `araya-ev${event.seq}`)
    } catch (error) {
      state.backoff = {
        eventSeq: event.seq,
        attempts: 1,
        nextAttemptAtMs: deps.nowMs() + notificationBackoffMs(1),
      }
      writeDiscordBotState(deps.dataDir, state)
      deps.log({
        type: 'discord_notification_retry_scheduled',
        eventSeq: event.seq,
        attempts: 1,
        waitMs: notificationBackoffMs(1),
        errorName: error instanceof Error ? error.name : 'unknown',
      })

      return { sent, skipped }
    }

    state.cursor = event.seq
    sent += 1
    writeDiscordBotState(deps.dataDir, state)
  }

  return { sent, skipped }
}

// 通知対象 event type の一覧は docs の table と揃える（renderNotification が null を返すものを対象外とする）
export function isNotificationEventType(event: NotificationEvent) {
  return renderNotification(event) !== null
}
