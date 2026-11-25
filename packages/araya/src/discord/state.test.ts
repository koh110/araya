import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'

import { messageIdAtAge } from '../../test/support/discord-snowflake.ts'

import {
  DISCORD_STATE_VERSION,
  DISCORD_STATE_VERSION_BEFORE_CURSOR,
  DISCORD_STATE_VERSION_BEFORE_UNFINISHED,
  canAdvanceCursorPast,
  discordStateFilePath,
  idsBehindCursor,
  isDiscordMessageIdNewer,
  newState,
  noteDiscordSeenMessageId,
  readDiscordBotState,
  writeDiscordBotState,
} from './state.ts'

async function withTemporaryDataDir<T>(run: (dataDir: string) => Promise<T>) {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-state-test-')),
  )

  try {
    return await run(dataDir)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

async function writeStateFile(dataDir: string, state: unknown) {
  const filePath = discordStateFilePath(dataDir)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

test('discord state: snowflake ids are ordered numerically and malformed ids are rejected', () => {
  const older = messageIdAtAge(9_000)
  const newer = messageIdAtAge(1_000)

  assert.equal(isDiscordMessageIdNewer(newer, older), true)
  assert.equal(isDiscordMessageIdNewer(older, newer), false)
  assert.equal(isDiscordMessageIdNewer('invalid', newer), false)
  assert.equal(isDiscordMessageIdNewer(newer, 'invalid'), true)
})

test('discord state: reading a v1 file adds a null cursor without rewriting the file', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    await writeStateFile(dataDir, {
      version: DISCORD_STATE_VERSION_BEFORE_CURSOR,
      unit: 'araya-discord-old',
      readyId: 'ready-old',
      lastReadyAt: '2026-11-22T00:00:00.000Z',
    })

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.version, DISCORD_STATE_VERSION)
    assert.equal(state.unit, 'araya-discord-old')
    assert.equal(state.lastSeenMessageId, null)
    assert.equal(
      JSON.parse(await fs.readFile(discordStateFilePath(dataDir), 'utf8')).version,
      DISCORD_STATE_VERSION_BEFORE_CURSOR,
    )
  })
})

test('discord state: writing a migrated v1 state persists the current version', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    await writeStateFile(dataDir, {
      version: DISCORD_STATE_VERSION_BEFORE_CURSOR,
      unit: 'araya-discord-old',
      lastReadyAt: '2026-11-22T00:00:00.000Z',
    })

    const state = readDiscordBotState(dataDir)
    assert.ok(state !== null)
    writeDiscordBotState(dataDir, state)

    assert.equal(
      JSON.parse(await fs.readFile(discordStateFilePath(dataDir), 'utf8')).version,
      DISCORD_STATE_VERSION,
    )
  })
})

test('discord state: a future state version is rejected', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    await writeStateFile(dataDir, {
      version: DISCORD_STATE_VERSION + 1,
      unit: null,
      lastReadyAt: null,
    })

    assert.throws(
      () => {
        return readDiscordBotState(dataDir)
      },
      { code: 'discord_state_invalid' },
    )
  })
})

test('discord state: an invalid cursor id is rejected', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    await writeStateFile(dataDir, {
      version: DISCORD_STATE_VERSION,
      unit: null,
      lastReadyAt: null,
      lastSeenMessageId: 'not-an-id',
    })

    assert.throws(
      () => {
        return readDiscordBotState(dataDir)
      },
      { code: 'discord_state_invalid' },
    )
  })
})

test('discord state: a v2 file (no unfinished ids) opens with empty id lists without rewriting the file', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    const cursor = messageIdAtAge(60_000)

    await writeStateFile(dataDir, {
      version: DISCORD_STATE_VERSION_BEFORE_UNFINISHED,
      unit: 'araya-discord-old',
      readyId: 'ready-old',
      lastReadyAt: '2026-11-24T00:00:00.000Z',
      lastSeenMessageId: cursor,
    })

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.version, DISCORD_STATE_VERSION)
    assert.equal(state.unit, 'araya-discord-old')
    assert.equal(state.lastSeenMessageId, cursor, 'cursor はそのまま引き継ぐ')
    assert.deepEqual(state.unfinishedMessageIds, [])
    assert.deepEqual(state.answeredMessageIds, [])
    assert.equal(
      JSON.parse(await fs.readFile(discordStateFilePath(dataDir), 'utf8')).version,
      DISCORD_STATE_VERSION_BEFORE_UNFINISHED,
      'read だけでは file を書き換えない',
    )
  })
})

test('discord state: unfinished / answered ids survive a write and read round trip', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    const cursor = messageIdAtAge(60_000)
    const unfinished = [messageIdAtAge(40_000), messageIdAtAge(20_000)]
    const answered = [messageIdAtAge(10_000)]

    writeDiscordBotState(dataDir, {
      ...newState(),
      unit: 'araya-discord-test',
      readyId: 'ready-1',
      lastReadyAt: '2026-11-24T00:00:00.000Z',
      lastSeenMessageId: cursor,
      unfinishedMessageIds: unfinished,
      answeredMessageIds: answered,
    })

    const state = readDiscordBotState(dataDir)

    assert.ok(state !== null)
    assert.equal(state.version, DISCORD_STATE_VERSION)
    assert.deepEqual(state.unfinishedMessageIds, unfinished)
    assert.deepEqual(state.answeredMessageIds, answered)

    // 書き直し（cursor を進める）しても集合は消えない
    writeDiscordBotState(dataDir, noteDiscordSeenMessageId(state, messageIdAtAge(5_000)))
    const reread = readDiscordBotState(dataDir)

    assert.ok(reread !== null)
    assert.deepEqual(reread.unfinishedMessageIds, unfinished)
    assert.deepEqual(reread.answeredMessageIds, answered)
  })
})

test('discord state: a malformed unfinished id list is rejected', async () => {
  await withTemporaryDataDir(async (dataDir) => {
    for (const unfinishedMessageIds of [['not-an-id'], 'not-a-list', { 0: messageIdAtAge(1_000) }]) {
      await writeStateFile(dataDir, {
        version: DISCORD_STATE_VERSION,
        unit: null,
        lastReadyAt: null,
        lastSeenMessageId: messageIdAtAge(60_000),
        unfinishedMessageIds,
      })

      assert.throws(
        () => {
          return readDiscordBotState(dataDir)
        },
        { code: 'discord_state_invalid' },
        `unfinishedMessageIds=${JSON.stringify(unfinishedMessageIds)}`,
      )
    }
  })
})

test('discord state: the cursor gate refuses to pass an older unfinished id', () => {
  const unfinishedOlder = messageIdAtAge(40_000)
  const unfinishedNewer = messageIdAtAge(1_000)
  const messageId = messageIdAtAge(20_000)

  // unfinished に自分より古い id が残っている間は進めない
  assert.equal(canAdvanceCursorPast([unfinishedOlder], messageId), false)
  assert.equal(canAdvanceCursorPast(new Set<string>([unfinishedNewer, unfinishedOlder]), messageId), false)
  // 自分より新しい unfinished だけなら進める。集合が空なら進める
  assert.equal(canAdvanceCursorPast([unfinishedNewer], messageId), true)
  assert.equal(canAdvanceCursorPast([], messageId), true)
  assert.equal(canAdvanceCursorPast(new Set<string>(), messageId), true)
})

test('discord state: idsBehindCursor drops the ids the cursor already passed and keeps newer unfinished', () => {
  const cursor = messageIdAtAge(30_000)
  const older = messageIdAtAge(60_000)
  const newer = messageIdAtAge(5_000)

  // cursor が既に越えた id は unfinished / answered 両方で prune 対象（state file が膨れないため）
  assert.deepEqual(idsBehindCursor([older], cursor), [older])
  assert.deepEqual(idsBehindCursor(new Set<string>([older, newer]), cursor), [older])
  // unfinished が cursor より新しい間は残す（まだ backfill の取り直し対象）
  assert.deepEqual(idsBehindCursor([newer], cursor), [])
  assert.deepEqual(idsBehindCursor(new Set<string>([newer]), cursor), [])
  // cursor が無い state では何も落とさない（取り直しの対象を消さない）
  assert.deepEqual(idsBehindCursor([older, newer], null), [])
})

test('discord state: the cursor only advances and updates do not mutate the previous state', () => {
  const initial = newState()
  const cursor = messageIdAtAge(30_000)
  const newer = messageIdAtAge(1_000)
  const first = noteDiscordSeenMessageId(initial, cursor)

  assert.equal(first.lastSeenMessageId, cursor)
  assert.equal(noteDiscordSeenMessageId(first, messageIdAtAge(40_000)), first)
  assert.equal(noteDiscordSeenMessageId(first, 'invalid'), first)
  assert.equal(noteDiscordSeenMessageId(first, ''), first)

  assert.equal(noteDiscordSeenMessageId(first, newer).lastSeenMessageId, newer)
  assert.equal(first.lastSeenMessageId, cursor)
  assert.equal(initial.lastSeenMessageId, null)
})
