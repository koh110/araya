import fs from 'node:fs/promises'
import net, { type Server, type Socket } from 'node:net'
import path from 'node:path'

const SOCKET_DIRECTORY = 'runtime'
const SOCKET_FILE = 'progress.sock'
const MAX_UNIX_SOCKET_PATH_BYTES = 107
const MAX_WAKE_BYTES = 128
const SOCKET_MODE = 0o600
const DIRECTORY_MODE = 0o700
const SEND_TIMEOUT_MS = 250
const PROBE_TIMEOUT_MS = 250

type SocketIdentity = { dev: number; ino: number; uid: number }
type DirectoryIdentity = { dev: number; ino: number; uid: number }

function progressSocketError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function currentUid() {
  const uid = process.getuid?.()

  if (uid === undefined) {
    throw progressSocketError('progress_socket_unsupported', 'Unix progress socket requires a POSIX user id')
  }

  return uid
}

export function progressSocketPath(dataDir: string) {
  return path.join(path.resolve(dataDir), SOCKET_DIRECTORY, SOCKET_FILE)
}

function assertSocketPathLength(socketPath: string) {
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw progressSocketError(
      'progress_socket_path_too_long',
      `Unix socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes`,
    )
  }
}

async function ensurePrivateRuntimeDirectory(dataDir: string) {
  const uid = currentUid()
  const dataStat = await fs.lstat(dataDir)

  if (!dataStat.isDirectory() || dataStat.uid !== uid) {
    throw progressSocketError('progress_socket_unsafe_path', 'data directory must be a directory owned by the service user')
  }

  const runtimeDir = path.join(dataDir, SOCKET_DIRECTORY)
  let created = false

  try {
    await fs.mkdir(runtimeDir, { mode: DIRECTORY_MODE })
    created = true
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error
    }
  }

  if (created) {
    await fs.chmod(runtimeDir, DIRECTORY_MODE)
  }

  const runtimeStat = await fs.lstat(runtimeDir)

  if (
    !runtimeStat.isDirectory() ||
    runtimeStat.uid !== uid ||
    (Number(runtimeStat.mode) & 0o777) !== DIRECTORY_MODE
  ) {
    throw progressSocketError(
      'progress_socket_unsafe_path',
      'runtime directory must be a non-symlink directory owned by the service user with mode 0700',
    )
  }

  const socketPath = progressSocketPath(dataDir)
  assertSocketPathLength(socketPath)

  return {
    runtimeDir,
    socketPath,
    uid,
    directoryIdentity: { dev: runtimeStat.dev, ino: runtimeStat.ino, uid: runtimeStat.uid },
  }
}

async function socketStatOrNull(socketPath: string) {
  try {
    return await fs.lstat(socketPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null
    }

    throw error
  }
}

function sameSocketIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>, identity: SocketIdentity) {
  return stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino && stat.uid === identity.uid
}

function sameDirectoryIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>, identity: DirectoryIdentity) {
  return stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino &&
    stat.uid === identity.uid && (Number(stat.mode) & 0o777) === DIRECTORY_MODE
}

async function runtimeDirectoryMatches(runtimeDir: string, identity: DirectoryIdentity) {
  const stat = await fs.lstat(runtimeDir).catch(() => null)

  return stat !== null && sameDirectoryIdentity(stat, identity)
}

async function probeSocket(socketPath: string) {
  return await new Promise<'active' | 'stale' | 'missing' | 'unknown'>((resolve) => {
    const client = net.createConnection(socketPath)
    let settled = false
    const timer = setTimeout(() => {
      finish('unknown')
    }, PROBE_TIMEOUT_MS)

    function finish(result: 'active' | 'stale' | 'missing' | 'unknown') {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      client.destroy()
      resolve(result)
    }

    client.once('connect', () => finish('active'))
    client.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish('stale')
      } else if (error.code === 'ENOENT') {
        finish('missing')
      } else {
        finish('unknown')
      }
    })
  })
}

async function removeStaleSocket(
  runtimeDir: string,
  directoryIdentity: DirectoryIdentity,
  socketPath: string,
  uid: number,
) {
  const before = await socketStatOrNull(socketPath)

  if (before === null) {
    return
  }

  if (!before.isSocket() || before.uid !== uid) {
    throw progressSocketError('progress_socket_unsafe_path', 'existing progress path is not a socket owned by the service user')
  }

  const probe = await probeSocket(socketPath)

  if (probe === 'active') {
    throw progressSocketError('progress_socket_in_use', 'another progress socket listener is active')
  }

  if (probe === 'unknown') {
    throw progressSocketError('progress_socket_probe_failed', 'could not safely determine whether the existing socket is active')
  }

  const after = await socketStatOrNull(socketPath)

  if (after === null) {
    return
  }

  if (
    !sameSocketIdentity(after, { dev: before.dev, ino: before.ino, uid: before.uid })
  ) {
    throw progressSocketError('progress_socket_unsafe_path', 'existing socket changed while checking for a stale listener')
  }

  if (!(await runtimeDirectoryMatches(runtimeDir, directoryIdentity))) {
    throw progressSocketError('progress_socket_unsafe_path', 'runtime directory changed while checking for a stale socket')
  }

  await fs.unlink(socketPath)
}

function parseWakeLine(line: string) {
  if (Buffer.byteLength(line, 'utf8') > MAX_WAKE_BYTES) {
    return false
  }

  try {
    const parsed: unknown = JSON.parse(line)

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 && 'type' in parsed && parsed.type === 'wake'
  } catch {
    return false
  }
}

function handleSocket(socket: Socket, onWake: () => void, clients: Set<Socket>) {
  clients.add(socket)
  let buffer = ''
  let handled = false

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')

    if (Buffer.byteLength(buffer, 'utf8') > MAX_WAKE_BYTES) {
      socket.destroy()
      return
    }

    const newline = buffer.indexOf('\n')

    if (newline < 0) {
      return
    }

    const line = buffer.slice(0, newline)

    if (handled || buffer.slice(newline + 1).length > 0 || !parseWakeLine(line)) {
      socket.end('{"type":"rejected"}\n')
      return
    }

    handled = true
    try {
      onWake()
    } catch {
      // wake handler errors do not affect the runner's bounded local send
    }
    socket.end('{"type":"accepted"}\n')
  })

  socket.on('close', () => {
    clients.delete(socket)
  })

  socket.on('error', () => {
    clients.delete(socket)
  })
}

export type ProgressSocketServer = {
  readonly path: string
  close(): Promise<void>
}

// Discord bot 側で wake-only の NDJSON socket を listen する。既存 path は socket identity を確かめてから stale file のみ削除
export async function startProgressSocketServer(dataDir: string, onWake: () => void): Promise<ProgressSocketServer> {
  const { runtimeDir, socketPath, uid, directoryIdentity } = await ensurePrivateRuntimeDirectory(dataDir)
  await removeStaleSocket(runtimeDir, directoryIdentity, socketPath, uid)
  const clients = new Set<Socket>()
  const server: Server = net.createServer((socket) => {
    handleSocket(socket, onWake, clients)
  })

  await new Promise<void>((resolve, reject) => {
    function onError(error: Error) {
      server.off('listening', onListening)
      reject(error)
    }

    function onListening() {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })

  let identity: SocketIdentity | null = null

  try {
    if (!(await runtimeDirectoryMatches(runtimeDir, directoryIdentity))) {
      throw progressSocketError('progress_socket_unsafe_path', 'runtime directory changed while starting the listener')
    }

    const created = await fs.lstat(socketPath)
    identity = { dev: created.dev, ino: created.ino, uid: created.uid }

    if (!created.isSocket() || created.uid !== uid) {
      throw progressSocketError('progress_socket_unsafe_path', 'listener did not create an owned Unix socket')
    }

    await fs.chmod(socketPath, SOCKET_MODE)
    const secured = await fs.lstat(socketPath)

    if (!sameSocketIdentity(secured, identity) || (Number(secured.mode) & 0o777) !== SOCKET_MODE) {
      throw progressSocketError('progress_socket_unsafe_path', 'listener socket permissions or identity are invalid')
    }
  } catch (error) {
    for (const client of clients) {
      client.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const current = await socketStatOrNull(socketPath)

    if (
      identity !== null &&
      current !== null &&
      sameSocketIdentity(current, identity) &&
      await runtimeDirectoryMatches(runtimeDir, directoryIdentity)
    ) {
      await fs.unlink(socketPath).catch(() => {})
    }

    throw error
  }

  let closed = false

  return {
    path: socketPath,
    async close() {
      if (closed) {
        return
      }

      closed = true
      for (const client of clients) {
        client.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const current = await socketStatOrNull(socketPath)

      if (
        identity !== null &&
        current !== null &&
        sameSocketIdentity(current, identity) &&
        await runtimeDirectoryMatches(runtimeDir, directoryIdentity)
      ) {
        await fs.unlink(socketPath)
      }
    },
  }
}

// Runner から送るのは固定 wake signal のみ。socket がない/壊れている場合は false で返し、実行は継続する
export async function sendProgressWake(dataDir: string, timeoutMs = SEND_TIMEOUT_MS) {
  const socketPath = progressSocketPath(dataDir)

  try {
    assertSocketPathLength(socketPath)
  } catch {
    return false
  }

  return await new Promise<boolean>((resolve) => {
    let socket: Socket

    try {
      socket = net.createConnection(socketPath)
    } catch {
      resolve(false)
      return
    }

    let settled = false
    let acknowledgement = ''
    const timer = setTimeout(() => finish(false), timeoutMs)

    function finish(result: boolean) {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => {
      socket.write('{"type":"wake"}\n')
    })
    socket.on('data', (chunk: Buffer) => {
      acknowledgement += chunk.toString('utf8')

      if (acknowledgement.length > MAX_WAKE_BYTES) {
        finish(false)
        return
      }

      if (acknowledgement.endsWith('\n')) {
        finish(acknowledgement === '{"type":"accepted"}\n')
      }
    })
    socket.once('error', () => finish(false))
  })
}
