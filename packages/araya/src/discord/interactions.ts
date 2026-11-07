// Discord の /araya slash command の定義と処理。Discord 側の入力を検証し、台帳（TaskLedger）の operation を呼ぶ。
// 処理は同期で、Discord の connection 管理（gateway.ts）从这里離して unit test できるようにする

import {
  MAX_CONCURRENT_ATTEMPTS,
  parseRetryNote,
  parseTaskInput,
  TASK_STATUSES,
  type AttemptView,
  type EventView,
  type TaskLedger,
  type TaskSummary,
  type TaskView,
} from '../runner/ledger.ts'
import { type Redactor } from '../infrastructure/redaction.ts'
import { type DiscordConfig } from './config.ts'
import { chunkMessage, describeLedgerError, renderTaskDetail, renderTaskList } from './render.ts'

export const ARAYA_COMMAND_NAME = 'araya'
export const MAX_LIST_TASKS = 30

export type DiscordCommandRequest = {
  interactionId: string
  userId: string
  guildId: string | null
  channelId: string | null
  subcommand: string
  options: Record<string, string | number | boolean | undefined>
}

export type CommandReply = { content: string }

export type CommandHandlerDeps = {
  config: DiscordConfig
  unit: string
  ledger: TaskLedger
  nowMs: () => number
  redactor: Redactor
}

function redactNullable(value: string | null, redactor: Redactor) {
  return value === null ? null : redactor.redact(value)
}

function redactTaskSummary(task: TaskSummary, redactor: Redactor) {
  return {
    ...task,
    title: redactor.redact(task.title),
    failureReason: redactNullable(task.failureReason, redactor),
    decisionQuestion: redactNullable(task.decisionQuestion, redactor),
    createdAt: redactor.redact(task.createdAt),
    updatedAt: redactor.redact(task.updatedAt),
  }
}

function redactTaskView(task: TaskView, redactor: Redactor) {
  return {
    id: task.id,
    title: redactor.redact(task.title),
    status: task.status,
    attempt: task.attempt,
    failureReason: redactNullable(task.failureReason, redactor),
    decisionQuestion: redactNullable(task.decisionQuestion, redactor),
    createdAt: redactor.redact(task.createdAt),
    updatedAt: redactor.redact(task.updatedAt),
    goal: redactor.redact(task.goal),
    constraints: task.constraints.map((value) => {
      return redactor.redact(value)
    }),
    targets: task.targets.map((value) => {
      return redactor.redact(value)
    }),
    permissions: task.permissions.map((value) => {
      return redactor.redact(value)
    }),
    summary: redactNullable(task.summary, redactor),
    cancelRequested: task.cancelRequested,
  }
}

function redactAttempt(attempt: AttemptView, redactor: Redactor) {
  return {
    ...attempt,
    taskKey: redactor.redact(attempt.taskKey),
    note: redactNullable(attempt.note, redactor),
    queuedAt: redactor.redact(attempt.queuedAt),
    startedAt: redactNullable(attempt.startedAt, redactor),
    agentFinishedAt: redactNullable(attempt.agentFinishedAt, redactor),
    finishedAt: redactNullable(attempt.finishedAt, redactor),
    model: attempt.model === null ? null : redactor.redactRecord(attempt.model),
    summary: redactNullable(attempt.summary, redactor),
    decisionQuestion: redactNullable(attempt.decisionQuestion, redactor),
    failureReason: redactNullable(attempt.failureReason, redactor),
    failureDetail: redactNullable(attempt.failureDetail, redactor),
    stateDir: redactNullable(attempt.stateDir, redactor),
    evidence: attempt.evidence === null ? null : redactor.redactRecord(attempt.evidence),
  }
}

function redactEvent(event: EventView, redactor: Redactor) {
  return {
    ...event,
    at: redactor.redact(event.at),
    type: redactor.redact(event.type),
    data: redactor.redactRecord(event.data),
  }
}

function commandError(message: string) {
  return Object.assign(new Error(message), { code: 'discord_command_invalid' })
}

// Discord の slash command 定義（REST の applicationGuildCommands に貼る body）
export function discordCommandDefinitionJson() {
  const statusChoices = TASK_STATUSES.map((status) => {
    return { name: status, value: status }
  })

  return [
    {
      name: ARAYA_COMMAND_NAME,
      description: 'Araya の開発 Task を確認・操作する',
      options: [
        {
          type: 1,
          name: 'list',
          description: 'Task の一覧と runner の状態を出す',
          options: [
            {
              type: 3,
              name: 'status',
              description: '状態でのしぼり込み',
              required: false,
              choices: statusChoices,
            },
          ],
        },
        {
          type: 1,
          name: 'show',
          description: 'Task の詳細（SHIKI の要約と途中経過）を出す',
          options: [{ type: 4, name: 'task', description: 'Task ID', required: true }],
        },
        {
          type: 1,
          name: 'submit',
          description: '開発の Task を登録する',
          options: [
            { type: 3, name: 'title', description: '1 行の目的（1〜100 字）', required: true },
            { type: 3, name: 'goal', description: 'ゴール（1〜2000 字）', required: true },
            { type: 3, name: 'targets', description: '変更対象（カンマ区切り）', required: false },
            {
              type: 3,
              name: 'constraints',
              description: '守る条件（カンマ区切り）',
              required: false,
            },
            {
              type: 3,
              name: 'permissions',
              description: '認める操作（カンマ区切り）',
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: 'cancel',
          description: 'Task の中止を求める',
          options: [{ type: 4, name: 'task', description: 'Task ID', required: true }],
        },
        {
          type: 1,
          name: 'retry',
          description: '終わった Task の再実行を求める',
          options: [
            { type: 4, name: 'task', description: 'Task ID', required: true },
            { type: 3, name: 'note', description: '次の試行に渡す指示', required: false },
            {
              type: 5,
              name: 'confirm_side_effects',
              description: '前の試行の git worktree・agent session の始末を認める',
              required: false,
            },
          ],
        },
      ],
    },
  ]
}

function requireTaskId(options: DiscordCommandRequest['options']) {
  const value = options.task

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw commandError('task は 1 以上の数値の Task ID で指定してください')
  }

  return value
}

function requireText(options: DiscordCommandRequest['options'], name: string) {
  const value = options[name]

  if (typeof value !== 'string' || value.trim() === '') {
    throw commandError(`${name} を指定してください`)
  }

  return value.trim()
}

// カンマ区切りの option から項目を作る
function parseListOption(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') {
    return []
  }

  return value
    .split(',')
    .map((item) => {
      return item.trim()
    })
    .filter((item) => {
      return item !== ''
    })
}

function listTasks(request: DiscordCommandRequest, deps: CommandHandlerDeps) {
  const statusValue = request.options.status
  const selectedStatus = TASK_STATUSES.find((status) => {
    return status === String(statusValue)
  })

  if (statusValue !== undefined && selectedStatus === undefined) {
    throw commandError(`status は ${TASK_STATUSES.join('・')} のいずれかです`)
  }

  const tasks = deps.ledger
    .listTasks({
      limit: MAX_LIST_TASKS,
      status: selectedStatus,
    })
    .map((task) => {
      return redactTaskSummary(task, deps.redactor)
    })
  const runner = deps.ledger.readRunner(deps.unit, deps.nowMs())
  const queue = deps.ledger.queueView(MAX_CONCURRENT_ATTEMPTS)

  return chunkMessage(renderTaskList({ tasks, runner, queue })).map((content) => {
    return { content }
  })
}

function showTask(request: DiscordCommandRequest, deps: CommandHandlerDeps) {
  const taskId = requireTaskId(request.options)
  const detail = deps.ledger.showTask(taskId, { events: 8 })

  return renderTaskDetail({
    task: redactTaskView(detail.task, deps.redactor),
    attempts: detail.attempts.map((attempt) => {
      return redactAttempt(attempt, deps.redactor)
    }),
    events: detail.events.map((event) => {
      return redactEvent(event, deps.redactor)
    }),
  }).map((content) => {
    return { content }
  })
}

function submitTask(request: DiscordCommandRequest, deps: CommandHandlerDeps) {
  const title = requireText(request.options, 'title')
  const goal = requireText(request.options, 'goal')
  // 既存 CLI と同じ parser で、台帳の title・goal・list 上限と文字種を検証する
  const parsedInput = parseTaskInput(
    Buffer.from(
      JSON.stringify({
        title,
        goal,
        constraints: parseListOption(request.options.constraints),
        targets: parseListOption(request.options.targets),
        permissions: parseListOption(request.options.permissions),
        idempotencyKey: `discord:${request.interactionId}`,
      }),
    ),
  )
  const input = {
    ...parsedInput,
    title: deps.redactor.redact(parsedInput.title),
    goal: deps.redactor.redact(parsedInput.goal),
    constraints: parsedInput.constraints.map((value) => {
      return deps.redactor.redact(value)
    }),
    targets: parsedInput.targets.map((value) => {
      return deps.redactor.redact(value)
    }),
    permissions: parsedInput.permissions.map((value) => {
      return deps.redactor.redact(value)
    }),
  }
  const { created, task } = deps.ledger.createTask(input)

  const messages = [
    created
      ? `Task #${task.id} を登録しました（待ち）`
      : `Task #${task.id} は既に登録されています（同じ操作の再送と判断しました）`,
  ]
  const runner = deps.ledger.readRunner(deps.unit, deps.nowMs())

  if (runner.state !== 'running') {
    messages.push(
      `warning: ${deps.unit} の unit が稼働していません。araya runner install で稼働させるとこの Task が次の実行になります`,
    )
  }

  return messages.map((content) => {
    return { content }
  })
}

function cancelTask(request: DiscordCommandRequest, deps: CommandHandlerDeps) {
  const taskId = requireTaskId(request.options)
  const result = deps.ledger.cancelTask(taskId, {
    idempotencyKey: `discord:${request.interactionId}`,
  })

  switch (result.cancel) {
    case 'cancelled':
      return [
        { content: `Task #${taskId} を中止しました（実行前だったため Task として取り消しました）` },
      ]
    case 'requested':
      return [
        {
          content: `Task #${taskId} の中止を求めました。runner は次の点検（数秒以内）で session を保存して安全に止まります`,
        },
      ]
    case 'already_requested':
      return [{ content: `Task #${taskId} の中止は既に求められています` }]
  }
}

function retryTask(request: DiscordCommandRequest, deps: CommandHandlerDeps) {
  const taskId = requireTaskId(request.options)
  const noteValue = request.options.note
  const parsedNote = typeof noteValue === 'string' ? parseRetryNote(noteValue) : null
  const note = parsedNote === null ? null : deps.redactor.redact(parsedNote)
  const confirmSideEffects = request.options.confirm_side_effects === true
  const task = deps.ledger.retryTask(taskId, {
    note,
    confirmSideEffects,
    idempotencyKey: `discord:${request.interactionId}`,
  })

  return [
    {
      content: `Task #${task.id} の再実行を受け付けました（試行 ${task.attempt}）。次は ${deps.unit} の unit で実行します`,
    },
  ]
}

function redactReplies(replies: CommandReply[], redactor: Redactor) {
  return replies.map((reply) => {
    return { ...reply, content: redactor.redact(reply.content) }
  })
}

export function handleDiscordCommand(request: DiscordCommandRequest, deps: CommandHandlerDeps) {
  if (
    request.guildId !== deps.config.guildId ||
    request.channelId !== deps.config.channelId ||
    !deps.config.allowedUserIds.includes(request.userId)
  ) {
    return redactReplies(
      [{ content: 'この操作は、設定された channel と許可された user だけが使えます' }],
      deps.redactor,
    )
  }

  try {
    switch (request.subcommand) {
      case 'list':
        return redactReplies(listTasks(request, deps), deps.redactor)
      case 'show':
        return redactReplies(showTask(request, deps), deps.redactor)
      case 'submit':
        return redactReplies(submitTask(request, deps), deps.redactor)
      case 'cancel':
        return redactReplies(cancelTask(request, deps), deps.redactor)
      case 'retry':
        return redactReplies(retryTask(request, deps), deps.redactor)
      default:
        return redactReplies(
          [{ content: '知らない subcommand です（list・show・submit・cancel・retry）' }],
          deps.redactor,
        )
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'discord_command_invalid') {
      return redactReplies([{ content: error.message }], deps.redactor)
    }

    const taskId =
      request.subcommand === 'retry' &&
      typeof request.options.task === 'number' &&
      Number.isSafeInteger(request.options.task) &&
      request.options.task > 0
        ? request.options.task
        : undefined

    return redactReplies([{ content: describeLedgerError(error, taskId) }], deps.redactor)
  }
}
