import { DatabaseSync } from 'node:sqlite'

export type Risk = 'read-only' | 'workspace' | 'external'

export type OpportunityStatus =
  | 'discovered'
  | 'scouting'
  | 'approval_requested'
  | 'approved'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'rejected'

export type Goal = {
  id: string
  title: string
  intervalMs: number
  nextDueAt: number
  lastWakeAt?: number
}

export type Opportunity = {
  id: string
  observationId: string
  goalId?: string
  title: string
  kind: string
  risk: Risk
  status: OpportunityStatus
  payload: Record<string, unknown>
  attemptCount: number
  discoveredAt: number
  updatedAt: number
  evidence?: Record<string, unknown>
}

export type Decision = {
  id: string
  opportunityId: string
  decision: 'approved' | 'rejected'
  actor: string
  note: string
  createdAt: number
}

export type OutboxMessage = {
  id: string
  topic: string
  message: string
  status: 'pending' | 'sent' | 'failed'
  createdAt: number
  updatedAt: number
}

export type ControlPlaneEvent = {
  id: number
  occurredAt: number
  type: string
  entityType: string
  entityId: string
  data: Record<string, unknown>
}

export type OpportunitySummary = {
  goals: Goal[]
  dueGoalIds: string[]
  opportunityCounts: Record<string, number>
  actionable: Opportunity[]
  pendingApprovals: Opportunity[]
  blocked: Opportunity[]
  decisions: Decision[]
  pendingOutbox: OutboxMessage[]
  events: ControlPlaneEvent[]
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('string expected')
  }

  return value
}

function asNullableText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  return asText(value)
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value === 'bigint') {
    return Number(value)
  }

  throw new Error('number expected')
}

function asNullableNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  return asNumber(value)
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(asText(value))

  if (!isJsonObject(parsed)) {
    throw new Error('JSON object expected')
  }

  return parsed
}

function asNullableJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  return parseJsonObject(value)
}

function asRisk(value: unknown): Risk {
  const text = asText(value)

  if (text === 'read-only' || text === 'workspace' || text === 'external') {
    return text
  }

  throw new Error(`invalid risk: ${text}`)
}

function asOpportunityStatus(value: unknown): OpportunityStatus {
  const text = asText(value)

  if (
    text === 'discovered' ||
    text === 'scouting' ||
    text === 'approval_requested' ||
    text === 'approved' ||
    text === 'completed' ||
    text === 'blocked' ||
    text === 'failed' ||
    text === 'rejected'
  ) {
    return text
  }

  throw new Error(`invalid opportunity status: ${text}`)
}

function asOutboxStatus(value: unknown): OutboxMessage['status'] {
  const text = asText(value)

  if (text === 'pending' || text === 'sent' || text === 'failed') {
    return text
  }

  throw new Error(`invalid outbox status: ${text}`)
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')

  try {
    const result = fn()
    db.exec('COMMIT')

    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateWorkspaceRiskSchema(db: DatabaseSync) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observations'").get()
  const schemaSql = row?.sql

  if (typeof schemaSql !== 'string' || schemaSql.includes("'workspace'")) {
    return
  }

  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;')

  try {
    db.exec(`
      CREATE TABLE observations_araya_new (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('read-only', 'workspace', 'external')),
        payload_json TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
      INSERT INTO observations_araya_new SELECT id, source, kind, title, risk, payload_json, seen_at FROM observations;

      CREATE TABLE opportunities_araya_new (
        id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL,
        goal_id TEXT,
        title TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('read-only', 'workspace', 'external')),
        status TEXT NOT NULL CHECK (
          status IN ('discovered', 'scouting', 'approval_requested', 'approved', 'completed', 'blocked', 'failed', 'rejected')
        ),
        payload_json TEXT NOT NULL,
        evidence_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        discovered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (observation_id) REFERENCES observations_araya_new(id),
        FOREIGN KEY (goal_id) REFERENCES goals(id)
      );
      INSERT INTO opportunities_araya_new
        SELECT id, observation_id, goal_id, title, risk, status, payload_json, evidence_json,
               attempt_count, discovered_at, updated_at
        FROM opportunities;

      CREATE TABLE decisions_araya_new (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
        actor TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (opportunity_id) REFERENCES opportunities_araya_new(id)
      );
      INSERT INTO decisions_araya_new SELECT id, opportunity_id, decision, actor, note, created_at FROM decisions;

      DROP TABLE decisions;
      DROP TABLE opportunities;
      DROP TABLE observations;
      ALTER TABLE observations_araya_new RENAME TO observations;
      ALTER TABLE opportunities_araya_new RENAME TO opportunities;
      ALTER TABLE decisions_araya_new RENAME TO decisions;
    `)

    const violations = db.prepare('PRAGMA foreign_key_check').all()

    if (violations.length > 0) {
      throw new Error(`workspace-risk migration found ${violations.length} foreign-key violation(s)`)
    }

    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      next_due_at INTEGER NOT NULL,
      last_wake_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('read-only', 'workspace', 'external')),
      payload_json TEXT NOT NULL,
      seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      goal_id TEXT,
      title TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('read-only', 'workspace', 'external')),
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

    CREATE INDEX IF NOT EXISTS idx_opportunities_status_discovered
      ON opportunities (status, discovered_at);

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      actor TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_recent
      ON events (occurred_at DESC);

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      evidence_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    );
  `)
}

function mapGoal(row: Record<string, unknown>): Goal {
  return {
    id: asText(row.id),
    title: asText(row.title),
    intervalMs: asNumber(row.interval_ms),
    nextDueAt: asNumber(row.next_due_at),
    lastWakeAt: asNullableNumber(row.last_wake_at)
  }
}

function mapOpportunity(row: Record<string, unknown>): Opportunity {
  return {
    id: asText(row.id),
    observationId: asText(row.observation_id),
    goalId: asNullableText(row.goal_id),
    title: asText(row.title),
    kind: asText(row.kind),
    risk: asRisk(row.risk),
    status: asOpportunityStatus(row.status),
    payload: parseJsonObject(row.payload_json),
    attemptCount: asNumber(row.attempt_count),
    discoveredAt: asNumber(row.discovered_at),
    updatedAt: asNumber(row.updated_at),
    evidence: asNullableJsonObject(row.evidence_json)
  }
}

function mapDecision(row: Record<string, unknown>): Decision {
  const decision = asText(row.decision)

  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error(`invalid decision: ${decision}`)
  }

  return {
    id: asText(row.id),
    opportunityId: asText(row.opportunity_id),
    decision,
    actor: asText(row.actor),
    note: asText(row.note),
    createdAt: asNumber(row.created_at)
  }
}

function mapOutbox(row: Record<string, unknown>): OutboxMessage {
  return {
    id: asText(row.id),
    topic: asText(row.topic),
    message: asText(row.message),
    status: asOutboxStatus(row.status),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at)
  }
}

function mapEvent(row: Record<string, unknown>): ControlPlaneEvent {
  return {
    id: asNumber(row.id),
    occurredAt: asNumber(row.occurred_at),
    type: asText(row.type),
    entityType: asText(row.entity_type),
    entityId: asText(row.entity_id),
    data: parseJsonObject(row.data_json)
  }
}

export function openControlPlane(sqlitePath: string) {
  const db = new DatabaseSync(sqlitePath)
  migrateWorkspaceRiskSchema(db)
  ensureSchema(db)
  db.exec('PRAGMA user_version = 1;')

  function appendEvent(
    type: string,
    entityType: string,
    entityId: string,
    data: Record<string, unknown>,
    occurredAt: number
  ) {
    db.prepare(`
      INSERT INTO events (occurred_at, type, entity_type, entity_id, data_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(occurredAt, type, entityType, entityId, JSON.stringify(data))
  }

  function insertOutbox(id: string, topic: string, message: string, createdAt: number) {
    db.prepare(`
      INSERT INTO outbox (id, topic, message, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        message = excluded.message,
        status = 'pending',
        updated_at = excluded.updated_at
    `).run(id, topic, message, createdAt, createdAt)

    appendEvent('outbox.created', 'outbox', id, { topic, message }, createdAt)
  }

  function enqueueOutbox(id: string, topic: string, message: string, createdAt: number) {
    transaction(db, () => insertOutbox(id, topic, message, createdAt))
  }

  function ensureGoal(goalId: string, title: string, intervalMs: number, now: number) {
    transaction(db, () => {
      db.prepare(`
        INSERT INTO goals (id, title, interval_ms, next_due_at, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          title = excluded.title,
          interval_ms = excluded.interval_ms,
          updated_at = excluded.updated_at
      `).run(goalId, title, intervalMs, now, now)
    })
  }

  function listGoals(): Goal[] {
    const rows = db.prepare('SELECT * FROM goals ORDER BY next_due_at ASC').all()

    return rows.map(mapGoal)
  }

  function dueGoalIds(now: number): string[] {
    const rows = db.prepare('SELECT id FROM goals WHERE next_due_at <= ? ORDER BY next_due_at ASC').all(now)

    return rows.map((row) => asText(row.id))
  }

  function markGoalWake(goalId: string, now: number, nextDueAt: number) {
    const result = db.prepare(`
      UPDATE goals
      SET last_wake_at = ?, next_due_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, nextDueAt, now, goalId)

    if (result.changes === 0) {
      throw new Error(`goal not found: ${goalId}`)
    }
  }

  function recordObservationBatch(
    observations: readonly {
      observationId: string
      kind: string
      title: string
      risk: Risk
      payload: Record<string, unknown>
    }[],
    goalId: string,
    seenAt: number
  ) {
    return transaction(db, () => {
      const insertedIds: string[] = []

      for (const observation of observations) {
        db.prepare(`
          INSERT INTO observations (id, source, kind, title, risk, payload_json, seen_at)
          VALUES (?, 'inbox', ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `).run(
          observation.observationId,
          observation.kind,
          observation.title,
          observation.risk,
          JSON.stringify(observation.payload),
          seenAt
        )

        const result = db.prepare(`
          INSERT INTO opportunities (
            id, observation_id, goal_id, title, risk, status, payload_json,
            attempt_count, discovered_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'discovered', ?, 0, ?, ?)
          ON CONFLICT (id) DO NOTHING
        `).run(
          observation.observationId,
          observation.observationId,
          goalId,
          observation.title,
          observation.risk,
          JSON.stringify(observation.payload),
          seenAt,
          seenAt
        )

        if (result.changes !== 0) {
          insertedIds.push(observation.observationId)
          appendEvent(
            'opportunity.discovered',
            'opportunity',
            observation.observationId,
            { title: observation.title, risk: observation.risk },
            seenAt
          )
        }
      }

      return insertedIds
    })
  }

  function listOpportunitiesByStatus(statuses: readonly OpportunityStatus[], limit: number): Opportunity[] {
    const placeholders = statuses.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT opportunities.*, observations.kind AS kind
      FROM opportunities
      JOIN observations ON observations.id = opportunities.observation_id
      WHERE opportunities.status IN (${placeholders})
      ORDER BY opportunities.discovered_at ASC
      LIMIT ?
    `).all(...statuses, limit)

    return rows.map(mapOpportunity)
  }

  function getOpportunity(opportunityId: string): Opportunity | undefined {
    const row = db.prepare(`
      SELECT opportunities.*, observations.kind AS kind
      FROM opportunities
      JOIN observations ON observations.id = opportunities.observation_id
      WHERE opportunities.id = ?
    `).get(opportunityId)

    return row === undefined ? undefined : mapOpportunity(row)
  }

  function startOpportunities(opportunityIds: readonly string[], now: number) {
    transaction(db, () => {
      for (const opportunityId of opportunityIds) {
        const result = db.prepare(`
          UPDATE opportunities
          SET status = 'scouting', attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ?
        `).run(now, opportunityId)

        if (result.changes === 0) {
          throw new Error(`opportunity not found: ${opportunityId}`)
        }

        appendEvent('opportunity.scouting', 'opportunity', opportunityId, {}, now)
      }
    })
  }

  function writeOpportunityStatus(
    opportunityId: string,
    status: OpportunityStatus,
    evidence: Record<string, unknown>,
    now: number
  ) {
    const result = db.prepare(`
      UPDATE opportunities
      SET status = ?, evidence_json = ?, updated_at = ?
      WHERE id = ?
    `).run(status, JSON.stringify(evidence), now, opportunityId)

    if (result.changes === 0) {
      throw new Error(`opportunity not found: ${opportunityId}`)
    }

    appendEvent('opportunity.status', 'opportunity', opportunityId, { status, evidence }, now)
  }

  function setOpportunityStatus(
    opportunityId: string,
    status: OpportunityStatus,
    evidence: Record<string, unknown>,
    now: number
  ) {
    transaction(db, () => writeOpportunityStatus(opportunityId, status, evidence, now))
  }

  function requestApproval(opportunityId: string, message: string, now: number) {
    transaction(db, () => {
      const opportunity = getOpportunity(opportunityId)

      if (opportunity === undefined) {
        throw new Error(`opportunity not found: ${opportunityId}`)
      }

      if (opportunity.risk !== 'external') {
        throw new Error(`approval requires an external opportunity: ${opportunityId}`)
      }

      if (opportunity.status !== 'scouting') {
        throw new Error(`opportunity cannot request approval from status: ${opportunity.status}`)
      }

      writeOpportunityStatus(
        opportunityId,
        'approval_requested',
        { type: 'approval_gate', opportunityId, message },
        now
      )
      insertOutbox(`approval-request:${opportunityId}`, 'discord.approval', message, now)
    })
  }

  function recordDecision(
    opportunityId: string,
    decision: 'approved' | 'rejected',
    actor: string,
    note: string,
    now: number
  ): Decision {
    return transaction(db, () => {
      const opportunity = getOpportunity(opportunityId)

      if (opportunity === undefined) {
        throw new Error(`opportunity not found: ${opportunityId}`)
      }

      if (opportunity.status !== 'discovered' && opportunity.status !== 'approval_requested') {
        throw new Error(`opportunity cannot be decided from status: ${opportunity.status}`)
      }

      const id = `decision:${opportunityId}:${now}`

      db.prepare(`
        INSERT INTO decisions (id, opportunity_id, decision, actor, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, opportunityId, decision, actor, note, now)

      const nextStatus: OpportunityStatus = decision === 'approved' ? 'approved' : 'rejected'

      db.prepare(`
        UPDATE opportunities
        SET status = ?, evidence_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextStatus,
        JSON.stringify({ type: 'human_decision', decision, actor, note }),
        now,
        opportunityId
      )

      appendEvent(
        'decision.created',
        'opportunity',
        opportunityId,
        { decision, actor, note },
        now
      )

      return {
        id,
        opportunityId,
        decision,
        actor,
        note,
        createdAt: now
      }
    })
  }

  function listDecisions(limit: number): Decision[] {
    const rows = db.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(limit)

    return rows.map(mapDecision)
  }

  function listPendingOutbox(limit: number): OutboxMessage[] {
    const rows = db.prepare(`
      SELECT *
      FROM outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit)

    return rows.map(mapOutbox)
  }


  function countOpportunities(): Record<string, number> {
    const rows = db.prepare('SELECT status, COUNT(*) AS count FROM opportunities GROUP BY status').all()
    const counts: Record<string, number> = {}

    for (const row of rows) {
      counts[asText(row.status)] = asNumber(row.count)
    }

    return counts
  }

  function summarize(limit: number): OpportunitySummary {
    return {
      goals: listGoals(),
      dueGoalIds: dueGoalIds(Date.now()),
      opportunityCounts: countOpportunities(),
      actionable: listOpportunitiesByStatus(['discovered', 'scouting', 'approved'], limit),
      pendingApprovals: listOpportunitiesByStatus(['approval_requested'], limit),
      blocked: listOpportunitiesByStatus(['blocked'], limit),
      decisions: listDecisions(limit),
      pendingOutbox: listPendingOutbox(limit),
      events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit).map(mapEvent)
    }
  }

  return {
    db,
    appendEvent,
    close: () => db.close(),
    countOpportunities,
    dueGoalIds,
    enqueueOutbox,
    ensureGoal,
    getOpportunity,
    listDecisions,
    listGoals,
    listOpportunitiesByStatus,
    listPendingOutbox,
    markGoalWake,
    recordDecision,
    recordObservationBatch,
    requestApproval,
    setOpportunityStatus,
    startOpportunities,
    summarize
  }
}

export type ControlPlane = ReturnType<typeof openControlPlane>
