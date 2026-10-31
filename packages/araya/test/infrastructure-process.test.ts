import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runBoundedCommand, runVerificationCommand } from '../src/infrastructure/process.ts'

async function makeTempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-infrastructure-process-test-')))
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

function hasCode(code: string) {
  return (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === code
  }
}

test('runBoundedCommand: strict は上限を超えた出力で process を止める', async () => {
  const startedAt = Date.now()
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"
  ], {
    timeoutMs: 10_000,
    stdout: { mode: 'strict', limitBytes: 100 }
  })

  assert.equal(result.terminationReason, 'output_overflow')
  assert.equal(result.terminationConfirmed, true)
  assert.equal(result.stdout, 'x'.repeat(100))
  assert.ok(Date.now() - startedAt < 5000)
})

test('runBoundedCommand: tail は止めずに末尾と総 byte 数を残し、不正な UTF-8 を置換する', async () => {
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    "process.stdout.write('a'.repeat(10000) + 'END'); process.stdout.write(Buffer.from([0xff])); process.stderr.write('err')"
  ], {
    timeoutMs: 10_000,
    stdout: { mode: 'tail', limitBytes: 8 },
    stderr: { mode: 'tail', limitBytes: 8 }
  })

  assert.equal(result.terminationReason, undefined)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutBytes, 10004)
  assert.equal(result.stdout, 'aaaaEND�')
  assert.equal(result.stderr, 'err')
  assert.equal(result.stderrBytes, 3)
})

test('runBoundedCommand: strict は不正な UTF-8 で止める', async () => {
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    'process.stderr.write(Buffer.from([0xff]))'
  ], {
    timeoutMs: 1000
  })

  assert.equal(result.terminationReason, 'invalid_utf8')
  assert.equal(result.terminationConfirmed, true)
})

test('runBoundedCommand: SIGTERM で終わる子は猶予内に終わる', async () => {
  const root = await makeTempDir()
  const marker = path.join(root, 'terminated')

  try {
    const startedAt = Date.now()
    const result = await runBoundedCommand(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'yes'); process.exit(0) }); setInterval(() => {}, 1000)",
      marker
    ], {
      timeoutMs: 1000,
      terminationGraceMs: 10_000
    })

    assert.equal(result.terminationReason, 'timeout')
    assert.equal(result.terminationConfirmed, true)
    assert.equal(result.exitCode, 0)
    assert.equal(result.signal, null)
    assert.equal(await fs.readFile(marker, 'utf8'), 'yes')
    assert.ok(Date.now() - startedAt < 5000)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runBoundedCommand: SIGTERM を無視する子は猶予の後に SIGKILL される', async () => {
  const startedAt = Date.now()
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  ], {
    timeoutMs: 1000,
    terminationGraceMs: 500
  })

  assert.equal(result.terminationReason, 'timeout')
  assert.equal(result.terminationConfirmed, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(Date.now() - startedAt >= 1500)
})

test('runBoundedCommand: 起動できない実行 file は安定した code で失敗する', async () => {
  await assert.rejects(runBoundedCommand('/__araya_test__/missing-executable', [], {
    env: {},
    timeoutMs: 1000
  }), hasCode('subprocess_launch_failed'))
})

test('runVerificationCommand: exit 0 は passed で、出力を残す', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', "console.log(process.cwd()); console.error('warn')"],
      cwd: root,
      env: { HOME: root },
      timeoutMs: 10_000
    })

    assert.equal(result.status, 'passed')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, `${root}\n`)
    assert.equal(result.stderr, 'warn\n')
    assert.equal(result.terminationConfirmed, true)
    assert.equal(result.reason, undefined)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: 0 以外の exit code は failed', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', 'process.exit(3)'],
      cwd: root,
      env: {},
      timeoutMs: 10_000
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.exitCode, 3)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: timeout は timeout になる', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: {},
      timeoutMs: 1000
    })

    assert.equal(result.status, 'timeout')
    assert.equal(result.terminationConfirmed, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: 実行 file が無ければ launch_failed', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: ['araya-test-command-that-does-not-exist'],
      cwd: root,
      env: { PATH: root },
      timeoutMs: 1000
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'launch_failed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: cwd が無ければ起動せずに cwd_missing', async () => {
  const root = await makeTempDir()
  const marker = path.join(root, 'started')

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker],
      cwd: path.join(root, 'missing'),
      env: {},
      timeoutMs: 1000
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'cwd_missing')
    assert.equal(await exists(marker), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runBoundedCommand: signal が中止されると timeout と同じ手順で process group を止め、aborted になる', async () => {
  const root = await makeTempDir()
  const marker = path.join(root, 'terminated')
  const controller = new AbortController()

  try {
    const startedAt = Date.now()
    const running = runBoundedCommand(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'yes'); process.exit(0) }); setInterval(() => {}, 1000)",
      marker
    ], {
      timeoutMs: 60_000,
      terminationGraceMs: 10_000,
      signal: controller.signal
    })
    setTimeout(() => {
      controller.abort()
    }, 300)
    const result = await running

    assert.equal(result.terminationReason, 'aborted')
    assert.equal(result.terminationConfirmed, true)
    assert.equal(result.exitCode, 0)
    assert.equal(await fs.readFile(marker, 'utf8'), 'yes')
    assert.ok(Date.now() - startedAt < 5000)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runBoundedCommand: 中止された signal を受けると起動しない', async () => {
  const root = await makeTempDir()
  const marker = path.join(root, 'started')

  try {
    const result = await runBoundedCommand(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker], {
      timeoutMs: 1000,
      signal: AbortSignal.abort()
    })

    assert.equal(result.terminationReason, 'aborted')
    assert.equal(result.exitCode, null)
    assert.equal(await exists(marker), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: launch で起動し、signal の中止で止めた検証は failed（aborted）', async () => {
  const root = await makeTempDir()
  const controller = new AbortController()
  const launched: string[][] = []

  try {
    const running = runVerificationCommand({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
      launch: (command, args, options) => {
        launched.push([command, ...args])
        return runBoundedCommand(command, args, options)
      }
    })
    setTimeout(() => {
      controller.abort()
    }, 300)
    const result = await running

    assert.deepEqual(launched, [[process.execPath, '-e', 'setInterval(() => {}, 1000)']])
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'aborted')
    assert.equal(result.terminationConfirmed, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
