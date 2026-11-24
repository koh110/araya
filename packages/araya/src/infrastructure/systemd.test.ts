import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { pathToFileURL } from 'node:url'

import {
  buildDiscordUnitFile,
  createSystemdOps,
  dataDirHash,
  discordOpServiceAccountTokenFilePath,
  encryptSystemdCredential,
  isUnitFileValueSafe,
  legacyDiscordOpServiceAccountTokenFilePath,
  resolveDiscordEnvRunnerEntrypoint,
  resolveDiscordOpRunnerEntrypoint,
  resolveOpCliPath,
  selectUnitEnvironment,
  shellQuote,
  unitFilePath,
} from './systemd.ts'

async function makeRoot(prefix: string) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

function errorWithCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.ok('code' in error)
    assert.equal(error.code, code, error.message)
    assert.ok(error.message.startsWith(`${code}: `), error.message)

    return true
  }
}

test('systemd-units: shellQuote は単引用符で囲み、bash で元の文字列に戻る', () => {
  const text = `it's $HOME \${PATH} "quoted" \\ \`date\` ;`

  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.equal(
    execFileSync('/bin/bash', ['-c', `printf '%s' ${shellQuote(text)}`], { encoding: 'utf8' }),
    text,
  )
})

test('systemd-units: unit file に書けない文字を判定する', () => {
  assert.equal(isUnitFileValueSafe('/home/user/.araya'), true)
  assert.equal(isUnitFileValueSafe('/usr/bin:/bin'), true)
  assert.equal(isUnitFileValueSafe('ja_JP.UTF-8'), true)

  for (const value of [
    '/a b',
    '/a"b',
    "/a'b",
    '/a\\b',
    '/a$b',
    '/a%b',
    '/a;b',
    '/a\tb',
    '/a\nb',
    '/a\u0000b',
    '/a\u007fb',
  ]) {
    assert.equal(isUnitFileValueSafe(value), false, JSON.stringify(value))
  }
})

test('systemd-units: Environment= には一覧の変数だけを選び、秘密とみなす名前を除き、解決済みの path を書く', () => {
  const environment = selectUnitEnvironment(
    {
      PATH: '/usr/bin:/bin',
      LANG: 'ja_JP.UTF-8',
      LANGUAGE: 'ja',
      TZ: 'Asia/Tokyo',
      LC_ALL: 'C.UTF-8',
      HOME: '/home/user',
      XDG_RUNTIME_DIR: '/run/user/1000',
      OPENAI_API_KEY: 'sk-not-written',
      ARAYA_TEST_TOKEN: 'not-written-token',
      ARAYA_DATA_DIR: 'relative-data',
      ARAYA_DEV_ROOT: 'relative-dev',
      ARAYA_CODING_AGENT_DIR: 'relative-agent',
      'ARAYA_BAD-NAME': 'x',
      ARAYA_UNSET: undefined,
    },
    { dataDir: '/abs/data', devRoot: '/abs/dev', piAgentDir: '/abs/agent' },
  )

  assert.deepEqual(environment, [
    ['ARAYA_CODING_AGENT_DIR', '/abs/agent'],
    ['ARAYA_DATA_DIR', '/abs/data'],
    ['ARAYA_DEV_ROOT', '/abs/dev'],
    ['LANG', 'ja_JP.UTF-8'],
    ['LANGUAGE', 'ja'],
    ['LC_ALL', 'C.UTF-8'],
    ['PATH', '/usr/bin:/bin'],
    ['TZ', 'Asia/Tokyo'],
  ])
  assert.deepEqual(
    selectUnitEnvironment({}, { dataDir: '/d', devRoot: '/v', piAgentDir: '/d/pi' }),
    [
      ['ARAYA_CODING_AGENT_DIR', '/d/pi'],
      ['ARAYA_DATA_DIR', '/d'],
      ['ARAYA_DEV_ROOT', '/v'],
    ],
  )
})

test('systemd-units: Discord 1Password launcher は package root の bin/ から通常の file として探す', async () => {
  const root = await makeRoot('araya-discord-op-entrypoint-test-')

  try {
    await fs.mkdir(path.join(root, 'src', 'infrastructure'), { recursive: true })
    await fs.mkdir(path.join(root, 'bin'))
    const tsModule = pathToFileURL(path.join(root, 'src', 'infrastructure', 'systemd.ts')).href
    const jsModule = pathToFileURL(path.join(root, 'src', 'infrastructure', 'systemd.js')).href

    await assert.rejects(
      resolveDiscordOpRunnerEntrypoint(tsModule),
      errorWithCode('discord_op_runner_unavailable'),
    )

    const tsEntrypoint = path.join(root, 'bin', 'discord-op-runner.ts')
    await fs.writeFile(tsEntrypoint, '', 'utf8')
    assert.equal(await resolveDiscordOpRunnerEntrypoint(tsModule), tsEntrypoint)
    await assert.rejects(
      resolveDiscordOpRunnerEntrypoint(jsModule),
      errorWithCode('discord_op_runner_unavailable'),
    )

    const jsEntrypoint = path.join(root, 'bin', 'discord-op-runner.js')
    await fs.symlink(tsEntrypoint, jsEntrypoint)
    await assert.rejects(
      resolveDiscordOpRunnerEntrypoint(jsModule),
      errorWithCode('discord_op_runner_unavailable'),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('systemd-units: Discord env-file launcher は package root の bin/ から通常の file として探す', async () => {
  const root = await makeRoot('araya-discord-env-entrypoint-test-')

  try {
    await fs.mkdir(path.join(root, 'src', 'infrastructure'), { recursive: true })
    await fs.mkdir(path.join(root, 'bin'))
    const tsModule = pathToFileURL(path.join(root, 'src', 'infrastructure', 'systemd.ts')).href
    const jsModule = pathToFileURL(path.join(root, 'src', 'infrastructure', 'systemd.js')).href

    await assert.rejects(
      resolveDiscordEnvRunnerEntrypoint(tsModule),
      errorWithCode('discord_env_runner_unavailable'),
    )

    const tsEntrypoint = path.join(root, 'bin', 'discord-env-runner.ts')
    await fs.writeFile(tsEntrypoint, '', 'utf8')
    assert.equal(await resolveDiscordEnvRunnerEntrypoint(tsModule), tsEntrypoint)
    await assert.rejects(
      resolveDiscordEnvRunnerEntrypoint(jsModule),
      errorWithCode('discord_env_runner_unavailable'),
    )

    await fs.symlink(tsEntrypoint, path.join(root, 'bin', 'discord-env-runner.js'))
    await assert.rejects(
      resolveDiscordEnvRunnerEntrypoint(jsModule),
      errorWithCode('discord_env_runner_unavailable'),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('systemd-units: Discord service unit は標準 .env と任意1Password modeを分離する', () => {
  const dataDir = '/home/user/.araya'
  const botEntrypoint = '/opt/araya/packages/araya/bin/discord-env-runner.js'
  const environment = [
    ['ARAYA_DATA_DIR', dataDir],
    ['PATH', '/usr/bin:/bin'],
  ] as const
  const plain = buildDiscordUnitFile({
    authMode: 'env-file',
    dataDir,
    nodePath: '/usr/bin/node',
    botEntrypoint,
    envFilePath: `${dataDir}/.env`,
    environment: [...environment],
  })

  assert.ok(plain.includes(`ExecStart=/usr/bin/node ${botEntrypoint} --data-dir ${dataDir}`), plain)
  assert.ok(plain.includes(`LoadCredential=discord-env:${dataDir}/.env`), plain)
  assert.ok(!plain.includes('op-service-account-token'), plain)
  assert.ok(!plain.includes('OP_SERVICE_ACCOUNT_TOKEN'), plain)
  assert.ok(!plain.includes('Environment=ARAYA_DISCORD_'), plain)

  const op = buildDiscordUnitFile({
    authMode: '1password',
    dataDir,
    nodePath: '/usr/bin/node',
    botEntrypoint: '/opt/araya/packages/araya/bin/discord-op-runner.js',
    opPath: '/usr/bin/op',
    opCredentialFile: '/home/user/.araya/op-service-account-token.cred',
    environment: [...environment],
  })

  assert.ok(
    op.includes(
      `ExecStart=/usr/bin/node /opt/araya/packages/araya/bin/discord-op-runner.js --data-dir ${dataDir} --op-path /usr/bin/op`,
    ),
    op,
  )
  assert.ok(
    op.includes(
      'LoadCredentialEncrypted=op-service-account-token:/home/user/.araya/op-service-account-token.cred',
    ),
    op,
  )
  assert.ok(!op.includes('OP_SERVICE_ACCOUNT_TOKEN'), op)

  assert.throws(() => {
    return buildDiscordUnitFile({
      authMode: 'env-file',
      dataDir,
      nodePath: '/usr/bin/node',
      botEntrypoint,
      envFilePath: '/home/user/.env:backup',
      environment: [...environment],
    })
  }, errorWithCode('unsupported_path'))
})

test('systemd-units: 1Password credential は ~/.araya に置き、旧 XDG config path を移行用に特定する', async () => {
  const root = await makeRoot('araya-op-path-test-')
  const binDir = path.join(root, 'bin')

  try {
    await fs.mkdir(binDir)
    const opPath = path.join(binDir, 'op')
    await fs.writeFile(opPath, '', { mode: 0o700 })

    assert.equal(await resolveOpCliPath(binDir), opPath)
    await assert.rejects(
      resolveOpCliPath(path.join(root, 'missing')),
      errorWithCode('op_cli_unavailable'),
    )
    assert.equal(
      discordOpServiceAccountTokenFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/user'),
      '/home/user/.araya/op-service-account-token.cred',
    )
    assert.equal(
      legacyDiscordOpServiceAccountTokenFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/user'),
      '/tmp/xdg/araya/op-service-account-token',
    )
    assert.equal(
      discordOpServiceAccountTokenFilePath({ XDG_CONFIG_HOME: 'relative' }, '/home/user'),
      '/home/user/.araya/op-service-account-token.cred',
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('systemd-units: systemd-creds --user encrypt はcredentialをstdinで渡し、tokenを子process環境から除く', async () => {
  const plaintext = 'synthetic-service-account-token'
  const ciphertext = 'Y2lwaGVydGV4dA==\n'
  const calls: {
    command: string
    args: readonly string[]
    options: import('./process.ts').BoundedCommandOptions
  }[] = []
  const result = await encryptSystemdCredential(plaintext, 'op-service-account-token', {
    resolveExecutable: async () => {
      return '/usr/bin/systemd-creds-fixture'
    },
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      return {
        exitCode: 0,
        signal: null,
        stdout: ciphertext,
        stderr: '',
        stdoutBytes: Buffer.byteLength(ciphertext),
        stderrBytes: 0,
        terminationReason: undefined,
        terminationConfirmed: true,
      }
    },
  })

  assert.equal(result, ciphertext)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, '/usr/bin/systemd-creds-fixture')
  assert.deepEqual(calls[0]?.args, [
    '--user',
    '--name=op-service-account-token',
    '--with-key=auto',
    'encrypt',
    '-',
    '-',
  ])
  assert.equal(calls[0]?.options.input, plaintext)
  assert.deepEqual(calls[0]?.options.env, {})
})

test('systemd-units: unit file の path は XDG_CONFIG_HOME が絶対 path のときだけ使い、それ以外は ~/.config', () => {
  const unit = 'araya-discord-0123456789ab.service'

  assert.equal(
    unitFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/user', unit),
    `/tmp/xdg/systemd/user/${unit}`,
  )
  assert.equal(
    unitFilePath({ XDG_CONFIG_HOME: 'relative' }, '/home/user', unit),
    `/home/user/.config/systemd/user/${unit}`,
  )
  assert.equal(unitFilePath({}, '/home/user', unit), `/home/user/.config/systemd/user/${unit}`)
})

// PATH に置く偽の systemctl。呼ばれた引数を1行の JSON で記録し、file に書いた応答（stdout・stderr・終了 code）を返す
async function makeFakeSystemctlBin(root: string) {
  const binDir = path.join(root, 'bin')
  const log = path.join(root, 'calls.log')
  const responses = path.join(root, 'responses')
  await fs.mkdir(binDir)
  await fs.mkdir(responses)
  const record = `${shellQuote(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${shellQuote(log)} "$0" "$@"`
  await fs.writeFile(
    path.join(binDir, 'systemctl'),
    [
      '#!/bin/sh',
      'PATH=/usr/bin:/bin',
      record,
      `if [ -f ${shellQuote(responses)}/"$2".out ]; then cat ${shellQuote(responses)}/"$2".out; fi`,
      `if [ -f ${shellQuote(responses)}/"$2".err ]; then cat ${shellQuote(responses)}/"$2".err >&2; fi`,
      `if [ -f ${shellQuote(responses)}/"$2".code ]; then exit "$(cat ${shellQuote(responses)}/"$2".code)"; fi`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  async function calls() {
    const text = await fs.readFile(log, 'utf8').catch(() => {
      return ''
    })

    return text
      .split('\n')
      .filter((line) => {
        return line !== ''
      })
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        assert.ok(Array.isArray(parsed))

        return parsed.map(String)
      })
  }

  return { binDir, responses, log, calls }
}

test('systemd-units: 本物の SystemdOps は PATH から探した systemctl を absolute path で起動し、loginctl が無ければ失敗の結果を返す', async () => {
  const root = await makeRoot('araya-systemd-ops-test-')
  const fake = await makeFakeSystemctlBin(root)

  try {
    const ops = await createSystemdOps({ PATH: fake.binDir })

    const shown = await ops.systemctl(['--user', 'show', 'unit'], 10_000)
    assert.equal(shown.exitCode, 0)
    const recorded = await fake.calls()
    assert.deepEqual(
      recorded.map((entry) => entry.slice(1)),
      [['--user', 'show', 'unit']],
    )
    assert.equal(recorded[0]?.[0], path.join(fake.binDir, 'systemctl'))

    // loginctl は PATH に無いとき、起動せずに失敗の結果だけを返す
    const linger = await ops.loginctl(['show-user', '1000', '--property=Linger', '--value'], 10_000)
    assert.equal(linger.exitCode, null)

    await assert.rejects(
      createSystemdOps({ PATH: path.join(root, 'missing') }),
      errorWithCode('systemd_unavailable'),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('systemd-units: systemctl の出力が上限を超えて先頭を切ったときだけ、先頭の境界の秘密の値と userinfo を置き換える', async () => {
  const root = await makeRoot('araya-systemd-ops-test-')
  const fake = await makeFakeSystemctlBin(root)
  const secret = 'Zq8kW3mX9pL2vN7r'
  // systemctl の stdout と stderr は末尾の 64 KiB だけを残す
  const outputBytes = 64 * 1024
  // 空白の無い長い英数字の並びは URL の userinfo の置き換えが遅くなるので、詰め物は短い行にする
  function fill(length: number) {
    return 'filler line\n'.repeat(Math.ceil(length / 12)).slice(0, length)
  }

  const stdoutPadding = fill(outputBytes - (secret.length - 6))
  const stderrKept = 'er:pass@example.invalid/repo.git '
  const stderrPadding = fill(outputBytes - stderrKept.length)

  try {
    const ops = await createSystemdOps({ PATH: fake.binDir, ARAYA_TEST_TOKEN: secret })
    await fs.writeFile(path.join(fake.responses, 'show.out'), `${secret}${stdoutPadding}`, 'utf8')
    await fs.writeFile(
      path.join(fake.responses, 'show.err'),
      `clone https://us${stderrKept}${stderrPadding}`,
      'utf8',
    )
    await fs.writeFile(path.join(fake.responses, 'show.code'), '1', 'utf8')
    const cut = await ops.systemctl(['--user', 'show', 'unit'], 10_000)

    assert.equal(cut.stdout.startsWith('[REDACTED]filler'), true, cut.stdout.slice(0, 40))
    assert.equal(cut.stdout.length, '[REDACTED]'.length + stdoutPadding.length)
    assert.equal(
      cut.stderr.startsWith('[REDACTED]@example.invalid/repo.git filler'),
      true,
      cut.stderr.slice(0, 60),
    )
    assert.equal(
      cut.stderr.length,
      '[REDACTED]@example.invalid/repo.git '.length + stderrPadding.length,
    )

    // 上限以内なら、先頭が秘密の値の末尾の部分や userinfo の途中でも置き換えない
    await fs.writeFile(path.join(fake.responses, 'status.out'), `${secret.slice(6)} ok`, 'utf8')
    await fs.writeFile(path.join(fake.responses, 'status.err'), stderrKept, 'utf8')
    const whole = await ops.systemctl(['--user', 'status', 'unit'], 10_000)
    assert.equal(whole.stdout, `${secret.slice(6)} ok`)
    assert.equal(whole.stderr, stderrKept)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
