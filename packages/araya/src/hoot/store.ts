// HOOT の durable な state（<dataDir>/hoot/state.json）の read / write。
// 書くのは Discord bot process と `araya hoot` CLI。両者が同時に動くので proper-lockfile で
// read-modify-write を直列化する。壊れた JSON は復旧せず誤り（人間が直す）。

import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  MAX_GOALS,
  MAX_RUNS_KEPT,
  MAX_RUNS_PER_DAY_MAX,
  MAX_RUNS_PER_DAY_MIN,
  TICK_MINUTES_MAX,
  TICK_MINUTES_MIN,
  hootError,
  isHootStateShape,
  type HootGoal,
  type HootGoalInput,
  type HootRun,
  type HootSettings,
  type HootState,
  defaultState,
  normalizeGoalInput,
} from './model.ts'

type Lockfile = {
  lock: (target: string, options: Record<string, unknown>) => Promise<() => Promise<void>>
}

const properLockfile = createRequire(import.meta.url)('proper-lockfile') as Lockfile

export const HOOT_LOCK_STALE_MS = 30_000

export function hootDirectory(dataDir: string) {
  return path.join(dataDir, 'hoot')
}

export function hootStateFilePath(dataDir: string) {
  return path.join(hootDirectory(dataDir), 'state.json')
}

export async function readHootState(dataDir: string): Promise<HootState> {
  const filePath = hootStateFilePath(dataDir)
  let text: string

  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return defaultState()
    }

    throw error
  }

  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    throw hootError('hoot_state_invalid', `${filePath} は有効な JSON ではありません`)
  }

  if (!isHootStateShape(value)) {
    throw hootError('hoot_state_invalid', `${filePath} が HOOT state の形ではありません`)
  }

  return value
}

// 同じ directory の一時 file（mode 0600）に書いてから rename する
export async function writeHootState(dataDir: string, state: HootState) {
  if (!isHootStateShape(state)) {
    throw hootError('hoot_state_invalid', 'HOOT state の形が壊れています')
  }

  const directory = hootDirectory(dataDir)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(directory, `.state.${randomBytes(6).toString('hex')}.tmp`)

  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    await fs.rename(temporaryPath, hootStateFilePath(dataDir))
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {
      // 一時 file が無いなどの後始末の失敗は元の誤りに隠す
    })

    throw error
  }
}

export async function updateHootState<T>(
  dataDir: string,
  mutate: (state: HootState) => T | Promise<T>
): Promise<T> {
  const directory = hootDirectory(dataDir)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const release = await properLockfile.lock(directory, {
    lockfilePath: path.join(directory, '.state.lock'),
    stale: HOOT_LOCK_STALE_MS,
    retries: { retries: 20, factor: 1.6, minTimeout: 40, maxTimeout: 1000 },
  })

  try {
    const state = await readHootState(dataDir)
    const result = await mutate(state)
    await writeHootState(dataDir, state)

    return result
  } finally {
    await release()
  }
}

export function mergeSettings(current: HootSettings, patch: Partial<HootSettings>): HootSettings {
  const next: HootSettings = { ...current }

  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled
  }

  if (patch.mode !== undefined) {
    if (patch.mode !== 'dry_run' && patch.mode !== 'active') {
      throw hootError('hoot_settings_invalid', "mode は 'dry_run' または 'active' にしてください")
    }

    // 判断 run には tool が無い。dispatch を実行する mechanism ができるまで active にはできない
    if (patch.mode === 'active') {
      throw hootError(
        'hoot_mode_unimplemented',
        'mode=active は未実装です（判断の記録ではなく作業を実行する path がまだ無い）。dry_run のまま使ってください'
      )
    }

    next.mode = patch.mode
  }

  if (patch.tickMinutes !== undefined) {
    if (
      !Number.isInteger(patch.tickMinutes) ||
      patch.tickMinutes < TICK_MINUTES_MIN ||
      patch.tickMinutes > TICK_MINUTES_MAX
    ) {
      throw hootError(
        'hoot_settings_invalid',
        `tickMinutes は ${TICK_MINUTES_MIN}〜${TICK_MINUTES_MAX} の integer にしてください`
      )
    }

    next.tickMinutes = patch.tickMinutes
  }

  if (patch.maxRunsPerDay !== undefined) {
    if (
      !Number.isInteger(patch.maxRunsPerDay) ||
      patch.maxRunsPerDay < MAX_RUNS_PER_DAY_MIN ||
      patch.maxRunsPerDay > MAX_RUNS_PER_DAY_MAX
    ) {
      throw hootError(
        'hoot_settings_invalid',
        `maxRunsPerDay は ${MAX_RUNS_PER_DAY_MIN}〜${MAX_RUNS_PER_DAY_MAX} の integer にしてください`
      )
    }

    next.maxRunsPerDay = patch.maxRunsPerDay
  }

  if (patch.notifyNoop !== undefined) {
    next.notifyNoop = patch.notifyNoop
  }

  return next
}

export async function setGoal(dataDir: string, input: HootGoalInput, options: { replace?: boolean } = {}) {
  return await updateHootState(dataDir, (state) => {
    const existingIndex = state.goals.findIndex((goal) => {
      return goal.key === input.key.trim()
    })

    if (existingIndex < 0 && state.goals.length >= MAX_GOALS) {
      throw hootError('hoot_goal_limit', `goal は最大 ${MAX_GOALS} 件です`)
    }

    if (existingIndex >= 0 && options.replace === false) {
      throw hootError('hoot_goal_exists', `goal key ${input.key} は既にあります`)
    }

    const goal = normalizeGoalInput(input)

    if (existingIndex >= 0) {
      const previous = state.goals[existingIndex]
      state.goals[existingIndex] = { ...goal, createdAt: previous?.createdAt ?? goal.createdAt }

      return { goal: state.goals[existingIndex] as HootGoal, created: false }
    }

    state.goals.push(goal)

    return { goal, created: true }
  })
}

export async function setGoalStatus(dataDir: string, key: string, status: HootGoal['status']) {
  return await updateHootState(dataDir, (state) => {
    const goal = state.goals.find((entry) => {
      return entry.key === key.trim()
    })

    if (goal === undefined) {
      throw hootError('hoot_goal_not_found', `goal key ${key} がありません`)
    }

    goal.status = status
    goal.updatedAt = new Date().toISOString()

    return goal
  })
}

export async function updateSettings(dataDir: string, patch: Partial<HootSettings>) {
  return await updateHootState(dataDir, (state) => {
    state.settings = mergeSettings(state.settings, patch)

    return state.settings
  })
}

export async function resetSchedule(dataDir: string) {
  return await updateHootState(dataDir, (state) => {
    state.loop.lastOccurrenceAt = null

    return state.loop
  })
}

// 同じ occurrenceKey の run があれば書かない（再起動で同じ tick を再び実行しないための guard）
export async function recordHootRun(dataDir: string, run: HootRun) {
  return await updateHootState(dataDir, (state) => {
    const existing = state.runs.find((entry) => {
      return entry.occurrenceKey === run.occurrenceKey
    })

    if (existing !== undefined) {
      return { run: existing, recorded: false }
    }

    state.runs.push(run)

    if (state.runs.length > MAX_RUNS_KEPT) {
      state.runs.splice(0, state.runs.length - MAX_RUNS_KEPT)
    }

    state.loop.lastOccurrenceAt = run.plannedAt
    state.loop.lastRunAt = run.decidedAt

    return { run, recorded: true }
  })
}

export async function setHootConversationId(dataDir: string, conversationId: number) {
  return await updateHootState(dataDir, (state) => {
    if (state.loop.conversationId === conversationId) {
      return conversationId
    }

    state.loop.conversationId = conversationId

    return conversationId
  })
}
