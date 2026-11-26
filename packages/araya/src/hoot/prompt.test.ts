import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import { buildDecisionPrompt } from './prompt.ts'
import {
  defaultState,
  proposalKeyOf,
  type HootGoal,
  type HootInjectRequest,
  type HootProposal,
} from './model.ts'
import type { HootObservation } from './observe.ts'

const NOW_MS = Date.parse('2026-11-20T00:00:00.000Z')
const PROPOSAL_KEY = proposalKeyOf({ goalKeys: ['araya-quality'], decision: 'dispatch' })

function goalFixture(): HootGoal {
  const now = '2026-11-19T00:00:00.000Z'

  return {
    key: 'araya-quality',
    objective: 'open issue と draft PR を拾って次作業の提案を作る',
    scope: ['github:koh110/araya'],
    constraints: ['merge は人間の承認後だけ'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    reviewAt: '2026-12-19T00:00:00.000Z',
  }
}

function proposalFixture(overrides: Partial<HootProposal> = {}): HootProposal {
  return {
    key: PROPOSAL_KEY,
    decision: 'dispatch',
    goalKeys: ['araya-quality'],
    reason: 'open PR 1 件を main 会話で進める',
    createdAt: '2026-11-19T08:30:00.000Z',
    updatedAt: '2026-11-19T08:30:00.000Z',
    lastReminderAt: null,
    reminders: 0,
    expiresAt: '2026-11-19T12:00:00.000Z',
    status: 'open',
    evidenceOccurrenceKeys: ['hoot:2026-11-19T08:30:00.000Z'],
    ...overrides,
  }
}

function injectFixture(index: number, overrides: Partial<HootInjectRequest> = {}): HootInjectRequest {
  const key = `hoot-inject:${PROPOSAL_KEY}:${index}`

  return {
    key,
    requestId: key,
    proposalKey: PROPOSAL_KEY,
    decision: 'dispatch',
    goalKeys: ['araya-quality'],
    authorizedBy: 'human',
    authorizedAt: '2026-11-19T08:50:00.000Z',
    status: 'injected',
    attempts: 1,
    createdAt: '2026-11-19T08:50:00.000Z',
    updatedAt: '2026-11-19T08:55:00.000Z',
    injectedAt: `2026-11-19T08:5${index}:00.000Z`,
    lastError: null,
    ...overrides,
  }
}

function observationFixture(): HootObservation {
  return { collectedAt: '2026-11-20T00:00:00.000Z', repos: [] }
}

test('hoot prompt: inject 済み案件は open proposal とは別の「inject 済み」block で出す', () => {
  const base = {
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
  }
  const prompt = buildDecisionPrompt({
    ...base,
    openProposals: [],
    recentInjects: [injectFixture(1)],
  })

  assert.match(prompt, /# main 会話に渡した案件/u)
  assert.match(prompt, new RegExp(`proposal=${PROPOSAL_KEY}`, 'u'))
  assert.match(prompt, /人間の承認/u)
  assert.match(prompt, /2026-11-19T08:51:00\.000Z/u)
  // proposal 側は resolved になっているので「未解決の提案」には出ない
  assert.doesNotMatch(prompt, /# 未解決の提案/u)
  assert.match(prompt, /proposal は resolved/u)
})

test('hoot prompt: inject 済みは直近 3 件だけ出し、autoDispatch 承認は そのことを書く', () => {
  const prompt = buildDecisionPrompt({
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
    openProposals: [proposalFixture()],
    recentInjects: [
      injectFixture(1),
      injectFixture(2),
      injectFixture(3, { authorizedBy: 'mode_active' }),
      injectFixture(4),
    ],
  })

  const block = prompt.split('# main 会話に渡した案件')[1] ?? ''
  assert.ok(block.includes(`hoot-inject:${PROPOSAL_KEY}:4`))
  assert.ok(block.includes(`hoot-inject:${PROPOSAL_KEY}:2`))
  assert.ok(!block.includes(`hoot-inject:${PROPOSAL_KEY}:1`))
  assert.match(block, /autoDispatch/u)
  // open proposal が在るときは両方の block が出る
  assert.match(prompt, /# 未解決の提案/u)
})

test('hoot prompt: inject 済みがないと同じ block を出さない（prompt を長くしない）', () => {
  const prompt = buildDecisionPrompt({
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
  })

  assert.doesNotMatch(prompt, /# main 会話に渡した案件/u)
  assert.doesNotMatch(prompt, /# 未解決の提案/u)
})
