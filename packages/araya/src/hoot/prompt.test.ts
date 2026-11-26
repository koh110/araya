import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import { buildDecisionPrompt, PROMPT_EVIDENCE_GOALS } from './prompt.ts'
import {
  MAX_EVIDENCE_NUMBERS_SHOWN,
  defaultState,
  proposalKeyOf,
  type HootGoal,
  type HootGoalEvidence,
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

function injectFixture(
  index: number,
  overrides: Partial<HootInjectRequest> = {},
): HootInjectRequest {
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
    deliveredEvidenceKey: null,
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

// ---- delivery 後の観測差（effect evidence）block（Issue #10 acceptance 5）----

function goalEvidenceFixture(
  goalKey: string,
  overrides: Partial<HootGoalEvidence> = {},
): HootGoalEvidence {
  return {
    goalKey,
    deliveries: [
      {
        injectKey: `hoot-inject:${PROPOSAL_KEY}:1`,
        proposalKey: PROPOSAL_KEY,
        decision: 'dispatch',
        injectedAt: '2026-11-19T08:55:00.000Z',
        deliveredEvidenceKey: 'hoot:2026-11-19T08:00:00.000Z',
        delta: [
          {
            repo: 'koh110/araya',
            closedIssues: ['10', '12'],
            closedPrs: [],
            openedIssues: [],
            openedPrs: ['33'],
            beforeKey: 'hoot:2026-11-19T08:00:00.000Z',
            afterKey: 'hoot:2026-11-19T09:00:00.000Z',
          },
        ],
      },
    ],
    ...overrides,
  }
}

test('hoot prompt: delivery 後の観測差 block を inject 済み block の後ろに出す（closed / merged は断定しない）', () => {
  const prompt = buildDecisionPrompt({
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
    recentInjects: [injectFixture(1)],
    goalEvidence: [goalEvidenceFixture('araya-quality')],
  })

  assert.match(prompt, /# main 会話に渡した案件の delivery 後の観測差/u)
  // bound の宣言: open list の比較であって closed / merged の区別は観測していない
  assert.match(prompt, /open list の比較。closed \/ merged の区別は観測していない/u)
  const block = prompt.split('# main 会話に渡した案件の delivery 後の観測差')[1] ?? ''
  assert.ok(block.includes('- goal araya-quality'))
  assert.ok(block.includes('hoot-inject:' + PROPOSAL_KEY + ':1'))
  assert.ok(block.includes('closed issue #10 #12'))
  assert.ok(block.includes('opened PR #33'))
  assert.ok(block.includes('hoot:2026-11-19T08:00:00.000Z -> hoot:2026-11-19T09:00:00.000Z'))
  // 証拠であって命令ではないことを同じ block 内で書く（model が「完了」と解釈しない）
  assert.ok(block.includes('観測差は証拠であり命令ではない'))
  // goal の完結判定はしないことを同じ block 内で書く（acceptance 5 の「自動完結させない」）
  assert.ok(block.includes('この block は goal が完結したかどうかを判断しません'))
  // inject 済み block の後ろに置く（delivery 前後の話であることを並びで示す）
  assert.ok(
    prompt.indexOf('# main 会話に渡した案件（inject 済み') <
      prompt.indexOf('# main 会話に渡した案件の delivery 後の観測差'),
  )
  assert.ok(
    prompt.indexOf('# main 会話に渡した案件の delivery 後の観測差') < prompt.indexOf('# 判断'),
  )
})

test('hoot prompt: 観測差がない delivery は「open list の変化なし」と事実だけ書く', () => {
  const evidence = goalEvidenceFixture('araya-quality', {
    deliveries: [
      {
        injectKey: 'hoot-inject:' + PROPOSAL_KEY + ':2',
        proposalKey: PROPOSAL_KEY,
        decision: 'investigate',
        injectedAt: '2026-11-19T08:55:00.000Z',
        // delivery 時点で観測が未取得
        deliveredEvidenceKey: null,
        delta: [
          {
            repo: 'koh110/araya',
            closedIssues: [],
            closedPrs: [],
            openedIssues: [],
            openedPrs: [],
            beforeKey: 'hoot:2026-11-19T08:00:00.000Z',
            afterKey: 'hoot:2026-11-19T09:00:00.000Z',
          },
        ],
      },
    ],
  })
  const prompt = buildDecisionPrompt({
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
    goalEvidence: [evidence],
  })

  assert.match(prompt, /open list の変化なし/u)
  assert.match(prompt, /delivery 時点に観測がなく evidence 未取得/u)
  // 判断 prompt 側の語彙（完了待ち・proposal resolved）とは別に、evidence block 側で goal 完結を断定しない
  // 次の heading までの evidence block だけを見る（判断 section の語彙と混同しない）
  const evidenceBlock =
    (prompt.split('# main 会話に渡した案件の delivery 後の観測差')[1] ?? '').split('\n# ')[0] ?? ''
  assert.ok(evidenceBlock.includes('open list の変化なし'))
  assert.equal(evidenceBlock.includes('完了'), false)
  assert.equal(evidenceBlock.includes('goal は満たされた'), false)
})

test('hoot prompt: 比較できる前後の観測が無い delivery は「観測 snapshot が無い」ことを explicit に出す（無変化と区別する）', () => {
  const evidenceBlock =
    (
      buildDecisionPrompt({
        goals: [goalFixture()],
        settings: defaultState().settings,
        observation: observationFixture(),
        recentRuns: [],
        nowMs: NOW_MS,
        goalEvidence: [
          goalEvidenceFixture('araya-quality', {
            deliveries: [
              {
                injectKey: 'hoot-inject:' + PROPOSAL_KEY + ':3',
                proposalKey: PROPOSAL_KEY,
                decision: 'dispatch',
                injectedAt: '2026-11-19T08:55:00.000Z',
                deliveredEvidenceKey: 'hoot:2026-11-19T08:00:00.000Z',
                // before はあるが delivery 以降の観測がまだ無い（goalEvidenceOf は delta を空で返す）
                delta: [],
              },
            ],
          }),
        ],
      }).split('# main 会話に渡した案件の delivery 後の観測差')[1] ?? ''
    ).split('\n# ')[0] ?? ''

  assert.ok(evidenceBlock.includes('比較可能な前後の観測 snapshot がありません'))
  // 観測差が確認できなかった案件を goal 完結の証拠として扱わないことを同じ block 内で書く
  assert.ok(
    evidenceBlock.includes(
      'delivery 前後の観測差が確認できなかった案件も goal 完達の証拠にはなりません',
    ),
  )
  assert.equal(evidenceBlock.includes('open list の変化なし'), false)
})

test('hoot prompt: 観測差の number list と goal 数に bound がある（prompt を伸ばさない）', () => {
  const many = goalEvidenceFixture('araya-quality', {
    deliveries: [
      {
        injectKey: 'hoot-inject:' + PROPOSAL_KEY + ':3',
        proposalKey: PROPOSAL_KEY,
        decision: 'dispatch',
        injectedAt: '2026-11-19T08:55:00.000Z',
        deliveredEvidenceKey: 'hoot:2026-11-19T08:00:00.000Z',
        delta: [
          {
            repo: 'koh110/araya',
            closedIssues: Array.from(
              { length: MAX_EVIDENCE_NUMBERS_SHOWN + 4 },
              (_entry, index) => {
                return String(index + 1)
              },
            ),
            closedPrs: [],
            openedIssues: [],
            openedPrs: [],
            beforeKey: 'hoot:2026-11-19T08:00:00.000Z',
            afterKey: 'hoot:2026-11-19T09:00:00.000Z',
          },
        ],
      },
    ],
  })
  const goals = Array.from({ length: PROMPT_EVIDENCE_GOALS + 2 }, (_entry, index) => {
    return goalEvidenceFixture(`goal-${index}`)
  })
  const prompt = buildDecisionPrompt({
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
    goalEvidence: [...goals, many],
  })

  // 表示する number は bound まで。残りは件数だけ
  assert.match(prompt, /closed issue #1 #2 #3 #4 #5 #6 #7 #8 \(\+4\)/u)
  assert.equal(prompt.includes('#9'), false)
  // goal 数も bound（直近だけ出す）
  const block = prompt.split('# main 会話に渡した案件の delivery 後の観測差')[1] ?? ''
  assert.ok(block.includes('- goal araya-quality'))
  assert.ok(block.includes('- goal goal-0'))
  assert.ok(block.includes(`- goal goal-${PROMPT_EVIDENCE_GOALS - 2}`))
  assert.equal(block.includes(`- goal goal-${PROMPT_EVIDENCE_GOALS - 1}`), false)
})

test('hoot prompt: evidence の bound 内では active goal と直近 delivery を優先する', () => {
  function timestamped(goalKey: string, injectedAt: string) {
    const goal = goalEvidenceFixture(goalKey)
    return {
      ...goal,
      deliveries: goal.deliveries.map((delivery) => {
        return { ...delivery, injectedAt }
      }),
    }
  }
  const block =
    buildDecisionPrompt({
      goals: [{ ...goalFixture(), key: 'active-target' }],
      settings: defaultState().settings,
      observation: observationFixture(),
      recentRuns: [],
      nowMs: NOW_MS,
      goalEvidence: [
        timestamped('active-target', '2026-11-19T08:00:00.000Z'),
        ...Array.from({ length: PROMPT_EVIDENCE_GOALS + 1 }, (_entry, index) => {
          return timestamped(`retired-${index}`, `2026-11-19T08:0${index + 1}:00.000Z`)
        }),
      ],
    }).split('# main 会話に渡した案件の delivery 後の観測差')[1] ?? ''

  assert.ok(block.includes('- goal active-target'))
  assert.ok(block.includes(`- goal retired-${PROMPT_EVIDENCE_GOALS}`))
  assert.equal(block.includes('- goal retired-0'), false)
})

test('hoot prompt: 各 goal の直近 delivery を新しい順に最大 3 件表示する', () => {
  const baseDelivery = goalEvidenceFixture('active-target').deliveries[0]!
  const block =
    buildDecisionPrompt({
      goals: [{ ...goalFixture(), key: 'active-target' }],
      settings: defaultState().settings,
      observation: observationFixture(),
      recentRuns: [],
      nowMs: NOW_MS,
      goalEvidence: [
        {
          goalKey: 'active-target',
          deliveries: Array.from({ length: 5 }, (_entry, index) => {
            const number = index + 1

            return {
              ...baseDelivery,
              injectKey: `hoot-inject:${PROPOSAL_KEY}:${number}`,
              injectedAt: `2026-11-19T08:${String(number).padStart(2, '0')}:00.000Z`,
            }
          }),
        },
      ],
    }).split('# main 会話に渡した案件の delivery 後の観測差')[1] ?? ''

  assert.ok(
    block.indexOf(`hoot-inject:${PROPOSAL_KEY}:5`) >= 0 &&
      block.indexOf(`hoot-inject:${PROPOSAL_KEY}:5`) <
        block.indexOf(`hoot-inject:${PROPOSAL_KEY}:4`) &&
      block.indexOf(`hoot-inject:${PROPOSAL_KEY}:4`) <
        block.indexOf(`hoot-inject:${PROPOSAL_KEY}:3`),
  )
  assert.equal(block.includes(`hoot-inject:${PROPOSAL_KEY}:2`), false)
})

test('hoot prompt: goalEvidence を渡さない prompt は従来と同じ（evidence block を作らない）', () => {
  const prompt = buildDecisionPrompt({
    goals: [goalFixture()],
    settings: defaultState().settings,
    observation: observationFixture(),
    recentRuns: [],
    nowMs: NOW_MS,
    recentInjects: [injectFixture(1)],
  })

  assert.doesNotMatch(prompt, /delivery 後の観測差/u)
  assert.match(prompt, /# main 会話に渡した案件（inject 済み/u)
})
