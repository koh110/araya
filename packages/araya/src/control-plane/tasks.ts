import type { Context } from '@earendil-works/chord'
import { defineTask, type TaskId } from '@earendil-works/pi-durable'

import type { ControlPlane } from './store.ts'
import { readObservationSource } from './observations.ts'

export const TASK_NAMES = {
  scout: 'araya.scout',
  work: 'araya.work'
} as const

export type ScoutInput = {
  tickId: string
  maxActions: number
}

export type ScoutResult = {
  action: 'none' | 'processed'
  opportunityIds: string[]
}

export type ScoutState =
  | {
      phase: 'discover'
    }
  | {
      phase: 'review'
      opportunityIds: string[]
      childTaskIds: readonly TaskId<WorkResult>[]
    }

export type WorkInput = {
  opportunityId: string
}

export type WorkResult = {
  status:
    | 'already_handled'
    | 'approval_requested'
    | 'approval_applied'
    | 'no_executor'
    | 'rejected'
    | 'development_failed'
    | 'failed'
  opportunityId: string
}

export type WorkState = {
  phase: 'analyze'
}

export type ScoutTaskType = ReturnType<typeof createScoutTask>
export type WorkTaskType = ReturnType<typeof createWorkTask>

export type ArayaTasks = {
  ScoutTask: ScoutTaskType
  WorkTask: WorkTaskType
}

function terminalCompleted<R>(result: R): { status: 'terminal'; outcome: { status: 'completed'; result: R } } {
  return { status: 'terminal', outcome: { status: 'completed', result } }
}

function terminalFailed<R>(message: string): { status: 'terminal'; outcome: { status: 'failed'; error: { message: string } } } {
  return { status: 'terminal', outcome: { status: 'failed', error: { message } } }
}

export function createWorkTask(controlPlane: ControlPlane) {
  const WorkTask = defineTask<WorkInput, WorkState, WorkResult>({
    name: TASK_NAMES.work,
    version: 1,
    initial: () => ({ phase: 'analyze' }),
    phases: {
      analyze: async (task, runtime, context: Context) => {
        try {
          const opportunity = controlPlane.getOpportunity(task.input.opportunityId)

          if (opportunity === undefined) {
            return runtime.commit(() => terminalFailed<WorkResult>('opportunity not found'), context)
          }

          const now = runtime.now()

          if (
            opportunity.status === 'completed' ||
            opportunity.status === 'blocked' ||
            opportunity.status === 'approval_requested' ||
            opportunity.status === 'rejected' ||
            opportunity.status === 'failed'
          ) {
            const result: WorkResult = {
              status: 'already_handled',
              opportunityId: opportunity.id
            }

            return runtime.commit(() => terminalCompleted(result), context)
          }

          if (opportunity.kind === 'development' || opportunity.risk === 'workspace') {
            if (opportunity.kind !== 'development' || opportunity.risk !== 'workspace') {
              controlPlane.setOpportunityStatus(
                opportunity.id,
                'failed',
                { type: 'invalid_development_scope', kind: opportunity.kind, risk: opportunity.risk },
                now
              )

              return runtime.commit(() => terminalCompleted({
                status: 'development_failed',
                opportunityId: opportunity.id
              }), context)
            }

            if (opportunity.status !== 'discovered') {
              const result: WorkResult = {
                status: 'already_handled',
                opportunityId: opportunity.id
              }

              return runtime.commit(() => terminalCompleted(result), context)
            }

            controlPlane.setOpportunityStatus(
              opportunity.id,
              'blocked',
              { type: 'development_executor_unavailable', opportunityId: opportunity.id },
              now
            )

            return runtime.commit(() => terminalCompleted({
              status: 'no_executor',
              opportunityId: opportunity.id
            }), context)
          }

          if (opportunity.status === 'discovered') {
            controlPlane.setOpportunityStatus(
              opportunity.id,
              'scouting',
              { type: 'work_started', opportunityId: opportunity.id },
              now
            )

            if (opportunity.risk === 'read-only') {
              controlPlane.setOpportunityStatus(
                opportunity.id,
                'blocked',
                {
                  type: 'no_read_only_executor',
                  opportunityId: opportunity.id
                },
                now
              )

              const result: WorkResult = {
                status: 'no_executor',
                opportunityId: opportunity.id
              }

              return runtime.commit(() => terminalCompleted(result), context)
            }

            controlPlane.requestApproval(
              opportunity.id,
              `araya 承認待ち: ${opportunity.title}`,
              now
            )

            const result: WorkResult = {
              status: 'approval_requested',
              opportunityId: opportunity.id
            }

            return runtime.commit(() => terminalCompleted(result), context)
          }

          if (opportunity.status === 'scouting') {
            if (opportunity.risk === 'read-only') {
              controlPlane.setOpportunityStatus(
                opportunity.id,
                'blocked',
                {
                  type: 'no_read_only_executor',
                  opportunityId: opportunity.id
                },
                now
              )

              const result: WorkResult = {
                status: 'no_executor',
                opportunityId: opportunity.id
              }

              return runtime.commit(() => terminalCompleted(result), context)
            }

            controlPlane.requestApproval(
              opportunity.id,
              `araya 承認待ち: ${opportunity.title}`,
              now
            )

            const result: WorkResult = {
              status: 'approval_requested',
              opportunityId: opportunity.id
            }

            return runtime.commit(() => terminalCompleted(result), context)
          }

          if (opportunity.status === 'approved') {
            controlPlane.setOpportunityStatus(
              opportunity.id,
              'blocked',
              {
                type: 'no_external_executor',
                decision: 'approved',
                opportunityId: opportunity.id
              },
              now
            )

            const result: WorkResult = {
              status: 'approval_applied',
              opportunityId: opportunity.id
            }

            return runtime.commit(() => terminalCompleted(result), context)
          }

          controlPlane.setOpportunityStatus(
            opportunity.id,
            'failed',
            { type: 'invalid_opportunity_status', status: opportunity.status },
            now
          )

          return runtime.commit(() => terminalFailed<WorkResult>(`invalid opportunity status: ${opportunity.status}`), context)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          controlPlane.appendEvent(
            'work.faulted',
            'opportunity',
            task.input.opportunityId,
            { error: message },
            runtime.now()
          )

          await runtime.commit(() => terminalFailed<WorkResult>(message), context)
        }
      }
    },
    abort: async (task, runtime, context: Context) => {
      await runtime.commit(
        () => ({
          status: 'terminal',
          outcome: {
            status: 'aborted',
            reason: 'araya work task aborted'
          }
        }),
        context
      )
    }
  })

  return WorkTask
}

export function createScoutTask(
  controlPlane: ControlPlane,
  workTask: WorkTaskType,
  inboxDir: string,
  goalId: string,
  goalIntervalMs: number
) {
  const ScoutTask = defineTask<ScoutInput, ScoutState, ScoutResult>({
    name: TASK_NAMES.scout,
    version: 1,
    initial: () => ({ phase: 'discover' }),
    phases: {
      discover: async (task, runtime, context: Context) => {
        const now = runtime.now()
        const source = await readObservationSource(inboxDir)
        controlPlane.recordObservationBatch(source.observations, goalId, now)

        if (source.errors.length > 0) {
          controlPlane.appendEvent(
            'inbox.read_errors',
            'inbox',
            'inbox',
            { errors: source.errors },
            now
          )
        }

        const actionable = controlPlane.listOpportunitiesByStatus(
          ['discovered', 'scouting', 'approved'],
          task.input.maxActions
        )

        if (actionable.length === 0) {
          await runtime.commit(() => terminalCompleted<ScoutResult>({ action: 'none', opportunityIds: [] }), context)
          controlPlane.markGoalWake(goalId, now, now + goalIntervalMs)

          return
        }

        const selected: typeof actionable = []
        let developmentSelected = false

        for (const opportunity of actionable) {
          if (selected.length >= task.input.maxActions) {
            break
          }

          if (opportunity.risk === 'workspace') {
            if (developmentSelected) {
              continue
            }

            developmentSelected = true
          }

          selected.push(opportunity)
        }

        const selectedIds = selected.map((opportunity) => opportunity.id)
        const childTaskIds: TaskId<WorkResult>[] = []

        await runtime.commit(async (tx) => {
          for (const opportunity of selected) {
            const childTaskId = await tx.createTask(
              workTask,
              { opportunityId: opportunity.id },
              {
                ownership: { kind: 'task', taskId: runtime.taskId },
                background: false
              }
            )

            childTaskIds.push(childTaskId)
          }

          const checkpoint: ScoutState = {
            phase: 'review',
            opportunityIds: selectedIds,
            childTaskIds
          }

          return {
            status: 'waiting',
            checkpoint,
            on: childTaskIds,
            policy: 'allSettled'
          }
        }, context)

        controlPlane.appendEvent(
          'scout.dispatched',
          'scout',
          task.input.tickId,
          { opportunityIds: selectedIds },
          now
        )
      },
      review: async (task, runtime, context: Context) => {
        const checkpoint = task.state.checkpoint
        const outcomes = await runtime.outcomes(checkpoint.childTaskIds, context)
        const result: ScoutResult = {
          action: 'processed',
          opportunityIds: checkpoint.opportunityIds
        }

        await runtime.commit(() => terminalCompleted(result), context)

        const now = runtime.now()
        controlPlane.appendEvent(
          'scout.reviewed',
          'scout',
          task.input.tickId,
          { outcomes: outcomes.map((outcome) => outcome.status) },
          now
        )
        controlPlane.markGoalWake(goalId, now, now + goalIntervalMs)
      }
    },
    abort: async (task, runtime, context: Context) => {
      await runtime.commit(
        () => ({
          status: 'terminal',
          outcome: {
            status: 'aborted',
            reason: 'araya scout task aborted'
          }
        }),
        context
      )
    }
  })

  return ScoutTask
}

export function createArayaTasks(
  controlPlane: ControlPlane,
  inboxDir: string,
  goalId: string,
  goalIntervalMs: number
): ArayaTasks {
  const WorkTask = createWorkTask(controlPlane)
  const ScoutTask = createScoutTask(controlPlane, WorkTask, inboxDir, goalId, goalIntervalMs)

  return { ScoutTask, WorkTask }
}
