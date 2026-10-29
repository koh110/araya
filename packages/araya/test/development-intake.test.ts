import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { openControlPlane } from '../src/control-plane/store.ts'
import { readObservationSource } from '../src/control-plane/observations.ts'

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-intake-test-'))
}

function createLegacyControlPlane(sqlitePath: string) {
  const db = new DatabaseSync(sqlitePath)
  db.exec(`
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      next_due_at INTEGER NOT NULL,
      last_wake_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('read-only', 'external')),
      payload_json TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    );

    CREATE TABLE opportunities (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      goal_id TEXT,
      title TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('read-only', 'external')),
      status TEXT NOT NULL CHECK (
        status IN ('discovered', 'scouting', 'approval_requested', 'approved', 'completed', 'blocked', 'failed', 'rejected')
      ),
      payload_json TEXT NOT NULL,
      evidence_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      discovered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (observation_id) REFERENCES observations(id),
      FOREIGN KEY (goal_id) REFERENCES goals(id)
    );

    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
    );

    INSERT INTO observations VALUES ('legacy:task', 'inbox', 'investigate', 'legacy task', 'external', '{}', 100);
    INSERT INTO opportunities VALUES (
      'legacy:task', 'legacy:task', NULL, 'legacy task', 'external', 'approval_requested',
      '{"source":"old"}', '{"type":"approval_gate"}', 1, 100, 101
    );
    INSERT INTO decisions VALUES ('decision:legacy', 'legacy:task', 'approved', 'user', 'old decision', 102);
  `)
  db.close()
}

test('observations: task だけを持つ workspace development task を読み込む', async () => {
  const dir = await makeTempDir()
  const inboxDir = path.join(dir, 'inbox')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(inboxDir, 'development.jsonl'),
    `${JSON.stringify({
      id: 'development:add-test',
      kind: 'development',
      title: 'テストを追加する',
      risk: 'workspace',
      payload: {
        task: '入力を検証し、不正値のテストを追加する'
      }
    })}\n`,
    'utf8'
  )

  try {
    const result = await readObservationSource(inboxDir)

    assert.deepEqual(result.errors, [])
    assert.equal(result.observations.length, 1)
    assert.equal(result.observations[0]?.kind, 'development')
    assert.equal(result.observations[0]?.risk, 'workspace')
    assert.deepEqual(result.observations[0]?.payload, { task: '入力を検証し、不正値のテストを追加する' })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('observations: development の payload に task 以外の key があれば理由付きで拒否する', async () => {
  const dir = await makeTempDir()
  const inboxDir = path.join(dir, 'inbox')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(inboxDir, 'invalid.jsonl'),
    [
      JSON.stringify({ id: 'development:verify-command', kind: 'development', title: 'bad', risk: 'workspace', payload: { task: 'do work', verifyCommand: ['npm', 'test'] } }),
      JSON.stringify({ id: 'development:repository', kind: 'development', title: 'bad', risk: 'workspace', payload: { task: 'do work', repository: 'araya' } })
    ].join('\n'),
    'utf8'
  )

  try {
    const result = await readObservationSource(inboxDir)

    assert.deepEqual(result.observations, [])
    assert.equal(result.errors.length, 2)
    assert.match(result.errors[0] ?? '', /accepts only task; unsupported key\(s\): verifyCommand/u)
    assert.match(result.errors[0] ?? '', /agent registers verification commands per repository/u)
    assert.match(result.errors[1] ?? '', /unsupported key\(s\): repository/u)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('observations: development の task と risk の検証を維持する', async () => {
  const dir = await makeTempDir()
  const inboxDir = path.join(dir, 'inbox')
  await fs.mkdir(inboxDir, { recursive: true })
  await fs.writeFile(
    path.join(inboxDir, 'invalid.jsonl'),
    [
      JSON.stringify({ id: 'development:no-task', kind: 'development', title: 'bad', risk: 'workspace', payload: {} }),
      JSON.stringify({ id: 'development:blank-task', kind: 'development', title: 'bad', risk: 'workspace', payload: { task: '  ' } }),
      JSON.stringify({ id: 'development:long-task', kind: 'development', title: 'bad', risk: 'workspace', payload: { task: 'x'.repeat(20_001) } }),
      JSON.stringify({ id: 'development:nul-task', kind: 'development', title: 'bad', risk: 'workspace', payload: { task: 'a\0b' } }),
      JSON.stringify({ id: 'development:wrong-risk', kind: 'development', title: 'bad', risk: 'read-only', payload: { task: 'do work' } }),
      JSON.stringify({ id: 'investigate:wrong-risk', kind: 'investigate', title: 'bad', risk: 'workspace', payload: {} })
    ].join('\n'),
    'utf8'
  )

  try {
    const result = await readObservationSource(inboxDir)

    assert.deepEqual(result.observations, [])
    assert.equal(result.errors.length, 6)
    assert.match(result.errors[0] ?? '', /payload\.task is required/u)
    assert.match(result.errors[1] ?? '', /payload\.task is required/u)
    assert.match(result.errors[2] ?? '', /at most 20000 characters/u)
    assert.match(result.errors[3] ?? '', /no NUL byte/u)
    assert.match(result.errors[4] ?? '', /requires workspace risk/u)
    assert.match(result.errors[5] ?? '', /requires development kind/u)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('control plane: legacy行とdecisionを保持してworkspace riskを追加する', async () => {
  const dir = await makeTempDir()
  const sqlitePath = path.join(dir, 'araya.sqlite')
  createLegacyControlPlane(sqlitePath)

  try {
    const controlPlane = openControlPlane(sqlitePath)

    try {
      const legacy = controlPlane.getOpportunity('legacy:task')
      assert.equal(legacy?.risk, 'external')
      assert.deepEqual(legacy?.payload, { source: 'old' })
      assert.deepEqual(controlPlane.listDecisions(10).map(({ id, note }) => ({ id, note })), [
        { id: 'decision:legacy', note: 'old decision' }
      ])

      controlPlane.ensureGoal('goal:workspace', 'workspace task', 1000, 200)
      controlPlane.recordObservationBatch(
        [{
          observationId: 'development:new',
          kind: 'development',
          title: 'new task',
          risk: 'workspace',
          payload: { task: 'change source' }
        }],
        'goal:workspace',
        201
      )

      const created = controlPlane.getOpportunity('development:new')
      assert.equal(created?.kind, 'development')
      assert.equal(created?.risk, 'workspace')
      assert.equal(created?.status, 'discovered')
      assert.deepEqual(controlPlane.db.prepare('PRAGMA foreign_key_check').all(), [])
    } finally {
      controlPlane.close()
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
