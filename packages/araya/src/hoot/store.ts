// HOOT の durable な state（<dataDir>/hoot/state.json）の read / write。
// 書くのは Discord bot process と `araya hoot` CLI。両者が同時に動くので proper-lockfile で
// read-modify-write を直列化する。壊れた JSON は復旧せず誤り（人間が直す）。

import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  DEFAULT_NOTIFY_DECISIONS,
  DIGEST_HOUR_UTC_MAX,
  DIGEST_HOUR_UTC_MIN,
  GOAL_REVIEW_DAYS_MAX,
  GOAL_REVIEW_DAYS_MIN,
  HOOT_DECISIONS,
  HOOT_STATE_VERSION,
  HOOT_STATE_VERSION_INJECT,
  HOOT_STATE_VERSION_PRECHECK,
  HOOT_STATE_VERSION_PRE_CONVERSATION_READ,
  INJECTABLE_DECISIONS,
  INJECT_COOLDOWN_MINUTES_MAX,
  INJECT_COOLDOWN_MINUTES_MIN,
  MAX_GOALS,
  MAX_INJECTS_KEPT,
  MAX_INJECTS_PER_DAY_MAX,
  MAX_INJECTS_PER_DAY_MIN,
  MAX_INJECT_ATTEMPTS,
  MAX_INJECT_ERROR_CHARS,
  MAX_OPEN_PROPOSALS,
  MAX_PROPOSALS_KEPT,
  MAX_PROPOSAL_EVIDENCE_KEYS,
  MAX_PROPOSAL_REMINDERS_MAX,
  MAX_REASON_CHARS,
  MAX_PROPOSAL_REMINDERS_MIN,
  MAX_RUNS_KEPT,
  MAX_RUNS_PER_DAY_MAX,
  MAX_RUNS_PER_DAY_MIN,
  PROPOSAL_TTL_HOURS_MAX,
  PROPOSAL_TTL_HOURS_MIN,
  TICK_MINUTES_MAX,
  TICK_MINUTES_MIN,
  WATCHDOG_HOURS_MAX,
  WATCHDOG_HOURS_MIN,
  hootError,
  injectKeyOf,
  isHootStateShape,
  isHootStateShapeV1,
  isHootStateShapeV2,
  isHootStateShapeV3,
  isSettingsShape,
  isSettingsShapeV1,
  reviewPassed,
  utcDayKey,
  EMPTY_CONVERSATION_READS,
  type HootDecision,
  type HootGoal,
  type HootGoalInput,
  type HootInjectAuthorizer,
  type HootInjectRequest,
  type HootProposal,
  type HootRun,
  type HootSettings,
  type HootState,
  type HootStateV1,
  type HootStateV2,
  type HootStateV3,
  defaultSettings,
  defaultState,
  isoUtc,
  normalizeGoalInput,
  parseIso,
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

  if (isHootStateShape(value)) {
    return value
  }

  // version 3 の file は読み取り時に v4 へ寄せる（書かない）。次の updateHootState で v4 で保存される
  if (isHootStateShapeV3(value)) {
    return migrateStateV3(value)
  }

  // version 2 の file は v3 を経由して v4 に寄せる
  if (isHootStateShapeV2(value)) {
    return migrateStateV3(migrateStateV2(value))
  }

  // version 1 は v2・v3 を経由して v4 に寄せる
  if (isHootStateShapeV1(value) && isSettingsShapeV1(value.settings)) {
    return migrateStateV3(migrateStateV2(migrateStateV1(value, Date.now())))
  }

  throw hootError('hoot_state_invalid', `${filePath} が HOOT state の形ではありません`)
}

// version 3 -> 4。conversationRead の settings と run の参照記録が無くても読めるようにする
function migrateStateV3(state: HootStateV3): HootState {
  const raw = state.settings as unknown as Record<string, unknown>

  return {
    version: HOOT_STATE_VERSION,
    settings: {
      ...state.settings,
      conversationRead:
        typeof raw.conversationRead === 'boolean' ? raw.conversationRead : defaultSettings().conversationRead,
    },
    goals: state.goals,
    loop: state.loop,
    runs: state.runs.map((run) => {
      return { ...run, conversationReads: { ...EMPTY_CONVERSATION_READS } }
    }),
    proposals: state.proposals,
    injectRequests: state.injectRequests,
  }
}

// version 2 -> 3。inject 用の settings が無ければ既定を埋める。時刻から値を作らないので read ごとに動かない
// 返す型は v3 の形（conversationRead と conversationReads は migrateStateV3 で埋める）
function migrateStateV2(state: HootStateV2): HootStateV3 {
  const defaults = defaultSettings()
  const raw = state.settings as unknown as Record<string, unknown>

  return {
    version: HOOT_STATE_VERSION_PRE_CONVERSATION_READ,
    settings: {
      ...defaults,
      ...state.settings,
      autoDispatch: typeof raw.autoDispatch === 'boolean' ? raw.autoDispatch : defaults.autoDispatch,
      maxInjectsPerDay:
        typeof raw.maxInjectsPerDay === 'number' && Number.isInteger(raw.maxInjectsPerDay)
          ? raw.maxInjectsPerDay
          : defaults.maxInjectsPerDay,
      injectCooldownMinutes:
        typeof raw.injectCooldownMinutes === 'number' && Number.isInteger(raw.injectCooldownMinutes)
          ? raw.injectCooldownMinutes
          : defaults.injectCooldownMinutes,
    },
    goals: state.goals,
    loop: state.loop,
    runs: state.runs,
    proposals: state.proposals,
    injectRequests: [],
  }
}

function migrateStateV1(state: HootStateV1, nowMs: number): HootStateV2 {
  // v1 の run には conversationReads が無い。isRunShapeV3 で通る（v4 への埋めは migrateStateV3）
  const settings = defaultSettings()
  settings.enabled = state.settings.enabled
  settings.mode = state.settings.mode
  settings.tickMinutes = state.settings.tickMinutes
  settings.maxRunsPerDay = state.settings.maxRunsPerDay

  // v1 の notifyNoop は notifyDecisions の noop 1 本として引き継ぐ（無い場合は既定のまま）
  settings.notifyDecisions = state.settings.notifyNoop === true
    ? [...DEFAULT_NOTIFY_DECISIONS, 'noop' as HootDecision]
    : [...DEFAULT_NOTIFY_DECISIONS]

  return {
    version: HOOT_STATE_VERSION_INJECT,
    settings,
    goals: state.goals.map((goal) => {
      return { ...goal, reviewAt: migratedReviewAt(state, goal, settings.goalReviewDays, nowMs) }
    }),
    loop: {
      ...state.loop,
      lastModelRunAt: state.loop.lastRunAt,
      lastDigestAt: null,
      conversationRuns: 0,
      goalFingerprints: {},
    },
    runs: state.runs.map((run) => {
      return { ...run, source: 'model' as const }
    }),
    proposals: [],
  }
}

// review 期限の無い version からの migration。基準は file 内容から決める（read のたびに期限が前進しないため）
// v1 の loop.lastRunAt と goal.updatedAt の新しい方 + goalReviewDays。どちらも読めなければ read 時点の now
function migratedReviewAt(
  state: HootStateV1,
  goal: Omit<HootGoal, 'reviewAt'>,
  defaultDays: number,
  nowMs: number
) {
  if (defaultDays === 0) {
    return null
  }

  const anchors = [parseIso(state.loop.lastRunAt), parseIso(goal.updatedAt)].filter((entry) => {
    return entry !== null
  })
  const anchorMs = anchors.length === 0 ? nowMs : Math.max(...anchors)

  return isoUtc(anchorMs + defaultDays * 86_400_000)
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

    // active は「承認された dispatch を main Discord 会話へ inject してよい」を意味する（Issue #31）。
    // 既定の autoDispatch=false では人間の `araya hoot dispatch` が無い限り inject しない
    next.mode = patch.mode
  }

  if (patch.conversationRead !== undefined) {
    if (typeof patch.conversationRead !== 'boolean') {
      throw hootError('hoot_settings_invalid', 'conversationRead は true / false にしてください')
    }

    // 判断 run に main Discord 会話を読む read-only tool を渡すかどうか。true でも tool は読むだけで、
    // 会話への submit・file 編集・HOOT state 変更はできない
    next.conversationRead = patch.conversationRead
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

  if (patch.notifyDecisions !== undefined) {
    const decisions = [...new Set(patch.notifyDecisions)]

    for (const entry of decisions) {
      if (!HOOT_DECISIONS.includes(entry)) {
        throw hootError(
          'hoot_settings_invalid',
          `notifyDecisions は ${HOOT_DECISIONS.join(' / ')} の組合せにしてください（${entry}）`
        )
      }
    }

    next.notifyDecisions = decisions
  }

  if (patch.precheckObservation !== undefined) {
    if (typeof patch.precheckObservation !== 'boolean') {
      throw hootError('hoot_settings_invalid', 'precheckObservation は true / false にしてください')
    }

    next.precheckObservation = patch.precheckObservation
  }

  if (patch.watchdogHours !== undefined) {
    assertBoundedInt(patch.watchdogHours, WATCHDOG_HOURS_MIN, WATCHDOG_HOURS_MAX, 'watchdogHours')
    next.watchdogHours = patch.watchdogHours
  }

  if (patch.digestHourUtc !== undefined) {
    if (patch.digestHourUtc !== null) {
      assertBoundedInt(patch.digestHourUtc, DIGEST_HOUR_UTC_MIN, DIGEST_HOUR_UTC_MAX, 'digestHourUtc')
    }

    next.digestHourUtc = patch.digestHourUtc
  }

  if (patch.resetConversationAfterRuns !== undefined) {
    assertBoundedInt(patch.resetConversationAfterRuns, 0, 1000, 'resetConversationAfterRuns')
    next.resetConversationAfterRuns = patch.resetConversationAfterRuns
  }

  if (patch.goalReviewDays !== undefined) {
    assertBoundedInt(patch.goalReviewDays, GOAL_REVIEW_DAYS_MIN, GOAL_REVIEW_DAYS_MAX, 'goalReviewDays')
    next.goalReviewDays = patch.goalReviewDays
  }

  if (patch.proposalTtlHours !== undefined) {
    assertBoundedInt(patch.proposalTtlHours, PROPOSAL_TTL_HOURS_MIN, PROPOSAL_TTL_HOURS_MAX, 'proposalTtlHours')
    next.proposalTtlHours = patch.proposalTtlHours
  }

  if (patch.maxProposalReminders !== undefined) {
    assertBoundedInt(patch.maxProposalReminders, MAX_PROPOSAL_REMINDERS_MIN, MAX_PROPOSAL_REMINDERS_MAX, 'maxProposalReminders')
    next.maxProposalReminders = patch.maxProposalReminders
  }

  if (patch.autoDispatch !== undefined) {
    if (typeof patch.autoDispatch !== 'boolean') {
      throw hootError('hoot_settings_invalid', 'autoDispatch は true / false にしてください')
    }

    next.autoDispatch = patch.autoDispatch
  }

  if (patch.maxInjectsPerDay !== undefined) {
    assertBoundedInt(patch.maxInjectsPerDay, MAX_INJECTS_PER_DAY_MIN, MAX_INJECTS_PER_DAY_MAX, 'maxInjectsPerDay')
    next.maxInjectsPerDay = patch.maxInjectsPerDay
  }

  if (patch.injectCooldownMinutes !== undefined) {
    assertBoundedInt(patch.injectCooldownMinutes, INJECT_COOLDOWN_MINUTES_MIN, INJECT_COOLDOWN_MINUTES_MAX, 'injectCooldownMinutes')
    next.injectCooldownMinutes = patch.injectCooldownMinutes
  }

  return next
}

function assertBoundedInt(value: unknown, min: number, max: number, name: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw hootError('hoot_settings_invalid', `${name} は ${min}〜${max} の integer にしてください（${String(value)}）`)
  }
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

    const nowMs = Date.now()
    const reviewDefaultDays = state.settings.goalReviewDays
    const goal = normalizeGoalInput(
      {
        ...input,
        // reviewAt 未指定: 新しい goal は settings.goalReviewDays の既定、既存 goal の更新は前の期限を守る
        // （編集で review 期限を伸ばさない。'none' / null は無期限として据える）
        reviewAt:
          input.reviewAt !== undefined
            ? input.reviewAt
            : existingIndex >= 0
              ? (state.goals[existingIndex]?.reviewAt ?? undefined)
              : undefined,
      },
      nowMs,
      reviewDefaultDays
    )

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

    const nowMs = Date.now()
    goal.status = status
    goal.updatedAt = isoUtc(nowMs)

    // review 期限を過ぎた goal を active に戻すとき、期限を伸ばさないと次の tick で即再 pause になる
    // （無期限の goal は null のまま。まだ過ぎていない期限は動かさない）
    if (status === 'active' && goal.reviewAt !== null && reviewPassed(goal, nowMs)) {
      const days = state.settings.goalReviewDays
      goal.reviewAt = days === 0 ? null : isoUtc(nowMs + days * 86_400_000)
    }

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

    // model を呼んだ run は watchdog の基準も同時に進める（precheck noop は lastModelRunAt を進めない）
    if (run.source === 'model') {
      state.loop.lastModelRunAt = run.decidedAt
    }

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

// review 期限を過ぎた active goal を自動 paused にする（model を呼ばない決定的な歯止め）
export async function pauseExpiredGoals(dataDir: string, nowMs: number) {
  return await updateHootState(dataDir, (state) => {
    const paused: HootGoal[] = []

    for (const goal of state.goals) {
      if (goal.status === 'active' && reviewPassed(goal, nowMs)) {
        goal.status = 'paused'
        goal.updatedAt = isoUtc(nowMs)
        paused.push({ ...goal })
      }
    }

    return paused
  })
}

// 判断 run の提案を goal keys + decision で 1 件に寄せる（人間が応答するまで同じ種類の提案を積み上げない）。
// 根拠の観測 fingerprint と occurrence key は evidence として proposal に残す
export async function upsertProposal(
  dataDir: string,
  input: {
    key: string
    decision: HootDecision
    goalKeys: readonly string[]
    reason: string
    occurrenceKey: string
    nowMs: number
  }
) {
  return await updateHootState(dataDir, (state) => {
    const nowIso = isoUtc(input.nowMs)
    const expiresAt = isoUtc(input.nowMs + state.settings.proposalTtlHours * 3_600_000)
    const existing = state.proposals.find((proposal) => {
      return proposal.key === input.key && proposal.status === 'open'
    })

    if (existing !== undefined) {
      // 最新の観測で reason と evidence だけ更新する。期限と提醒の回数は人間が応答するまで据え置く
      existing.reason = input.reason.slice(0, MAX_REASON_CHARS)
      existing.updatedAt = nowIso

      if (!existing.evidenceOccurrenceKeys.includes(input.occurrenceKey)) {
        existing.evidenceOccurrenceKeys.push(input.occurrenceKey)

        if (existing.evidenceOccurrenceKeys.length > MAX_PROPOSAL_EVIDENCE_KEYS) {
          existing.evidenceOccurrenceKeys.splice(0, existing.evidenceOccurrenceKeys.length - MAX_PROPOSAL_EVIDENCE_KEYS)
        }
      }

      return { proposal: existing, created: false }
    }

    const openCount = state.proposals.filter((proposal) => {
      return proposal.status === 'open'
    }).length

    if (openCount >= MAX_OPEN_PROPOSALS) {
      return { proposal: null as HootProposal | null, created: false }
    }

    const proposal: HootProposal = {
      key: input.key,
      decision: input.decision,
      goalKeys: [...new Set(input.goalKeys)].sort(),
      reason: input.reason.slice(0, MAX_REASON_CHARS),
      createdAt: nowIso,
      updatedAt: nowIso,
      lastReminderAt: null,
      reminders: 0,
      expiresAt,
      status: 'open',
      evidenceOccurrenceKeys: [input.occurrenceKey],
    }
    state.proposals.push(proposal)

    if (state.proposals.length > MAX_PROPOSALS_KEPT) {
      // closed（resolved / expired）を古い順に落として open を残す
      const closedIndex = state.proposals.findIndex((entry) => {
        return entry.status !== 'open'
      })
      state.proposals.splice(closedIndex < 0 ? 0 : closedIndex, 1)
    }

    return { proposal, created: true }
  })
}

export type ProposalReminder = {
  proposal: HootProposal
  reminderIndex: number
}

// 期限切れを closed にし、再提醒が約束通り届くものを 1 件取り出す（backoff: tickMinutes * 2^n）
export async function takeProposalReminder(dataDir: string, input: { nowMs: number; everyMs: number }) {
  return await updateHootState(dataDir, (state) => {
    const nowIso = isoUtc(input.nowMs)

    for (const proposal of state.proposals) {
      const expiresAt = parseIso(proposal.expiresAt)

      if (proposal.status === 'open' && expiresAt !== null && expiresAt <= input.nowMs) {
        proposal.status = 'expired'
      }
    }

    if (state.settings.maxProposalReminders === 0) {
      return null as ProposalReminder | null
    }

    const due = state.proposals.find((proposal) => {
      if (proposal.status !== 'open' || proposal.reminders >= state.settings.maxProposalReminders) {
        return false
      }

      const base = parseIso(proposal.lastReminderAt ?? proposal.createdAt)

      if (base === null) {
        return false
      }

      return base + input.everyMs * 2 ** proposal.reminders <= input.nowMs
    })

    if (due === undefined) {
      return null as ProposalReminder | null
    }

    due.reminders += 1
    due.lastReminderAt = nowIso

    return { proposal: { ...due }, reminderIndex: due.reminders } satisfies ProposalReminder
  })
}

export async function resolveProposal(dataDir: string, key: string, nowMs = Date.now()) {
  return await updateHootState(dataDir, (state) => {
    const proposal = state.proposals.find((entry) => {
      return entry.key === key.trim() && entry.status === 'open'
    })

    if (proposal === undefined) {
      throw hootError('hoot_proposal_not_found', `open な proposal key ${key} がありません`)
    }

    proposal.status = 'resolved'
    proposal.updatedAt = isoUtc(nowMs)

    return proposal
  })
}

// ---- main Discord 会話への inject request（Issue #31）----
// ここに tool は無い。pending を作るのは承認（人間の CLI か mode=active + autoDispatch）で、
// 実行（main 会話への submit）は bot process だけが行う

export type HootInjectSkip = 'cooldown' | 'daily_limit' | 'auto_dispatch_off' | 'already_pending'

export type HootInjectEnqueue = {
  request: HootInjectRequest | null
  skipped: HootInjectSkip | null
}

export async function enqueueHootInject(
  dataDir: string,
  input: { proposalKey: string; authorizedBy: HootInjectAuthorizer; nowMs: number }
): Promise<HootInjectEnqueue> {
  return await updateHootState(dataDir, (state): HootInjectEnqueue => {
    if (state.settings.mode !== 'active') {
      throw hootError(
        'hoot_mode_dry_run',
        'mode が dry_run の間は main 会話への inject を作りません（araya hoot settings set --mode active / Discord の /hoot settings set mode:active）'
      )
    }

    const key = input.proposalKey.trim()
    const proposal = state.proposals.find((entry) => {
      return entry.key === key
    })

    if (proposal === undefined) {
      throw hootError('hoot_proposal_not_found', `proposal key ${key} がありません`)
    }

    if (proposal.status !== 'open') {
      throw hootError('hoot_proposal_not_found', `proposal key ${key} は open ではありません（status: ${proposal.status}）`)
    }

    if (!INJECTABLE_DECISIONS.includes(proposal.decision)) {
      throw hootError(
        'hoot_inject_not_injectable',
        `proposal ${key} の decision ${proposal.decision} は inject できません（${INJECTABLE_DECISIONS.join(' / ')} だけ）`
      )
    }

    if (input.authorizedBy === 'mode_active' && !state.settings.autoDispatch) {
      return { request: null, skipped: 'auto_dispatch_off' }
    }

    const sameProposal = state.injectRequests.filter((entry) => {
      return entry.proposalKey === proposal.key
    })

    // 同じ proposal への submit が未完了のうちに重ねて流さない
    if (sameProposal.some((entry) => {
      return entry.status === 'pending'
    })) {
      return { request: null, skipped: 'already_pending' }
    }

    const nowIso = isoUtc(input.nowMs)
    const cooldownMinutes = state.settings.injectCooldownMinutes

    if (cooldownMinutes > 0) {
      const createdAts = state.injectRequests
        .map((entry) => {
          return parseIso(entry.createdAt)
        })
        .filter((entry) => {
          return entry !== null
        })

      if (createdAts.length > 0) {
        const lastAt = Math.max(...createdAts)

        if (lastAt + cooldownMinutes * 60_000 > input.nowMs) {
          return { request: null, skipped: 'cooldown' }
        }
      }
    }

    const day = utcDayKey(input.nowMs)
    const todayCount = state.injectRequests.filter((entry) => {
      const createdAt = parseIso(entry.createdAt)

      return createdAt !== null && utcDayKey(createdAt) === day
    }).length

    if (todayCount >= state.settings.maxInjectsPerDay) {
      return { request: null, skipped: 'daily_limit' }
    }

    const request: HootInjectRequest = {
      key: injectKeyOf(proposal.key, sameProposal.length + 1),
      proposalKey: proposal.key,
      goalKeys: [...proposal.goalKeys],
      decision: proposal.decision,
      authorizedBy: input.authorizedBy,
      authorizedAt: nowIso,
      status: 'pending',
      requestId: injectKeyOf(proposal.key, sameProposal.length + 1),
      createdAt: nowIso,
      updatedAt: nowIso,
      attempts: 0,
      injectedAt: null,
      lastError: null,
    }
    state.injectRequests.push(request)

    if (state.injectRequests.length > MAX_INJECTS_KEPT) {
      // pending を残して terminal（injected / failed）を古い順に落とす
      const dropIndex = state.injectRequests.findIndex((entry) => {
        return entry.status !== 'pending'
      })
      state.injectRequests.splice(dropIndex < 0 ? 0 : dropIndex, 1)
    }

    return { request, skipped: null }
  })
}

// pending を 1 件取り出して attempts を 1 増やす。取り出しと実行の間に crash しても
// attempts が MAX_INJECT_ATTEMPTS に達すれば二度と選ばれない（無限再試行をしない）。
// requestId は attempt を含まないまま据え置く: 同じ key での再 submit は Pi durable 側が 1 回に
// 束ねるので、同じ dispatch で main 会話を 2 度走らせない（retry 回数は attempts だけで数える）
export async function takePendingInject(dataDir: string, nowMs: number) {
  return await updateHootState(dataDir, (state) => {
    const candidates = state.injectRequests
      .filter((entry) => {
        return entry.status === 'pending' && entry.attempts < MAX_INJECT_ATTEMPTS
      })
      .sort((left, right) => {
        return (parseIso(left.createdAt) ?? 0) - (parseIso(right.createdAt) ?? 0)
      })
    const candidate = candidates[0]

    if (candidate === undefined) {
      return null as HootInjectRequest | null
    }

    candidate.attempts += 1
    candidate.updatedAt = isoUtc(nowMs)

    return { ...candidate } satisfies HootInjectRequest
  })
}

export async function finishHootInject(
  dataDir: string,
  key: string,
  input: { ok: boolean; nowMs: number; error?: string }
) {
  return await updateHootState(dataDir, (state) => {
    const request = state.injectRequests.find((entry) => {
      return entry.key === key
    })

    if (request === undefined) {
      throw hootError('hoot_inject_not_found', `inject request ${key} がありません`)
    }

    const nowIso = isoUtc(input.nowMs)
    request.updatedAt = nowIso
    request.attempts = Math.max(1, request.attempts)

    if (input.ok) {
      request.status = 'injected'
      request.injectedAt = nowIso
      request.lastError = null
    } else {
      // attempts が上限に達していれば pending に戻さない（CLI で新しい承認を作り直せる）
      request.status = request.attempts >= MAX_INJECT_ATTEMPTS ? 'failed' : 'pending'
      request.lastError = (input.error ?? 'inject 失敗').slice(0, MAX_INJECT_ERROR_CHARS)
      request.injectedAt = null
    }

    return { ...request } satisfies HootInjectRequest
  })
}

// digest を送った時刻を記録（1 UTC 日 1 回の抑止）
export async function recordHootDigest(dataDir: string, nowMs: number) {
  return await updateHootState(dataDir, (state) => {
    state.loop.lastDigestAt = isoUtc(nowMs)

    return utcDayKey(nowMs)
  })
}
