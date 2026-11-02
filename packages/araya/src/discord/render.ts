// Discord に送る文章を作る。 structural な情報（Task ID・状態・attempt・理由・時刻・SHIKI の要約）だけを使い、
// stdout・stderr・diff・tool 出力の原文はそのまま渡さない。長い文章は省略印つきの切り詰めとして明示する

import {
  isLedgerError,
  type AttemptView,
  type EventView,
  type NotificationEvent,
  type QueueView,
  type RunnerView,
  type TaskSummary,
  type TaskView,
} from '../runner/ledger.ts'

export const NOTIFICATION_EVENT_TYPES = [
  'task.created',
  'task.retried',
  'task.cancel_requested',
  'run.started',
  'run.resumed',
  'run.stopping',
  'run.finished',
] as const

export const MAX_DISCORD_MESSAGE_CHARS = 2_000
const MESSAGE_CHUNK_CHARS = 1_900

const MAX_TITLE_CHARS = 80
const MAX_SUMMARY_CHARS = 1_200
const MAX_ITEM_CHARS = 200
const MAX_ATTEMPT_ROWS = 5
const MAX_EVENT_ROWS = 8

function clip(text: string, maxChars: number) {
  const singleLine = text.replace(/\s+/gu, ' ').trim()

  if (singleLine.length <= maxChars) {
    return singleLine
  }

  return `${singleLine.slice(0, maxChars - 1)}…`
}

// 改行を持つ本文（SHIKI の要約など）は形を残したまま長さだけ切る
function clipBody(text: string, maxChars: number) {
  const trimmed = text.trim()

  if (trimmed.length <= maxChars) {
    return trimmed
  }

  return `${trimmed.slice(0, maxChars - 1)}\n…（本文が長いのでここから先は表示していません）`
}

const STATUS_LABELS: Record<string, string> = {
  queued: '待ち',
  running: '実行中',
  completed: '完了',
  failed: '失敗',
  blocked: '判断待ち',
}

const FAILURE_REASON_LABELS: Record<string, string> = {
  cancelled: '中止',
  agent_timeout: '実行の時間切れ',
  restart_limit: '再起動の上限',
  attempt_error: '試行の誤り',
}

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status
}

function failureReasonLabel(reason: string) {
  return FAILURE_REASON_LABELS[reason] ?? reason
}

function attemptLabel(attempt: number | null) {
  return `試行 ${attempt ?? 1}`
}

// 通知 event の文章。通知対象でない event（control event・agent の tool 記録）は null
export function renderNotification(event: NotificationEvent) {
  switch (event.type) {
    case 'task.created':
      return `Task #${event.taskId} を登録しました（待ち）: ${clip(event.taskTitle, MAX_TITLE_CHARS)}`
    case 'task.retried': {
      const notePart = event.data.hasNote === true ? '、指示付き' : ''
      return `Task #${event.taskId} の再実行を受け付けました（${attemptLabel(event.attempt)}${notePart}）`
    }
    case 'task.cancel_requested':
      return `Task #${event.taskId} の中止を受け付けました（${event.data.while === 'running' ? '実行中' : '待ち'}）`
    case 'run.started':
      return `Task #${event.taskId}（${attemptLabel(event.attempt)}）の実行を始めました`
    case 'run.resumed':
      return `Task #${event.taskId}（${attemptLabel(event.attempt)}）を続きから再開しました（agent の session があったため自動の resume）`
    case 'run.stopping':
      return `Task #${event.taskId}（${attemptLabel(event.attempt)}）を止めています（理由: ${failureReasonLabel(String(event.data.reason ?? ''))}）`
    case 'run.finished': {
      const status = String(event.data.status ?? '')
      const failureReason = event.data.failureReason
      const base = `Task #${event.taskId}（${attemptLabel(event.attempt)}）は${statusLabel(status)}で終わりました`

      if (typeof failureReason === 'string' && failureReason !== '') {
        return `${base}（理由: ${failureReasonLabel(failureReason)}）`
      }

      return base
    }
    default:
      return null
  }
}

function runnerStatusLabel(runner: RunnerView) {
  switch (runner.state) {
    case 'running':
      return `稼働中（pid ${runner.pid ?? '不明'}、heartbeat ${runner.heartbeatAt ?? '不明'}）`
    case 'not_responding':
      return '応答なし（heartbeat が古いです）'
    case 'stopped':
      return '停止中'
    case 'not_started':
      return '未稼働'
  }
}

export function renderTaskList(input: {
  tasks: TaskSummary[]
  runner: RunnerView | null
  queue: QueueView
}) {
  const lines: string[] = [
    `runner: ${input.runner === null ? '未導入' : runnerStatusLabel(input.runner)}`,
    `実行中 ${input.queue.running} / 待ち ${input.queue.queued}（同時 ${input.queue.limit}）`,
  ]

  if (input.tasks.length === 0) {
    lines.push('Task はありません')

    return lines.join('\n')
  }

  for (const task of input.tasks) {
    const reasonPart =
      task.failureReason === null ? '' : `（理由: ${failureReasonLabel(task.failureReason)}）`
    const questionPart = task.decisionQuestion === null ? '' : '（SHIKI の質問あり）'
    lines.push(
      `#${task.id} ${statusLabel(task.status)}（${attemptLabel(task.attempt)}）${questionPart}${reasonPart} ${clip(task.title, MAX_TITLE_CHARS)}`,
    )
  }

  return lines.join('\n')
}

function attemptLine(attempt: AttemptView) {
  const finish = attempt.finishedAt ?? '未完了'
  const reasonPart =
    attempt.failureReason === null ? '' : `（理由: ${failureReasonLabel(attempt.failureReason)}）`
  return `試行 ${attempt.attempt}: ${statusLabel(attempt.status)}、開始 ${attempt.startedAt ?? 'なし'}、終わり ${finish}${reasonPart}`
}

function eventLine(event: EventView) {
  const detail = Object.entries(event.data)
    .map(([key, value]) => {
      return `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`
    })
    .join(' ')

  return `${event.at} ${event.type}${detail === '' ? '' : ` ${clip(detail, MAX_ITEM_CHARS)}`}`
}

// Task 詳細の文章。Discord の 1 通に収まらないときは続きの通数に分ける
export function renderTaskDetail(input: {
  task: TaskView
  attempts: AttemptView[]
  events: EventView[]
}) {
  const task = input.task
  const lines: string[] = [
    `Task #${task.id}: ${clip(task.title, MAX_ITEM_CHARS)}`,
    `状態: ${statusLabel(task.status)}（${attemptLabel(task.attempt)}）、登録 ${task.createdAt}、更新 ${task.updatedAt}`,
  ]

  if (task.failureReason !== null) {
    lines.push(`理由: ${failureReasonLabel(task.failureReason)}`)
  }

  if (task.cancelRequested) {
    lines.push('中止を求めています')
  }

  lines.push('', `目的: ${clip(task.goal, MAX_SUMMARY_CHARS)}`)

  if (task.constraints.length > 0) {
    lines.push(
      `制約: ${task.constraints
        .map((value) => {
          return clip(value, MAX_ITEM_CHARS)
        })
        .join(' / ')}`,
    )
  }

  if (task.targets.length > 0) {
    lines.push(
      `対象: ${task.targets
        .map((value) => {
          return clip(value, MAX_ITEM_CHARS)
        })
        .join(' / ')}`,
    )
  }

  if (task.permissions.length > 0) {
    lines.push(
      `許可: ${task.permissions
        .map((value) => {
          return clip(value, MAX_ITEM_CHARS)
        })
        .join(' / ')}`,
    )
  }

  if (task.summary !== null) {
    lines.push('', 'SHIKI の結果の要約:', clipBody(task.summary, MAX_SUMMARY_CHARS))
  }

  if (task.decisionQuestion !== null) {
    lines.push('', 'SHIKI からの判断の依頼:', clipBody(task.decisionQuestion, MAX_SUMMARY_CHARS))
  }

  if (input.attempts.length > 0) {
    const rows = input.attempts.slice(-MAX_ATTEMPT_ROWS).map(attemptLine)
    const omitted = input.attempts.length - rows.length
    lines.push('', `試行の記録${omitted > 0 ? `（古い ${omitted} 件は省略）` : ''}:`, ...rows)
  }

  if (input.events.length > 0) {
    const rows = input.events.slice(-MAX_EVENT_ROWS).map(eventLine)
    const omitted = input.events.length - rows.length
    lines.push('', `イベント${omitted > 0 ? `（古い ${omitted} 件は省略）` : ''}:`, ...rows)
  }

  return chunkMessage(lines.join('\n'))
}

// Discord の 1 通は 2000 字。続けて送る通数に分け、先頭に続きの通数を付ける
export function chunkMessage(text: string) {
  if (text.length <= MAX_DISCORD_MESSAGE_CHARS) {
    return [text]
  }

  const chunks: string[] = []

  for (let offset = 0; offset < text.length; offset += MESSAGE_CHUNK_CHARS) {
    chunks.push(text.slice(offset, offset + MESSAGE_CHUNK_CHARS))
  }

  return chunks.map((chunk, index) => {
    return index === 0 ? chunk : `（続き ${index + 1}/${chunks.length}）\n${chunk}`
  })
}

// 台帳の誤りは message が英語なので、Discord に出す文章はこの関数で日本語に置き換える（値は出さない）
export function describeLedgerError(error: unknown) {
  if (!isLedgerError(error)) {
    return '台帳の操作に失敗しました'
  }

  switch (error.code) {
    case 'task_not_found':
      return '指定された Task がありません'
    case 'invalid_task_input':
      return 'Task の内容が不正です（title は 1〜100 字、goal は 1〜2000 字、list の各項目は 1〜500 字、各 list は 100 件以内）'
    case 'invalid_note':
      return '次の試行に渡す指示が不正です（10000 字まで、NUL 文字を含まない）'
    case 'idempotency_conflict':
      return '同じ idempotency key を使う別の Task が既に登録されています'
    case 'task_not_cancellable':
      return 'その Task は既に終わっているため、中止できません'
    case 'task_not_retryable':
      return '失敗・判断待ちの Task だけが再実行できます'
    case 'side_effects_unconfirmed': {
      // sideEffects・taskId はこの code の error だけに付く（LedgerError の共通型には無い）
      const taskId = 'taskId' in error && typeof error.taskId === 'number' ? error.taskId : ''
      const sideEffects =
        'sideEffects' in error &&
        typeof error.sideEffects === 'object' &&
        error.sideEffects !== null
          ? error.sideEffects
          : null
      const created =
        sideEffects !== null &&
        'createdCount' in sideEffects &&
        typeof sideEffects.createdCount === 'number'
          ? sideEffects.createdCount
          : 0
      const removed =
        sideEffects !== null &&
        'removedCount' in sideEffects &&
        typeof sideEffects.removedCount === 'number'
          ? sideEffects.removedCount
          : 0

      return `git worktree（作成 ${created} 件、削除 ${removed} 件）と agent の session の始末が必要です。araya task retry --task ${taskId} --confirm-side-effects で続けるか、araya task remove --task ${taskId} --confirm-side-effects で取り消してください`
    }
    case 'ledger_unsupported_version':
      return '台帳の version がこの bot より新しいです。Araya を更新してください'
    default:
      return '台帳の操作に失敗しました'
  }
}
