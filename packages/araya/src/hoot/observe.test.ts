import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'

import {
  OBSERVATION_ITEM_LIMIT,
  OBSERVATION_REPOS_MAX,
  collectGitHubObservations,
  observationSnapshotOf,
} from './observe.ts'
import {
  OBSERVATION_SNAPSHOT_ITEMS_MAX,
  OBSERVATION_SNAPSHOT_REPOS_MAX,
  OBSERVATION_SNAPSHOTS_KEPT,
} from './model.ts'
import type { BoundedProcessResult } from '../infrastructure/process.ts'

function ghResult(payload: unknown): BoundedProcessResult {
  const stdout = JSON.stringify(payload)

  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true,
  }
}

function ghFailure(text: string): BoundedProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: '',
    stderr: text,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(text),
    terminationReason: undefined,
    terminationConfirmed: true,
  }
}

function issueNumbersPayload(count: number, start = 1) {
  return Array.from({ length: count }, (_entry, index) => {
    const number = start + index

    return {
      number,
      title: `title ${number}`,
      updatedAt: `2026-11-1${number % 9}T00:00:00Z`,
    }
  })
}

function prNumbersPayload(count: number, start = 1) {
  return Array.from({ length: count }, (_entry, index) => {
    const number = start + index

    return {
      number,
      title: `pr title ${number}`,
      isDraft: number % 2 === 0,
      updatedAt: `2026-11-1${number % 9}T00:00:00Z`,
    }
  })
}

function makeDeps(command: (args: readonly string[]) => BoundedProcessResult) {
  return {
    cwd: process.cwd(),
    env: {},
    nowMs: () => {
      return Date.parse('2026-11-19T09:00:00.000Z')
    },
    runCommand: async (_command: string, args: readonly string[]) => {
      return command(args)
    },
  }
}

test('hoot observe: open list の number list を保持し、snapshot には title など external text を入れない', async () => {
  const observation = await collectGitHubObservations(
    ['koh110/araya'],
    makeDeps((args) => {
      if (args.includes('issue')) {
        // 重複 number は 1 本に揃える（gh の echo・page 重複で evidence が膨らまない）
        return ghResult([
          { number: 10, title: 'HOOT discovery loop', updatedAt: '2026-11-18T00:00:00Z' },
          { number: 12, title: 'human token leak', updatedAt: '2026-11-17T00:00:00Z' },
          { number: 10, title: 'HOOT discovery loop', updatedAt: '2026-11-18T00:00:00Z' },
        ])
      }

      // draft PR も number だけで表す（#33(draft) のような形は snapshot にしない）
      return ghResult([
        { number: 33, title: 'draft evidence', isDraft: true, updatedAt: '2026-11-19T00:00:00Z' },
      ])
    })
  )
  const repo = observation.repos[0]
  assert.notEqual(repo, undefined)
  assert.deepEqual(repo?.issueNumbers, ['10', '12'])
  assert.deepEqual(repo?.prNumbers, ['33'])
  assert.equal(repo?.openIssues, 3)
  assert.equal(repo?.openPrs, 1)
  assert.equal(repo?.draftPrs, 1)
  assert.notEqual(repo?.fingerprint, null)

  const snapshot = observationSnapshotOf('hoot:2026-11-19T09:00:00.000Z', observation)
  assert.deepEqual(snapshot, {
    occurrenceKey: 'hoot:2026-11-19T09:00:00.000Z',
    observedAt: observation.collectedAt,
    repos: [
      {
        repo: 'koh110/araya',
        openIssues: 3,
        openPrs: 1,
        draftPrs: 1,
        issueNumbers: ['10', '12'],
        prNumbers: ['33'],
        // fingerprint は observe の値そのまま（snapshot のために fingerprint の意味を変えない）
        fingerprint: repo?.fingerprint ?? null,
      },
    ],
  })

  // title・gap text は snapshot に混ざらない（external text を durable な state に溜めない）
  const serialized = JSON.stringify(snapshot)
  assert.equal(serialized.includes('HOOT discovery loop'), false)
  assert.equal(serialized.includes('draft evidence'), false)
})

test('hoot observe: number list は bound で打ち切り、fingerprint は title 変化で動かない', async () => {
  assert.equal(OBSERVATION_SNAPSHOT_ITEMS_MAX, OBSERVATION_ITEM_LIMIT)
  assert.equal(OBSERVATION_SNAPSHOT_REPOS_MAX, OBSERVATION_REPOS_MAX)

  const withTitlesA = await collectGitHubObservations(
    ['koh110/araya'],
    makeDeps((args) => {
      return args.includes('issue')
        ? ghResult(issueNumbersPayload(OBSERVATION_ITEM_LIMIT + 10))
        : ghResult(prNumbersPayload(2))
    })
  )
  const withTitlesB = await collectGitHubObservations(
    ['koh110/araya'],
    makeDeps((args) => {
      if (args.includes('issue')) {
        return ghResult(
          issueNumbersPayload(OBSERVATION_ITEM_LIMIT + 10).map((entry, index) => {
            return { ...entry, title: `人間が書き直した title ${index}` }
          })
        )
      }

      return ghResult(prNumbersPayload(2))
    })
  )

  // list の保持は bound まで（gh が返す long list を state に溜めない）
  assert.equal(withTitlesA.repos[0]?.issueNumbers.length, OBSERVATION_SNAPSHOT_ITEMS_MAX)
  assert.equal(withTitlesA.repos[0]?.prNumbers.length, 2)
  // fingerprint は number 集合と件数だけ。title を直しただけで precheck が空振りしない
  assert.equal(withTitlesA.repos[0]?.fingerprint, withTitlesB.repos[0]?.fingerprint)
})

test('hoot observe: 観測に gap がある repo は number list が空で fingerprint null（snapshot でも比較できない）', async () => {
  const observation = await collectGitHubObservations(
    ['koh110/araya'],
    makeDeps((args) => {
      return args.includes('issue') ? ghFailure('gh: API rate limit exceeded') : ghResult(prNumbersPayload(1))
    })
  )
  const repo = observation.repos[0]
  assert.notEqual(repo, undefined)
  assert.equal(repo?.openIssues, null)
  assert.deepEqual(repo?.issueNumbers, [])
  assert.deepEqual(repo?.prNumbers, ['1'])
  assert.equal(repo?.fingerprint, null)
  assert.equal(repo?.gaps.length, 1)

  const snapshot = observationSnapshotOf('hoot:2026-11-19T09:00:00.000Z', observation)
  assert.equal(snapshot.repos[0]?.fingerprint, null)
  assert.deepEqual(snapshot.repos[0]?.issueNumbers, [])
  // gap text（外部由来の error text）は snapshot に入れない
  assert.equal(JSON.stringify(snapshot).includes('rate limit'), false)
})

test('hoot observe: snapshot の repo 数と保持 occurrence 数に bound がある', async () => {
  const repos = Array.from({ length: OBSERVATION_REPOS_MAX + 3 }, (_entry, index) => {
    return `koh110/repo-${index}`
  })
  const observation = await collectGitHubObservations(
    repos,
    makeDeps((args) => {
      return args.includes('issue') ? ghResult(issueNumbersPayload(1)) : ghResult(prNumbersPayload(1))
    })
  )

  assert.equal(observation.repos.length, OBSERVATION_REPOS_MAX)
  assert.equal(observationSnapshotOf('hoot:2026-11-19T09:00:00.000Z', observation).repos.length, OBSERVATION_SNAPSHOT_REPOS_MAX)
  // state に保持する snapshot の数も bound がある（evidence の比較材料は直近 occurrence だけ）
  assert.ok(OBSERVATION_SNAPSHOTS_KEPT >= 1)
})
