import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  currentDiscordLockOwner,
  discordLockOwnerPath,
  discordLockOwnerStatus,
  discordLockPath,
  reclaimDeadDiscordProcessLock,
  writeDiscordLockOwner,
} from '../src/discord/process-lock.ts'

// Linux の pid_max より大きいので process.kill(pid, 0) は ESRCH（= 実在しない）になる
const DEAD_PID = 2_147_483_647
const MIN_LOCK_AGE_MS = 5_000

async function createDataDir(prefix: string): Promise<string> {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

async function createLockDir(dataDir: string, mtimeMs: number): Promise<string> {
  const lockPath = discordLockPath(dataDir)
  await fs.mkdir(lockPath)
  const when = new Date(mtimeMs)
  await fs.utimes(lockPath, when, when)

  return lockPath
}

test('process lock: 取得中の holder は alive で、lock はそのまま残る', async () => {
  const dataDir = await createDataDir('araya-process-lock-alive-')

  try {
    const owner = currentDiscordLockOwner()
    assert.equal(owner.pid, process.pid)
    assert.equal(discordLockOwnerStatus(owner), 'alive')

    await writeDiscordLockOwner(dataDir, owner)
    const ownerStat = await fs.stat(discordLockOwnerPath(dataDir))
    assert.equal(ownerStat.mode & 0o777, 0o600)

    const lockPath = await createLockDir(dataDir, Date.now() - 20_000)
    const reclaim = await reclaimDeadDiscordProcessLock(dataDir, {
      nowMs: (): number => Date.now(),
      minLockAgeMs: MIN_LOCK_AGE_MS,
    })

    assert.equal(reclaim.reason, 'owner_alive')
    assert.equal(reclaim.reclaimed, false)
    assert.equal(reclaim.ownerPid, process.pid)
    // 生存 holder の lock を奪わない
    await fs.access(lockPath)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('process lock: 死んだ holder の残留は stale（30 s）を待たずに回収する', async () => {
  const dataDir = await createDataDir('araya-process-lock-dead-')

  try {
    const lockPath = await createLockDir(dataDir, Date.now() - 20_000)
    await writeDiscordLockOwner(dataDir, {
      pid: DEAD_PID,
      starttime: null,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      hostname: 'synthetic',
    })

    const reclaim = await reclaimDeadDiscordProcessLock(dataDir, {
      nowMs: (): number => Date.now(),
      minLockAgeMs: MIN_LOCK_AGE_MS,
    })

    assert.equal(reclaim.reclaimed, true)
    assert.equal(reclaim.reason, 'reclaimed')
    assert.equal(reclaim.ownerStatus, 'dead')
    assert.ok(reclaim.lockAgeMs >= 19_000)
    await assert.rejects(fs.access(lockPath), { code: 'ENOENT' })
    // 回収側が owner record も片付ける（次の起動が古い owner を誤読しない）
    await assert.rejects(fs.access(discordLockOwnerPath(dataDir)), { code: 'ENOENT' })
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('process lock: mtime が新しい（refresh 中）なら holder が死んでいても回収を保留する', async () => {
  const dataDir = await createDataDir('araya-process-lock-fresh-')

  try {
    const lockPath = await createLockDir(dataDir, Date.now())
    await writeDiscordLockOwner(dataDir, {
      pid: DEAD_PID,
      starttime: null,
      startedAt: new Date().toISOString(),
      hostname: 'synthetic',
    })

    const reclaim = await reclaimDeadDiscordProcessLock(dataDir, {
      nowMs: (): number => Date.now(),
      minLockAgeMs: MIN_LOCK_AGE_MS,
    })

    assert.equal(reclaim.reason, 'lock_fresh')
    assert.equal(reclaim.reclaimed, false)
    assert.equal(reclaim.ownerStatus, 'dead')
    await fs.access(lockPath)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('process lock: 同じ PID でも starttime が違えば PID 再利用として扱う', () => {
  const status = discordLockOwnerStatus({
    pid: process.pid,
    starttime: 'not-the-real-starttime',
    startedAt: new Date().toISOString(),
    hostname: 'synthetic',
  })

  assert.equal(status, 'pid_reused')
})

test('process lock: owner record が無い残留（古い build）は stale 判定に任せる', async () => {
  const dataDir = await createDataDir('araya-process-lock-no-owner-')

  try {
    const lockPath = await createLockDir(dataDir, Date.now() - 20_000)
    const reclaim = await reclaimDeadDiscordProcessLock(dataDir, {
      nowMs: (): number => Date.now(),
      minLockAgeMs: MIN_LOCK_AGE_MS,
    })

    assert.equal(reclaim.reason, 'no_owner_record')
    assert.equal(reclaim.reclaimed, false)
    assert.equal(reclaim.ownerPid, null)
    await fs.access(lockPath)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
