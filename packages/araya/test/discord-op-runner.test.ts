import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const opRunnerSource = path.join(packageRoot, 'bin', 'discord-op-runner.ts')
const discordConfigSource = path.join(packageRoot, 'src', 'discord', 'config.ts')
const childLauncherSource = path.join(packageRoot, 'src', 'infrastructure', 'child-launcher.ts')
const TEST_SERVICE_TOKEN = 'synthetic-service-account-token'

function fakeOpScript(opRecordPath: string, delayMs = 0) {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, writeFile, lstat } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const separator = args.indexOf('--')
const envFilePath = args[args.indexOf('--env-file') + 1]
const command = args[separator + 1]
const commandArgs = args.slice(separator + 2)
const token = process.env.OP_SERVICE_ACCOUNT_TOKEN
const fileEnvironment = Object.fromEntries((await readFile(envFilePath, 'utf8'))
  .split(/\\r?\\n/u)
  .filter((line) => line !== '' && !line.trimStart().startsWith('#'))
  .map((line) => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
const resolvedByOp = {
  ARAYA_DISCORD_BOT_TOKEN: 'resolved-by-op',
  ARAYA_DISCORD_APPLICATION_ID: '12345678901234567',
  ARAYA_DISCORD_GUILD_ID: '23456789012345678',
  ARAYA_DISCORD_CHANNEL_ID: '34567890123456789',
  ARAYA_DISCORD_ALLOWED_USER_IDS: '45678901234567890',
}
const childEnvironment = { ...process.env }

for (const [name, value] of Object.entries(fileEnvironment)) {
  childEnvironment[name] = value.startsWith('op://') ? resolvedByOp[name] : value
}

const secretValues = Object.entries(fileEnvironment)
  .filter(([, value]) => value.startsWith('op://'))
  .map(([name]) => resolvedByOp[name])
  .filter((value) => typeof value === 'string' && value !== '')
const resolverSocketPath = commandArgs.at(-1) ?? ''
const relayDirectoryStat = await lstat(path.dirname(resolverSocketPath))
const relaySocketStat = await lstat(resolverSocketPath)

await writeFile(${JSON.stringify(opRecordPath)}, JSON.stringify({
  args,
  resolverSocketPath,
  relayDirectoryMode: relayDirectoryStat.mode & 0o777,
  relaySocketMode: relaySocketStat.mode & 0o777,
  relayIsSocket: relaySocketStat.isSocket(),
  tokenPresent: token !== undefined,
  tokenMatchesCredential: token === ${JSON.stringify(TEST_SERVICE_TOKEN)},
  tokenInArgs: token !== undefined && args.includes(token),
  credentialsDirectoryPresent: process.env.CREDENTIALS_DIRECTORY !== undefined,
  connectHostPresent: process.env.OP_CONNECT_HOST !== undefined,
  connectTokenPresent: process.env.OP_CONNECT_TOKEN !== undefined,
  sessionPresent: process.env.OP_SESSION !== undefined,
  accountPresent: process.env.OP_ACCOUNT !== undefined,
  awsSecretPresent: process.env.AWS_SECRET_ACCESS_KEY !== undefined,
  githubTokenPresent: process.env.GITHUB_TOKEN !== undefined,
}), 'utf8')

if (${JSON.stringify(delayMs)} > 0) {
  await new Promise((resolve) => setTimeout(resolve, ${JSON.stringify(delayMs)}))
}

const child = spawn(command, commandArgs, {
  env: childEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout?.setEncoding('utf8')
child.stderr?.setEncoding('utf8')
child.stdout?.on('data', (chunk) => { stdout += chunk })
child.stderr?.on('data', (chunk) => { stderr += chunk })
child.once('error', () => {
  process.exitCode = 127
})
child.once('close', (code) => {
  const redact = (text) => secretValues.reduce((result, secret) => result.split(secret).join('[REDACTED BY OP CLI]'), text)
  process.stdout.write(redact(stdout))
  process.stderr.write(redact(stderr))
  process.exitCode = code ?? 1
})
`
}

function fakeBotScript(botRecordPath: string) {
  return `import { writeFile } from 'node:fs/promises'

await writeFile(${JSON.stringify(botRecordPath)}, JSON.stringify({
  args: process.argv.slice(2),
  botToken: process.env.ARAYA_DISCORD_BOT_TOKEN,
  applicationId: process.env.ARAYA_DISCORD_APPLICATION_ID,
  guildId: process.env.ARAYA_DISCORD_GUILD_ID,
  channelId: process.env.ARAYA_DISCORD_CHANNEL_ID,
  allowedUserIds: process.env.ARAYA_DISCORD_ALLOWED_USER_IDS,
  serviceTokenPresent: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
  credentialsDirectoryPresent: process.env.CREDENTIALS_DIRECTORY !== undefined,
  connectHostPresent: process.env.OP_CONNECT_HOST !== undefined,
  connectTokenPresent: process.env.OP_CONNECT_TOKEN !== undefined,
  sessionPresent: process.env.OP_SESSION !== undefined,
  accountPresent: process.env.OP_ACCOUNT !== undefined,
  awsSecretPresent: process.env.AWS_SECRET_ACCESS_KEY !== undefined,
  githubTokenPresent: process.env.GITHUB_TOKEN !== undefined,
  invocationId: process.env.INVOCATION_ID,
}), 'utf8')
`
}

async function makeFixture(botScript?: string, opDelayMs = 0) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-op-runner-test-')),
  )
  const dataDir = path.join(root, 'data')
  const packageDir = path.join(root, 'package')
  const packageBinDir = path.join(packageDir, 'bin')
  const packageConfigDir = path.join(packageDir, 'src', 'discord')
  const packageInfrastructureDir = path.join(packageDir, 'src', 'infrastructure')
  const credentialsDirectory = path.join(root, 'credentials')
  const opPath = path.join(root, 'bin', 'op')
  const opRunnerPath = path.join(packageBinDir, 'discord-op-runner.ts')
  const botPath = path.join(packageBinDir, 'discord-bot.ts')
  const credentialPath = path.join(credentialsDirectory, 'op-service-account-token')
  const opRecordPath = path.join(root, 'op-record.json')
  const botRecordPath = path.join(root, 'bot-record.json')

  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(packageBinDir, { recursive: true })
  await fs.mkdir(packageConfigDir, { recursive: true })
  await fs.mkdir(packageInfrastructureDir, { recursive: true })
  await fs.mkdir(path.dirname(opPath), { recursive: true })
  await fs.mkdir(credentialsDirectory, { recursive: true })
  await fs.writeFile(path.join(packageDir, 'package.json'), '{"type":"module"}\n', 'utf8')
  await fs.copyFile(opRunnerSource, opRunnerPath)
  await fs.copyFile(discordConfigSource, path.join(packageConfigDir, 'config.ts'))
  await fs.copyFile(childLauncherSource, path.join(packageInfrastructureDir, 'child-launcher.ts'))
  await fs.writeFile(botPath, botScript ?? fakeBotScript(botRecordPath), 'utf8')
  await fs.writeFile(opPath, fakeOpScript(opRecordPath, opDelayMs), { mode: 0o700 })
  await fs.writeFile(credentialPath, `${TEST_SERVICE_TOKEN}\n`, { mode: 0o400 })
  await fs.writeFile(
    path.join(dataDir, '.env'),
    [
      'ARAYA_DISCORD_BOT_TOKEN=op://vault/item/bot-token',
      'ARAYA_DISCORD_APPLICATION_ID=12345678901234567',
      'ARAYA_DISCORD_GUILD_ID=23456789012345678',
      'ARAYA_DISCORD_CHANNEL_ID=34567890123456789',
      'ARAYA_DISCORD_ALLOWED_USER_IDS=45678901234567890',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )

  const env: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    INVOCATION_ID: 'service-invocation-id',
    ARAYA_DATA_DIR: dataDir,
    CREDENTIALS_DIRECTORY: credentialsDirectory,
    OP_SERVICE_ACCOUNT_TOKEN: 'ambient-test-token',
    OP_CONNECT_HOST: 'https://connect.invalid',
    OP_CONNECT_TOKEN: 'synthetic-connect-token',
    OP_SESSION: 'synthetic-op-session',
    OP_ACCOUNT: 'synthetic-account',
    AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret',
    GITHUB_TOKEN: 'synthetic-github-secret',
  }

  return {
    root,
    dataDir,
    credentialsDirectory,
    opPath,
    opRunnerPath,
    botPath,
    credentialPath,
    opRecordPath,
    botRecordPath,
    env,
  }
}

test('discord-op-runner: LoadCredential token を op run にだけ渡し、Araya から除去する', async () => {
  const fixture = await makeFixture()

  try {
    execFileSync(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { encoding: 'utf8', env: fixture.env },
    )

    const opRecord: {
      args: string[]
      resolverSocketPath: string
      relayDirectoryMode: number
      relaySocketMode: number
      relayIsSocket: boolean
      tokenPresent: boolean
      tokenMatchesCredential: boolean
      tokenInArgs: boolean
      credentialsDirectoryPresent: boolean
      connectHostPresent: boolean
      connectTokenPresent: boolean
      sessionPresent: boolean
      accountPresent: boolean
      awsSecretPresent: boolean
      githubTokenPresent: boolean
    } = JSON.parse(await fs.readFile(fixture.opRecordPath, 'utf8'))
    const botRecord: {
      args: string[]
      botToken: string
      applicationId: string
      guildId: string
      channelId: string
      allowedUserIds: string
      serviceTokenPresent: boolean
      credentialsDirectoryPresent: boolean
      connectHostPresent: boolean
      connectTokenPresent: boolean
      sessionPresent: boolean
      accountPresent: boolean
      awsSecretPresent: boolean
      githubTokenPresent: boolean
      invocationId: string
    } = JSON.parse(await fs.readFile(fixture.botRecordPath, 'utf8'))

    const {
      args: opArgs,
      resolverSocketPath,
      relayDirectoryMode,
      relaySocketMode,
      relayIsSocket,
      ...opSecurity
    } = opRecord
    const strippedNames = [
      'CREDENTIALS_DIRECTORY',
      'OP_CONNECT_HOST',
      'OP_CONNECT_TOKEN',
      'OP_SESSION',
      'OP_ACCOUNT',
      'OP_SERVICE_ACCOUNT_TOKEN',
    ]

    assert.deepEqual(opSecurity, {
      tokenPresent: true,
      tokenMatchesCredential: true,
      tokenInArgs: false,
      credentialsDirectoryPresent: false,
      connectHostPresent: false,
      connectTokenPresent: false,
      sessionPresent: false,
      accountPresent: false,
      awsSecretPresent: false,
      githubTokenPresent: false,
    })
    // op run は .env の値だけを解決し、runner が private Unix socket から受け取る。stdout には載せない。
    assert.deepEqual(opArgs.slice(0, 19), [
      'run',
      '--env-file',
      path.join(fixture.dataDir, '.env'),
      '--',
      '/usr/bin/env',
      '-u',
      'CREDENTIALS_DIRECTORY',
      '-u',
      'OP_CONNECT_HOST',
      '-u',
      'OP_CONNECT_TOKEN',
      '-u',
      'OP_SESSION',
      '-u',
      'OP_ACCOUNT',
      '-u',
      'OP_SERVICE_ACCOUNT_TOKEN',
      process.execPath,
      '-e',
    ])
    const resolverScript = opArgs[19] ?? ''
    assert.match(resolverScript, /createConnection/u)
    assert.match(resolverScript, /JSON\.stringify\(snapshot\)/u)
    assert.doesNotMatch(resolverScript, /process\.stdout/u)
    assert.deepEqual(
      opArgs.slice(5, 17),
      strippedNames.flatMap((name) => {
        return ['-u', name]
      }),
    )
    assert.equal(opArgs[17], process.execPath)
    assert.equal(opArgs[18], '-e')
    assert.equal(resolverSocketPath, opArgs[20])
    assert.equal(path.basename(resolverSocketPath), 's')
    assert.ok(path.basename(path.dirname(resolverSocketPath)).startsWith('araya-op-env-'))
    assert.equal(relayDirectoryMode, 0o700)
    assert.equal(relaySocketMode, 0o600)
    assert.equal(relayIsSocket, true)
    assert.ok(!opArgs.includes(fixture.botPath), 'op run の args に bot を含まない')
    assert.deepEqual(botRecord, {
      args: ['--data-dir', fixture.dataDir],
      botToken: 'resolved-by-op',
      applicationId: '12345678901234567',
      guildId: '23456789012345678',
      channelId: '34567890123456789',
      allowedUserIds: '45678901234567890',
      serviceTokenPresent: false,
      credentialsDirectoryPresent: false,
      connectHostPresent: false,
      connectTokenPresent: false,
      sessionPresent: false,
      accountPresent: false,
      awsSecretPresent: false,
      githubTokenPresent: false,
      invocationId: 'service-invocation-id',
    })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: Bot Token 以外の Discord 設定も op:// から解決する', async () => {
  const fixture = await makeFixture()

  try {
    const envFilePath = path.join(fixture.dataDir, '.env')
    await fs.writeFile(
      envFilePath,
      (await fs.readFile(envFilePath, 'utf8'))
        .replace(
          'ARAYA_DISCORD_BOT_TOKEN=op://vault/item/bot-token',
          'ARAYA_DISCORD_BOT_TOKEN=synthetic-plain-bot-token',
        )
        .replace(
          'ARAYA_DISCORD_APPLICATION_ID=12345678901234567',
          'ARAYA_DISCORD_APPLICATION_ID=op://vault/item/application-id',
        )
        .replace(
          'ARAYA_DISCORD_GUILD_ID=23456789012345678',
          'ARAYA_DISCORD_GUILD_ID=op://vault/item/guild-id',
        )
        .replace(
          'ARAYA_DISCORD_CHANNEL_ID=34567890123456789',
          'ARAYA_DISCORD_CHANNEL_ID=op://vault/item/channel-id',
        )
        .replace(
          'ARAYA_DISCORD_ALLOWED_USER_IDS=45678901234567890',
          'ARAYA_DISCORD_ALLOWED_USER_IDS=op://vault/item/allowed-user-ids',
        ),
      { mode: 0o600 },
    )

    const result = spawnSync(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { encoding: 'utf8', env: fixture.env },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '', 'resolved secret values are not serialized to op run stdout')
    assert.ok(!result.stderr.includes('[REDACTED BY OP CLI]'))
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.botRecordPath, 'utf8')), {
      args: ['--data-dir', fixture.dataDir],
      botToken: 'synthetic-plain-bot-token',
      applicationId: '12345678901234567',
      guildId: '23456789012345678',
      channelId: '34567890123456789',
      allowedUserIds: '45678901234567890',
      serviceTokenPresent: false,
      credentialsDirectoryPresent: false,
      connectHostPresent: false,
      connectTokenPresent: false,
      sessionPresent: false,
      accountPresent: false,
      awsSecretPresent: false,
      githubTokenPresent: false,
      invocationId: 'service-invocation-id',
    })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: .env の未対応な secret key を op と bot に渡す前に拒否する', async () => {
  const fixture = await makeFixture()

  try {
    await fs.appendFile(
      path.join(fixture.dataDir, '.env'),
      'AWS_SECRET_ACCESS_KEY=do-not-leak-this-value\n',
      'utf8',
    )

    const result = spawnSync(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { encoding: 'utf8', env: fixture.env },
    )

    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes('未対応の設定名 AWS_SECRET_ACCESS_KEY'))
    assert.ok(!result.stderr.includes('do-not-leak-this-value'))
    await assert.rejects(fs.access(fixture.opRecordPath))
    await assert.rejects(fs.access(fixture.botRecordPath))
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: credential directory が無い場合は op を起動しない', async () => {
  const fixture = await makeFixture()

  try {
    const env = { ...fixture.env }
    delete env.CREDENTIALS_DIRECTORY
    const result = spawnSync(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { encoding: 'utf8', env },
    )

    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes('CREDENTIALS_DIRECTORY'))
    assert.ok(!result.stderr.includes(TEST_SERVICE_TOKEN))
    await assert.rejects(fs.access(fixture.opRecordPath))
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: credential file が他ユーザーに読める場合は拒否する', async () => {
  const fixture = await makeFixture()

  try {
    await fs.chmod(fixture.credentialPath, 0o644)
    const result = spawnSync(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { encoding: 'utf8', env: fixture.env },
    )

    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes('credential'))
    assert.ok(!result.stderr.includes(TEST_SERVICE_TOKEN))
    await assert.rejects(fs.access(fixture.opRecordPath))
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

function sigtermDuringRelayCloseHook() {
  return `import net from 'node:net'
import path from 'node:path'

const originalClose = net.Server.prototype.close
function closeWithSignal(callback) {
  const address = this.address()
  const socketPath = typeof address === 'string'
    ? address
    : typeof address === 'object' && address !== null && 'path' in address && typeof address.path === 'string'
      ? address.path
      : null
  const isResolverSocket = socketPath !== null &&
    path.basename(path.dirname(socketPath)).startsWith('araya-op-env-')

  if (isResolverSocket) {
    process.kill(process.pid, 'SIGTERM')
    setTimeout(() => originalClose.call(this, callback), 50)
    return this
  }

  return originalClose.call(this, callback)
}

net.Server.prototype.close = closeWithSignal
`
}

test('discord-op-runner: relay cleanup 中の SIGTERM は bot startup を止める', async () => {
  const fixture = await makeFixture()
  const hookPath = path.join(fixture.root, 'sigterm-during-relay-close.mjs')
  await fs.writeFile(hookPath, sigtermDuringRelayCloseHook(), 'utf8')
  let child: ReturnType<typeof spawn> | undefined
  let relayDirectory: string | undefined

  try {
    child = spawn(
      process.execPath,
      [
        '--import',
        hookPath,
        fixture.opRunnerPath,
        '--data-dir',
        fixture.dataDir,
        '--op-path',
        fixture.opPath,
      ],
      { env: fixture.env },
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    assert.deepEqual(
      await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => {
          child?.kill('SIGKILL')
          resolve({ code: null, signal: 'SIGKILL' })
        }, 5_000)
        child?.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      }),
      { code: 1, signal: null },
      stderr,
    )

    const { resolverSocketPath: socketPath }: { resolverSocketPath: string } = JSON.parse(
      await fs.readFile(fixture.opRecordPath, 'utf8'),
    )
    relayDirectory = path.dirname(socketPath)
    await assert.rejects(fs.access(fixture.botRecordPath), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(relayDirectory), { code: 'ENOENT' })
  } finally {
    child?.kill('SIGKILL')

    if (relayDirectory !== undefined) {
      await fs.rm(relayDirectory, { recursive: true, force: true })
    }

    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

// #36: runner（unit の main process）が bot より先に死ぬと、KillMode=control-group の systemd は
// 残った bot を SIGKILL して drain を途中で潰す。runner が bot の終了を待つことを実証する。
function drainingBotScript(startPath: string, stopPath: string) {
  return `import { writeFile } from 'node:fs/promises'

await writeFile(${JSON.stringify(startPath)}, JSON.stringify({
  pid: process.pid,
  botToken: process.env.ARAYA_DISCORD_BOT_TOKEN,
  serviceTokenPresent: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
}), 'utf8')

const keepAlive = setInterval(() => {}, 100)

process.on('SIGTERM', () => {
  clearInterval(keepAlive)

  // bot 側の drain（reply 送信と close）を 250 ms 真似する
  setTimeout(() => {
    void writeFile(${JSON.stringify(stopPath)}, JSON.stringify({ receivedSigterm: true }), 'utf8')
      .then(() => {
        process.exit(0)
      })
  }, 250)
})

await new Promise(() => {})
`
}

async function waitForFile(filePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      await fs.access(filePath)
      return true
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
  }

  return false
}

test('discord-op-runner: env 解決中の SIGTERM で private relay を片付ける', async () => {
  const fixture = await makeFixture(undefined, 10_000)
  let relayDirectory: string | undefined

  try {
    const child = spawn(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { env: fixture.env },
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    assert.ok(await waitForFile(fixture.opRecordPath, 15_000), 'op run が起動し relay を確認した')
    const { resolverSocketPath: socketPath }: { resolverSocketPath: string } = JSON.parse(
      await fs.readFile(fixture.opRecordPath, 'utf8'),
    )
    relayDirectory = path.dirname(socketPath)
    assert.ok((await fs.lstat(socketPath)).isSocket())

    assert.deepEqual(
      await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve({ code: null, signal: 'SIGKILL' })
        }, 5_000)
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
        child.kill('SIGTERM')
      }),
      { code: 1, signal: null },
      stderr,
    )
    await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(relayDirectory), { code: 'ENOENT' })
  } finally {
    if (relayDirectory !== undefined) {
      await fs.rm(relayDirectory, { recursive: true, force: true })
    }

    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: SIGTERM を bot に伝えて bot の drain が終わるまで待ってから 0 で終了する', async () => {
  const startPath = path.join(os.tmpdir(), `araya-op-bot-start-${process.pid}.json`)
  const stopPath = path.join(os.tmpdir(), `araya-op-bot-stop-${process.pid}.json`)
  await fs.rm(startPath, { force: true })
  await fs.rm(stopPath, { force: true })
  const fixture = await makeFixture(drainingBotScript(startPath, stopPath))

  try {
    const child = spawn(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { env: { ...fixture.env, ARAYA_LAUNCHER_STOP_WAIT_MS: '5000' } },
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    assert.ok(await waitForFile(startPath, 15_000), 'bot が起動して env を受け取った')
    const sigtermAt = Date.now()
    child.kill('SIGTERM')
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => {
        resolve(exitCode)
      })
    })

    assert.equal(code, 0, stderr)
    assert.ok(await waitForFile(stopPath, 2_000), 'bot は SIGTERM を受けて drain を完走した')
    assert.ok(Date.now() - sigtermAt >= 200, 'runner は bot より先に死んでいない')
    assert.ok(!stderr.includes('SIGKILL'), 'drain 完了には SIGKILL 不要')
  } finally {
    await fs.rm(startPath, { force: true })
    await fs.rm(stopPath, { force: true })
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: SIGTERM を無視して居座る bot は stop wait 後に SIGKILL して 1 で終了する', async () => {
  const startPath = path.join(os.tmpdir(), `araya-op-stuck-start-${process.pid}.json`)
  const stuckScript = `import { writeFile } from 'node:fs/promises'

await writeFile(${JSON.stringify(startPath)}, JSON.stringify({ pid: process.pid }), 'utf8')
process.on('SIGTERM', () => {})
setInterval(() => {}, 100)
`
  const fixture = await makeFixture(stuckScript)

  try {
    const child = spawn(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { env: { ...fixture.env, ARAYA_LAUNCHER_STOP_WAIT_MS: '400' } },
    )
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })

    assert.ok(await waitForFile(startPath, 15_000), 'bot が起動した')
    const sigtermAt = Date.now()
    child.kill('SIGTERM')
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => {
        resolve(exitCode)
      })
    })

    assert.equal(code, 1, stderr)
    assert.ok(stderr.includes('SIGKILL'), stderr)
    assert.ok(Date.now() - sigtermAt >= 300, 'stop wait を待ってから SIGKILL した')
  } finally {
    await fs.rm(startPath, { force: true })
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('discord-op-runner: bot の stderr は resolved secret を redact して launcher log に写す', async () => {
  const leakingScript = `process.stderr.write('trace with secret resolved-by-op and plain text\\n')
process.stdout.write('stdout is ignored\\n')
process.exit(0)
`
  const fixture = await makeFixture(leakingScript)

  try {
    const result = spawnSync(
      process.execPath,
      [fixture.opRunnerPath, '--data-dir', fixture.dataDir, '--op-path', fixture.opPath],
      { encoding: 'utf8', env: fixture.env },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /trace with secret \[redacted\] and plain text\n/u)
    // launcher log は 1 行 1 record で読めることが必要（改行がリテラル \n になると 1 行に連結する）
    assert.ok(!result.stderr.includes('\\n'), JSON.stringify(result.stderr))
    assert.ok(!result.stderr.includes('resolved-by-op'), 'resolved secret をそのまま出さない')
    assert.ok(
      !result.stderr.includes('stdout is ignored'),
      'bot の stdout は launcher log に流さない',
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
