import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const opRunnerSource = path.join(packageRoot, 'bin', 'discord-op-runner.ts')
const discordConfigSource = path.join(packageRoot, 'src', 'discord', 'config.ts')
const TEST_SERVICE_TOKEN = 'synthetic-service-account-token'

const fakeOpScript = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const separator = args.indexOf('--')
const command = args[separator + 1]
const commandArgs = args.slice(separator + 2)
const token = process.env.OP_SERVICE_ACCOUNT_TOKEN

await writeFile(process.env.ARAYA_TEST_OP_RECORD, JSON.stringify({
  args,
  tokenPresent: token !== undefined,
  tokenMatchesCredential: token === ${JSON.stringify(TEST_SERVICE_TOKEN)},
  tokenInArgs: token !== undefined && args.includes(token),
  credentialsDirectoryPresent: process.env.CREDENTIALS_DIRECTORY !== undefined,
  connectHostPresent: process.env.OP_CONNECT_HOST !== undefined,
  connectTokenPresent: process.env.OP_CONNECT_TOKEN !== undefined,
  sessionPresent: process.env.OP_SESSION !== undefined,
  accountPresent: process.env.OP_ACCOUNT !== undefined,
}), 'utf8')

const child = spawn(command, commandArgs, {
  env: { ...process.env, ARAYA_DISCORD_BOT_TOKEN: 'resolved-by-op' },
  stdio: 'inherit',
})
child.once('error', () => {
  process.exitCode = 127
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
`

const fakeBotScript = `import { writeFile } from 'node:fs/promises'

await writeFile(process.env.ARAYA_TEST_BOT_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  botToken: process.env.ARAYA_DISCORD_BOT_TOKEN,
  serviceTokenPresent: process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined,
  credentialsDirectoryPresent: process.env.CREDENTIALS_DIRECTORY !== undefined,
  connectHostPresent: process.env.OP_CONNECT_HOST !== undefined,
  connectTokenPresent: process.env.OP_CONNECT_TOKEN !== undefined,
  sessionPresent: process.env.OP_SESSION !== undefined,
  accountPresent: process.env.OP_ACCOUNT !== undefined,
}), 'utf8')
`

async function makeFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-op-runner-test-')),
  )
  const dataDir = path.join(root, 'data')
  const packageDir = path.join(root, 'package')
  const packageBinDir = path.join(packageDir, 'bin')
  const packageConfigDir = path.join(packageDir, 'src', 'discord')
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
  await fs.mkdir(path.dirname(opPath), { recursive: true })
  await fs.mkdir(credentialsDirectory, { recursive: true })
  await fs.writeFile(path.join(packageDir, 'package.json'), '{"type":"module"}\n', 'utf8')
  await fs.copyFile(opRunnerSource, opRunnerPath)
  await fs.copyFile(discordConfigSource, path.join(packageConfigDir, 'config.ts'))
  await fs.writeFile(botPath, fakeBotScript, 'utf8')
  await fs.writeFile(opPath, fakeOpScript, { mode: 0o700 })
  await fs.writeFile(credentialPath, `${TEST_SERVICE_TOKEN}\n`, { mode: 0o400 })
  await fs.writeFile(
    path.join(dataDir, 'discord.env'),
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
    ARAYA_DATA_DIR: dataDir,
    CREDENTIALS_DIRECTORY: credentialsDirectory,
    OP_SERVICE_ACCOUNT_TOKEN: 'ambient-test-token',
    OP_CONNECT_HOST: 'https://connect.invalid',
    OP_CONNECT_TOKEN: 'synthetic-connect-token',
    OP_SESSION: 'synthetic-op-session',
    OP_ACCOUNT: 'synthetic-account',
    ARAYA_TEST_OP_RECORD: opRecordPath,
    ARAYA_TEST_BOT_RECORD: botRecordPath,
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

    const opRecord = JSON.parse(await fs.readFile(fixture.opRecordPath, 'utf8')) as {
      args: string[]
      tokenPresent: boolean
      tokenMatchesCredential: boolean
      tokenInArgs: boolean
      credentialsDirectoryPresent: boolean
      connectHostPresent: boolean
      connectTokenPresent: boolean
      sessionPresent: boolean
      accountPresent: boolean
    }
    const botRecord = JSON.parse(await fs.readFile(fixture.botRecordPath, 'utf8')) as {
      args: string[]
      botToken: string
      serviceTokenPresent: boolean
      credentialsDirectoryPresent: boolean
      connectHostPresent: boolean
      connectTokenPresent: boolean
      sessionPresent: boolean
      accountPresent: boolean
    }

    assert.deepEqual(opRecord, {
      args: [
        'run',
        '--env-file',
        path.join(fixture.dataDir, 'discord.env'),
        '--',
        '/usr/bin/env',
        '-u',
        'OP_SERVICE_ACCOUNT_TOKEN',
        '-u',
        'CREDENTIALS_DIRECTORY',
        process.execPath,
        fixture.botPath,
        '--data-dir',
        fixture.dataDir,
      ],
      tokenPresent: true,
      tokenMatchesCredential: true,
      tokenInArgs: false,
      credentialsDirectoryPresent: false,
      connectHostPresent: false,
      connectTokenPresent: false,
      sessionPresent: false,
      accountPresent: false,
    })
    assert.deepEqual(botRecord, {
      args: ['--data-dir', fixture.dataDir],
      botToken: 'resolved-by-op',
      serviceTokenPresent: false,
      credentialsDirectoryPresent: false,
      connectHostPresent: false,
      connectTokenPresent: false,
      sessionPresent: false,
      accountPresent: false,
    })
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
