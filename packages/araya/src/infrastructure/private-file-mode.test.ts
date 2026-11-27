import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'

import {
  ensurePrivateLogFile,
  PRIVATE_LOG_DIRECTORY_MODE,
  PRIVATE_LOG_FILE_MODE,
} from './private-file-mode.ts'

// umask を触ると他の test に漏れるので、process.umask は使わない。umask に依存したくなる case（新規 file・
// 新規 directory）は helper が最後に chmod した値であることを、umask が何であっても同じになる 0600 / 0700 の
// exact assert で固定する。umask が絞って出来た緩い mode は、既存 file / 既存 directory を緩い値から渡す
// case（0664・0755）で再現する
async function makeRoot(name: string) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `araya-private-file-mode-${name}-`)))
}

test('private log file: 無い file は 0600、無い親 directory は 0700 で作る（空にはしない）', async () => {
  const root = await makeRoot('create')
  const logFile = path.join(root, 'logs', 'discord.log')

  try {
    await fs.chmod(root, 0o755)
    assert.deepEqual(await ensurePrivateLogFile(logFile), { ok: true, filePath: logFile })
    assert.equal((await fs.stat(logFile)).mode & 0o777, PRIVATE_LOG_FILE_MODE)
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600)
    assert.equal((await fs.readFile(logFile, 'utf8')), '')
    assert.equal((await fs.stat(path.dirname(logFile))).mode & 0o777, PRIVATE_LOG_DIRECTORY_MODE)
    assert.equal((await fs.stat(path.dirname(logFile))).mode & 0o777, 0o700)
    // 親の上位（tmp dir）は変更しない。整えるのは file の immediate parent だけ
    assert.equal((await fs.stat(root)).mode & 0o777, 0o755)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('private log file: 0664 の既存 file を 0600 に整え、本文はそのまま残す', async () => {
  const root = await makeRoot('loose-file')
  const logsDir = path.join(root, 'logs')
  const logFile = path.join(logsDir, 'discord-launcher.log')

  try {
    // systemd の StandardError=append: が作った状態（実測 0664）を再現する
    await fs.mkdir(logsDir, { mode: 0o700 })
    await fs.writeFile(logFile, 'previous launcher trace\n', 'utf8')
    await fs.chmod(logFile, 0o664)
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o664)

    assert.deepEqual(await ensurePrivateLogFile(logFile), { ok: true, filePath: logFile })
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600)
    assert.equal(await fs.readFile(logFile, 'utf8'), 'previous launcher trace\n')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('private log file: 0755 の既存 directory を 0700 に整える（file の mode と本文は変えない）', async () => {
  const root = await makeRoot('loose-dir')
  const logsDir = path.join(root, 'logs')
  const logFile = path.join(logsDir, 'discord.log')

  try {
    await fs.mkdir(logsDir, { mode: 0o755 })
    await fs.writeFile(logFile, '{"type":"discord_started"}\n', { mode: 0o600 })
    assert.equal((await fs.stat(logsDir)).mode & 0o777, 0o755)

    assert.deepEqual(await ensurePrivateLogFile(logFile), { ok: true, filePath: logFile })
    assert.equal((await fs.stat(logsDir)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600)
    assert.equal(await fs.readFile(logFile, 'utf8'), '{"type":"discord_started"}\n')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('private log file: 0600 と 0700 なら変更しない（2 度呼んでも本文も mode もそのまま）', async () => {
  const root = await makeRoot('idempotent')
  const logsDir = path.join(root, 'logs')
  const logFile = path.join(logsDir, 'discord.log')

  try {
    assert.deepEqual(await ensurePrivateLogFile(logFile), { ok: true, filePath: logFile })
    await fs.appendFile(logFile, '{"type":"discord_ready"}\n', 'utf8')
    const before = await fs.stat(logFile)

    assert.deepEqual(await ensurePrivateLogFile(logFile), { ok: true, filePath: logFile })
    const after = await fs.stat(logFile)

    assert.equal(after.mode & 0o777, 0o600)
    assert.equal(after.ino, before.ino)
    assert.equal(await fs.readFile(logFile, 'utf8'), '{"type":"discord_ready"}\n')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('private log file: logs が regular file なら throw せず ok:false（呼び出し側は処理を続けられる）', async () => {
  const root = await makeRoot('logs-is-file')
  const logsDir = path.join(root, 'logs')
  const logFile = path.join(logsDir, 'discord.log')

  try {
    await fs.writeFile(logsDir, 'not a directory', 'utf8')

    const outcome = await ensurePrivateLogFile(logFile)

    assert.equal(outcome.ok, false)
    if (outcome.ok) {
      throw new Error('ok:false のはず')
    }

    assert.equal(outcome.filePath, logsDir)
    assert.ok(outcome.message.includes('logs directory を 0700 にできない'), outcome.message)
    assert.equal(await fs.readFile(logsDir, 'utf8'), 'not a directory')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('private log file: 指定 path が directory なら ok:false（directory を 0600 にしない）', async () => {
  const root = await makeRoot('target-is-dir')
  const logsDir = path.join(root, 'logs')
  const logFile = path.join(logsDir, 'discord.log')

  try {
    await fs.mkdir(logFile, { recursive: true, mode: 0o700 })

    const outcome = await ensurePrivateLogFile(logFile)

    assert.equal(outcome.ok, false)
    if (outcome.ok) {
      throw new Error('ok:false のはず')
    }

    assert.equal(outcome.filePath, logFile)
    assert.ok(outcome.message.includes('regular file ではありません'), outcome.message)
    // directory の mode はこの helper の約束（file 0600）で潰さない
    assert.equal((await fs.stat(logFile)).mode & 0o777, 0o700)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
