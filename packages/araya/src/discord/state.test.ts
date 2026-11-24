import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { messageIdAtAge } from '../../test/support/discord-snowflake.ts'

import {
  DISCORD_STATE_VERSION,
  DISCORD_STATE_VERSION_BEFORE_CURSOR,
  discordStateFilePath,
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

    assert.throws(() => readDiscordBotState(dataDir), { code: 'discord_state_invalid' })
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

    assert.throws(() => readDiscordBotState(dataDir), { code: 'discord_state_invalid' })
  })
})

test('discord state: the cursor only advances and updates do not mutate the previous state', () => {
  const initial = newState()
  const older = messageIdAtAge(40_000)
  const cursor = messageIdAtAge(30_000)
  const newer = messageIdAtAge(1_000)
  const first = noteDiscordSeenMessageId(initial, cursor)

  assert.equal(first.lastSeenMessageId, cursor)
  assert.equal(noteDiscordSeenMessageId(first, older), first)
  assert.equal(noteDiscordSeenMessageId(first, 'invalid'), first)
  assert.equal(noteDiscordSeenMessageId(first, ''), first)

  const second = noteDiscordSeenMessageId(first, newer)

  assert.equal(second.lastSeenMessageId, newer)
  assert.equal(first.lastSeenMessageId, cursor)
  assert.equal(initial.lastSeenMessageId, null)
})
