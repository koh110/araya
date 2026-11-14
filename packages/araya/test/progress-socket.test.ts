import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  progressSocketPath,
  sendProgressWake,
  startProgressSocketServer,
} from '../src/infrastructure/progress-socket.ts'

async function makeDataDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-progress-socket-test-')))
}

async function waitUntil(condition: () => boolean, message: string) {
  const deadline = Date.now() + 2_000

  while (!condition()) {
    if (Date.now() >= deadline) {
      assert.fail(message)
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('progress socket: private runtime directory で wake NDJSON だけを受け付け、重複 wake を届ける', async () => {
  const dataDir = await makeDataDir()
  const wakes: number[] = []
  const server = await startProgressSocketServer(dataDir, () => {
    wakes.push(Date.now())
  })

  try {
    assert.equal(server.path, progressSocketPath(dataDir))
    assert.equal(path.dirname(server.path), path.join(dataDir, 'runtime'))
    assert.equal((await fs.stat(path.dirname(server.path))).mode & 0o777, 0o700)
    assert.equal((await fs.stat(server.path)).mode & 0o777, 0o600)

    assert.equal(await sendProgressWake(dataDir), true)
    await waitUntil(() => wakes.length === 1, 'wake 1 が届かなかった')
    assert.equal(await sendProgressWake(dataDir), true)
    await waitUntil(() => wakes.length === 2, 'wake 2 が届かなかった')
    assert.equal(wakes.length, 2)
  } finally {
    await server.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }

  await assert.rejects(fs.lstat(progressSocketPath(dataDir)), { code: 'ENOENT' })
})

test('progress socket: stale socket を type・owner・inode を確かめてから回収する', async () => {
  const dataDir = await makeDataDir()
  const socketPath = progressSocketPath(dataDir)
  const runtimeDir = path.dirname(socketPath)
  let child: ReturnType<typeof spawn> | undefined
  let server: Awaited<ReturnType<typeof startProgressSocketServer>> | undefined

  try {
    await fs.mkdir(runtimeDir, { mode: 0o700 })
    child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import net from 'node:net'; const server = net.createServer(); server.listen(process.env.ARAYA_TEST_SOCKET_PATH, () => process.stdout.write('ready\\n'))",
      ],
      {
        env: { ...process.env, ARAYA_TEST_SOCKET_PATH: socketPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    await waitUntil(() => stdout.includes('ready'), 'stale socket fixture を起動できなかった')
    child.kill('SIGKILL')
    await new Promise<void>((resolve, reject) => {
      child?.once('close', () => resolve())
      child?.once('error', reject)
    })
    child = undefined
    assert.equal((await fs.lstat(socketPath)).isSocket(), true)

    let wakes = 0
    server = await startProgressSocketServer(dataDir, () => {
      wakes += 1
    })
    assert.equal(await sendProgressWake(dataDir), true)
    await waitUntil(() => wakes === 1, 'stale socket 回収後に wake が届かなかった')
  } finally {
    child?.kill('SIGKILL')
    await server?.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: listener が無い間は失敗を返し、listener の起動後に接続できる', async () => {
  const dataDir = await makeDataDir()
  let wakes = 0

  try {
    assert.equal(await sendProgressWake(dataDir), false)
    const server = await startProgressSocketServer(dataDir, () => {
      wakes += 1
    })

    try {
      assert.equal(await sendProgressWake(dataDir), true)
      await waitUntil(() => wakes === 1, 'listener 起動後の wake が届かなかった')
    } finally {
      await server.close()
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: socket path に通常 file があれば削除せず fail closed', async () => {
  const dataDir = await makeDataDir()
  const socketPath = progressSocketPath(dataDir)
  const runtimeDir = path.dirname(socketPath)
  const content = 'not a socket\n'

  try {
    await fs.mkdir(runtimeDir, { mode: 0o700 })
    await fs.writeFile(socketPath, content, { mode: 0o600 })

    await assert.rejects(
      startProgressSocketServer(dataDir, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok('code' in error)
        assert.equal(error.code, 'progress_socket_unsafe_path')
        return true
      },
    )
    assert.equal(await fs.readFile(socketPath, 'utf8'), content)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: close は socket path の file replacement を保持する', async () => {
  const dataDir = await makeDataDir()
  const server = await startProgressSocketServer(dataDir, () => {})
  const content = 'replacement file must survive listener close'

  try {
    await fs.unlink(server.path)
    await fs.writeFile(server.path, content)
    await server.close()

    assert.equal(await fs.readFile(server.path, 'utf8'), content)
  } finally {
    await server.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: close は socket path の directory replacement を保持する', async () => {
  const dataDir = await makeDataDir()
  const server = await startProgressSocketServer(dataDir, () => {})
  const content = 'replacement directory contents must survive listener close'

  try {
    await fs.unlink(server.path)
    await fs.mkdir(server.path, { mode: 0o700 })
    await fs.writeFile(path.join(server.path, 'marker'), content)
    await server.close()

    assert.equal(await fs.readFile(path.join(server.path, 'marker'), 'utf8'), content)
  } finally {
    await server.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: close は同じ path に bind された replacement socket を保持する', async () => {
  const dataDir = await makeDataDir()
  const original = await startProgressSocketServer(dataDir, () => {})
  let replacement: Awaited<ReturnType<typeof startProgressSocketServer>> | undefined

  try {
    await fs.unlink(original.path)
    replacement = await startProgressSocketServer(dataDir, () => {})

    await original.close()

    assert.equal((await fs.lstat(original.path)).isSocket(), true)
    assert.equal(await sendProgressWake(dataDir), true)
  } finally {
    await replacement?.close()
    await original.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: close は runtime directory replacement 内の entry を削除しない', async () => {
  const dataDir = await makeDataDir()
  const server = await startProgressSocketServer(dataDir, () => {})
  const runtimeDir = path.dirname(server.path)
  const displacedRuntimeDir = path.join(dataDir, 'runtime-before-replacement')
  const content = 'replacement runtime directory entry must survive listener close'

  try {
    await fs.rename(runtimeDir, displacedRuntimeDir)
    await fs.mkdir(runtimeDir, { mode: 0o700 })
    await fs.writeFile(server.path, content)

    await server.close()

    assert.equal(await fs.readFile(server.path, 'utf8'), content)
  } finally {
    await server.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('progress socket: startup failure cleanup は replacement entry を保持する', async () => {
  const dataDir = await makeDataDir()
  const socketPath = progressSocketPath(dataDir)
  const content = 'replacement entry must survive failed listener startup'
  const originalChmod = fs.chmod
  let replaced = false

  try {
    fs.chmod = async (target, mode) => {
      if (!replaced && String(target).endsWith('/progress.sock')) {
        replaced = true
        await fs.unlink(String(target))
        await fs.writeFile(String(target), content)
      }

      return await originalChmod(target, mode)
    }

    await assert.rejects(
      startProgressSocketServer(dataDir, () => {}),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.ok('code' in error)
        assert.equal(error.code, 'progress_socket_unsafe_path')
        return true
      },
    )
    assert.equal(replaced, true)
    assert.equal(await fs.readFile(socketPath, 'utf8'), content)
  } finally {
    fs.chmod = originalChmod
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
