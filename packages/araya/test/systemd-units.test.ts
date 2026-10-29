import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { collectDevelopmentResult } from '../src/development/result.ts'
import { createTaskState, createWorktreeService } from '../src/development/worktrees.ts'
import {
  bashScopeUnit,
  buildRunnerUnitFile,
  createScopedRunner,
  createScopedVerificationRunner,
  createSystemdOps,
  dataDirHash,
  deliveryScopeUnit,
  gitScopeUnit,
  isUnitFileValueSafe,
  resolveRunnerEntrypoint,
  runnerUnitName,
  scopePattern,
  selectUnitEnvironment,
  shellQuote,
  unitFilePath,
  verifyScopeUnit
} from '../src/infrastructure/systemd.ts'
import { createFakeSystemd, findMarkedProcesses } from './support/fake-systemd.ts'

const TASK_KEY = 'task-7-2-abcdef'

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

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('systemd-units: unit と scope の名前は dataDir の実 path の hash と taskKey から作る', () => {
  const hash = dataDirHash('/home/user/.araya')

  assert.equal(hash, createHash('sha256').update('/home/user/.araya', 'utf8').digest('hex').slice(0, 12))
  assert.equal(runnerUnitName(hash), `araya-runner-${hash}.service`)
  assert.equal(scopePattern(hash), `araya-${hash}-*.scope`)
  assert.equal(scopePattern(hash, TASK_KEY), `araya-${hash}-${TASK_KEY}-*.scope`)
  assert.equal(
    bashScopeUnit(hash, TASK_KEY, 'call-1'),
    `araya-${hash}-${TASK_KEY}-${createHash('sha256').update('call-1', 'utf8').digest('hex').slice(0, 12)}.scope`
  )
  assert.equal(verifyScopeUnit(hash, TASK_KEY, 3), `araya-${hash}-${TASK_KEY}-verify-3.scope`)
  // 0〜31 と 32〜63 は同じ文字になる（a-z2-7 の 32 文字）
  assert.equal(
    gitScopeUnit(hash, TASK_KEY, (size) => Uint8Array.from({ length: size }, (_value, index) => index * 3)),
    `araya-${hash}-${TASK_KEY}-git-adgjmpsvy36b.scope`
  )
  assert.match(gitScopeUnit(hash, TASK_KEY), new RegExp(`^araya-${hash}-${TASK_KEY}-git-[a-z2-7]{12}\\.scope$`, 'u'))
  assert.notEqual(gitScopeUnit(hash, TASK_KEY), gitScopeUnit(hash, TASK_KEY))
  assert.ok(deliveryScopeUnit(hash, TASK_KEY).startsWith(`araya-${hash}-${TASK_KEY}-delivery-`))
  assert.ok(deliveryScopeUnit(hash, TASK_KEY).endsWith('.scope'))
  assert.notEqual(deliveryScopeUnit(hash, TASK_KEY), deliveryScopeUnit(hash, TASK_KEY))
})

test('systemd-units: shellQuote は単引用符で囲み、bash で元の文字列に戻る', () => {
  const text = `it's $HOME \${PATH} "quoted" \\ \`date\` ;`

  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.equal(execFileSync('/bin/bash', ['-c', `printf '%s' ${shellQuote(text)}`], { encoding: 'utf8' }), text)
})

test('systemd-units: unit file に書けない文字を判定する', () => {
  assert.equal(isUnitFileValueSafe('/home/user/.araya'), true)
  assert.equal(isUnitFileValueSafe('/usr/bin:/bin'), true)
  assert.equal(isUnitFileValueSafe('ja_JP.UTF-8'), true)

  for (const value of ['/a b', '/a"b', "/a'b", '/a\\b', '/a$b', '/a%b', '/a;b', '/a\tb', '/a\nb', '/a\u0000b', '/a\u007fb']) {
    assert.equal(isUnitFileValueSafe(value), false, JSON.stringify(value))
  }
})

test('systemd-units: Environment= には一覧の変数だけを選び、秘密とみなす名前を除き、解決済みの path を書く', () => {
  const environment = selectUnitEnvironment({
    PATH: '/usr/bin:/bin',
    LANG: 'ja_JP.UTF-8',
    LANGUAGE: 'ja',
    TZ: 'Asia/Tokyo',
    LC_ALL: 'C.UTF-8',
    HOME: '/home/user',
    XDG_RUNTIME_DIR: '/run/user/1000',
    OPENAI_API_KEY: 'sk-not-written',
    ARAYA_TEST_TOKEN: 'not-written-token',
    ARAYA_INTERVAL_MS: '60000',
    ARAYA_DATA_DIR: 'relative-data',
    ARAYA_DEV_ROOT: 'relative-dev',
    PI_CODING_AGENT_DIR: 'relative-agent',
    'ARAYA_BAD-NAME': 'x',
    ARAYA_UNSET: undefined
  }, { dataDir: '/abs/data', devRoot: '/abs/dev', piAgentDir: '/abs/agent' })

  assert.deepEqual(environment, [
    ['ARAYA_DATA_DIR', '/abs/data'],
    ['ARAYA_DEV_ROOT', '/abs/dev'],
    ['ARAYA_INTERVAL_MS', '60000'],
    ['LANG', 'ja_JP.UTF-8'],
    ['LANGUAGE', 'ja'],
    ['LC_ALL', 'C.UTF-8'],
    ['PATH', '/usr/bin:/bin'],
    ['PI_CODING_AGENT_DIR', '/abs/agent'],
    ['TZ', 'Asia/Tokyo']
  ])
  assert.deepEqual(selectUnitEnvironment({}, { dataDir: '/d', devRoot: '/v', piAgentDir: undefined }), [
    ['ARAYA_DATA_DIR', '/d'],
    ['ARAYA_DEV_ROOT', '/v']
  ])
})

test('systemd-units: unit file は仕様の property を書き、書けない値があれば unsupported_path', () => {
  const dataDir = '/home/user/.araya'
  const hash = dataDirHash(dataDir)
  const input = {
    dataDir,
    nodePath: '/usr/bin/node',
    entrypoint: '/opt/araya/packages/araya/bin/task-runner.ts',
    systemctlPath: '/usr/bin/systemctl',
    environment: [['ARAYA_DATA_DIR', dataDir], ['PATH', '/usr/bin:/bin']] as const
  }

  assert.equal(buildRunnerUnitFile({ ...input, environment: [...input.environment] }), [
    '[Unit]',
    `Description=araya runner ${dataDir}`,
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=/usr/bin/node /opt/araya/packages/araya/bin/task-runner.ts --data-dir ${dataDir}`,
    `ExecStopPost=-/usr/bin/systemctl --user stop araya-${hash}-*.scope`,
    `WorkingDirectory=${dataDir}`,
    `Environment=ARAYA_DATA_DIR=${dataDir}`,
    'Environment=PATH=/usr/bin:/bin',
    'KillMode=control-group',
    'Restart=always',
    'RestartSec=1s',
    'RestartSteps=5',
    'RestartMaxDelaySec=1min',
    'TimeoutStopSec=60',
    'StandardInput=null',
    'StandardOutput=null',
    'StandardError=null',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n'))

  const unsafe = [
    { dataDir: '/home/user/my data' },
    { nodePath: '/opt/node$1/bin/node' },
    { entrypoint: '/opt/100%/task-runner.ts' },
    { systemctlPath: '/usr/bin/system;ctl' },
    { environment: [['LANG', 'a b']] as const },
    { environment: [['BAD-NAME', 'x']] as const }
  ]

  for (const override of unsafe) {
    assert.throws(() => {
      const { environment, ...rest } = { ...input, ...override }

      return buildRunnerUnitFile({ ...rest, environment: [...environment] })
    }, errorWithCode('unsupported_path'), JSON.stringify(override))
  }
})

test('systemd-units: runner の entrypoint は package root の bin/ から、module と同じ拡張子の通常の file を探す', async () => {
  const root = await makeRoot('araya-entrypoint-test-')

  try {
    await fs.mkdir(path.join(root, 'src', 'infrastructure'), { recursive: true })
    await fs.mkdir(path.join(root, 'bin'))
    const tsModule = pathToFileURL(path.join(root, 'src', 'infrastructure', 'systemd.ts')).href
    const jsModule = pathToFileURL(path.join(root, 'src', 'infrastructure', 'systemd.js')).href

    await assert.rejects(resolveRunnerEntrypoint(tsModule), errorWithCode('runner_entrypoint_unavailable'))

    await fs.writeFile(path.join(root, 'bin', 'task-runner.ts'), '', 'utf8')
    assert.equal(await resolveRunnerEntrypoint(tsModule), path.join(root, 'bin', 'task-runner.ts'))
    await assert.rejects(resolveRunnerEntrypoint(jsModule), errorWithCode('runner_entrypoint_unavailable'))

    // 通常の file でなければ使わない
    await fs.mkdir(path.join(root, 'bin', 'task-runner.js'))
    await assert.rejects(resolveRunnerEntrypoint(jsModule), errorWithCode('runner_entrypoint_unavailable'))
    await fs.rmdir(path.join(root, 'bin', 'task-runner.js'))
    await fs.symlink(path.join(root, 'bin', 'task-runner.ts'), path.join(root, 'bin', 'task-runner.js'))
    await assert.rejects(resolveRunnerEntrypoint(jsModule), errorWithCode('runner_entrypoint_unavailable'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('systemd-units: source の default entrypoint は同じ package の bin/task-runner.ts', async () => {
  const expected = fileURLToPath(new URL('../bin/task-runner.ts', import.meta.url))

  assert.equal(await resolveRunnerEntrypoint(), expected)
  assert.equal((await fs.lstat(expected)).isFile(), true)
})

test('systemd-units: unit file の path は XDG_CONFIG_HOME が絶対 path のときだけ使い、それ以外は ~/.config', () => {
  const unit = 'araya-runner-0123456789ab.service'

  assert.equal(unitFilePath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/user', unit), `/tmp/xdg/systemd/user/${unit}`)
  assert.equal(unitFilePath({ XDG_CONFIG_HOME: 'relative' }, '/home/user', unit), `/home/user/.config/systemd/user/${unit}`)
  assert.equal(unitFilePath({}, '/home/user', unit), `/home/user/.config/systemd/user/${unit}`)
})

// PATH に置く偽の systemd-run・systemctl。呼ばれた引数を1行の JSON で記録する。
// systemd-run は -- の後の command を実行し、systemctl は file に書いた応答（stdout・stderr・終了 code）を返す
async function makeFakeSystemdBin(root: string) {
  const binDir = path.join(root, 'bin')
  const log = path.join(root, 'calls.log')
  const responses = path.join(root, 'responses')
  await fs.mkdir(binDir)
  await fs.mkdir(responses)
  const record = `${shellQuote(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' ${shellQuote(log)} "$(basename "$0")" "$@"`
  await fs.writeFile(path.join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'PATH=/usr/bin:/bin',
    record,
    'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
    'shift',
    'exec "$@"',
    ''
  ].join('\n'), { mode: 0o755 })
  await fs.writeFile(path.join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'PATH=/usr/bin:/bin',
    record,
    `if [ -f ${shellQuote(responses)}/"$2".out ]; then cat ${shellQuote(responses)}/"$2".out; fi`,
    `if [ -f ${shellQuote(responses)}/"$2".err ]; then cat ${shellQuote(responses)}/"$2".err >&2; fi`,
    `if [ -f ${shellQuote(responses)}/"$2".code ]; then exit "$(cat ${shellQuote(responses)}/"$2".code)"; fi`,
    'exit 0',
    ''
  ].join('\n'), { mode: 0o755 })
  await fs.symlink('/bin/bash', path.join(binDir, 'bash'))

  async function calls() {
    const text = await fs.readFile(log, 'utf8').catch(() => {
      return ''
    })

    return text.split('\n').filter((line) => {
      return line !== ''
    }).map((line) => {
      const parsed: unknown = JSON.parse(line)
      assert.ok(Array.isArray(parsed))

      return parsed.map(String)
    })
  }

  return { binDir, responses, log, calls }
}

test('systemd-units: 本物の SystemdOps は PATH から探した systemd-run の scope で起動し、stop の後に list-units で残りを確かめる', async () => {
  const root = await makeRoot('araya-systemd-ops-test-')
  const fake = await makeFakeSystemdBin(root)
  const env = { PATH: fake.binDir, ARAYA_OPS_TEST: 'value with $HOME' }

  try {
    const ops = await createSystemdOps(env)
    const unit = `araya-${dataDirHash(root)}-${TASK_KEY}-git-abcdefghijkl.scope`
    const scopeArgs = ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no', `--unit=${unit}`, '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=10s', '--']
    assert.equal(ops.systemctlPath, path.join(fake.binDir, 'systemctl'))

    const launched = await createScopedRunner(ops, () => unit)('/bin/sh', ['-c', 'printf %s "$ARAYA_OPS_TEST"'], { env, timeoutMs: 10_000 })
    assert.equal(launched.exitCode, 0)
    assert.equal(launched.stdout, 'value with $HOME')

    // bash の prepare が使う command は、$ を含む元の command をそのまま bash に渡す
    const bashCommand = ops.bashScopeCommand(unit, "printf '%s|' \"$ARAYA_OPS_TEST\" '$HOME'")
    assert.equal(execFileSync('/bin/sh', ['-c', bashCommand], { env, encoding: 'utf8' }), 'value with $HOME|$HOME|')
    assert.deepEqual(await fake.calls(), [
      ['systemd-run', ...scopeArgs, '/bin/sh', '-c', 'printf %s "$ARAYA_OPS_TEST"'],
      ['systemd-run', ...scopeArgs, path.join(fake.binDir, 'bash'), '-c', "printf '%s|' \"$ARAYA_OPS_TEST\" '$HOME'"]
    ])
    await fs.rm(fake.log)

    const pattern = scopePattern(dataDirHash(root))
    assert.deepEqual(await ops.stopScopes(pattern), { ok: true })
    assert.deepEqual(await fake.calls(), [
      ['systemctl', '--user', 'stop', pattern],
      ['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', pattern]
    ])

    // 残っていれば止められなかった
    await fs.writeFile(path.join(fake.responses, 'list-units.out'), `${unit} loaded active running ${unit}\n`, 'utf8')
    const remained = await ops.stopScopes(pattern)
    assert.equal(remained.ok, false)
    assert.deepEqual(remained.ok ? [] : remained.remaining, [unit])

    // stop が失敗すれば、list-units が空でも止められなかった
    await fs.rm(path.join(fake.responses, 'list-units.out'))
    await fs.writeFile(path.join(fake.responses, 'stop.code'), '1', 'utf8')
    await fs.rm(fake.log)
    const stopFailed = await ops.stopScopes(pattern)
    assert.equal(stopFailed.ok, false)
    assert.equal((await fake.calls()).length, 1)

    // 名前を1つだけ指定した stop が、unit が読み込まれていない（--collect で消えた）ために失敗したときは、list-units で確かめる
    await fs.writeFile(path.join(fake.responses, 'stop.code'), '5', 'utf8')
    await fs.writeFile(path.join(fake.responses, 'stop.err'), `Failed to stop ${unit}: Unit ${unit} not loaded.\n`, 'utf8')
    await fs.rm(fake.log)
    assert.deepEqual(await ops.stopScopes(unit), { ok: true })
    assert.deepEqual(await fake.calls(), [
      ['systemctl', '--user', 'stop', unit],
      ['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', unit]
    ])
    await fs.writeFile(path.join(fake.responses, 'list-units.out'), `${unit} loaded active running ${unit}\n`, 'utf8')
    assert.equal((await ops.stopScopes(unit)).ok, false)
    await fs.rm(path.join(fake.responses, 'list-units.out'))
    await fs.rm(path.join(fake.responses, 'stop.err'))

    // list-units が失敗しても止められなかった
    await fs.rm(path.join(fake.responses, 'stop.code'))
    await fs.writeFile(path.join(fake.responses, 'list-units.code'), '1', 'utf8')
    assert.equal((await ops.stopScopes(pattern)).ok, false)

    // loginctl が無ければ失敗の結果を返す
    const linger = await ops.loginctl(['show-user', '1000', '--property=Linger', '--value'], 10_000)
    assert.equal(linger.exitCode, null)

    await assert.rejects(createSystemdOps({ PATH: path.join(root, 'missing') }), errorWithCode('systemd_unavailable'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('systemd-units: systemctl の出力が上限を超えて先頭を切ったときだけ、先頭の境界の秘密の値と userinfo を置き換える', async () => {
  const root = await makeRoot('araya-systemd-ops-test-')
  const fake = await makeFakeSystemdBin(root)
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
    await fs.writeFile(path.join(fake.responses, 'show.err'), `clone https://us${stderrKept}${stderrPadding}`, 'utf8')
    await fs.writeFile(path.join(fake.responses, 'show.code'), '1', 'utf8')
    const cut = await ops.systemctl(['--user', 'show', 'unit'], 10_000)

    assert.equal(cut.stdout.startsWith('[REDACTED]filler'), true, cut.stdout.slice(0, 40))
    assert.equal(cut.stdout.length, '[REDACTED]'.length + stdoutPadding.length)
    assert.equal(cut.stderr.startsWith('[REDACTED]@example.invalid/repo.git filler'), true, cut.stderr.slice(0, 60))
    assert.equal(cut.stderr.length, '[REDACTED]@example.invalid/repo.git '.length + stderrPadding.length)

    // stop の失敗の誤りにも、境界の一部が残らない
    await fs.writeFile(path.join(fake.responses, 'stop.err'), `clone https://us${stderrKept}${stderrPadding}`, 'utf8')
    await fs.writeFile(path.join(fake.responses, 'stop.code'), '1', 'utf8')
    const stopped = await ops.stopScopes(scopePattern(dataDirHash(root)))
    const stopError = stopped.ok ? '' : stopped.error
    assert.equal(stopped.ok, false)
    assert.equal(stopError.includes('er:pass'), false)
    assert.ok(stopError.includes('[REDACTED]@example.invalid'), stopError.slice(0, 80))

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

test('偽物の systemd: stopScopes は印が pattern に当たる process を、setsid した子孫も含めて止め、ほかの dataDir の process は止めない', async () => {
  const root = await makeRoot('araya-fake-systemd-test-')
  const fake = createFakeSystemd()
  const own = scopePattern(dataDirHash(path.join(root, 'own')))
  const other = scopePattern(dataDirHash(path.join(root, 'other')))
  const ownUnit = own.replace('*', `${TASK_KEY}-git-abcdefghijkl`)
  const otherUnit = other.replace('*', `${TASK_KEY}-git-abcdefghijkl`)
  const pidFile = path.join(root, 'pids')
  const startDetached = `setsid sleep 30 > /dev/null 2>&1 < /dev/null & echo $! >> ${shellQuote(pidFile)}`

  try {
    await fake.ops.launchInScope(ownUnit, '/bin/sh', ['-c', startDetached], { timeoutMs: 10_000 })
    await fake.ops.launchInScope(otherUnit, '/bin/sh', ['-c', startDetached], { timeoutMs: 10_000 })
    const [ownPid, otherPid] = (await fs.readFile(pidFile, 'utf8')).trim().split('\n').map(Number)
    assert.ok(ownPid !== undefined && otherPid !== undefined)
    assert.deepEqual(await findMarkedProcesses(own), [ownPid])

    assert.deepEqual(await fake.ops.stopScopes(own), { ok: true })
    assert.equal(isAlive(ownPid), false)
    assert.equal(isAlive(otherPid), true)
    assert.deepEqual(fake.records().at(-1), { type: 'stop', pattern: own, killed: [ownPid] })

    // 当たる process が無い stop も成功する
    assert.deepEqual(await fake.ops.stopScopes(own), { ok: true })
  } finally {
    await fake.ops.stopScopes(own)
    await fake.ops.stopScopes(other)
    await fs.rm(root, { recursive: true, force: true })
  }
})

type ScopeFixture = Awaited<ReturnType<typeof createScopeFixture>>

async function createScopeFixture() {
  const root = await makeRoot('araya-scope-test-')
  const home = path.join(root, 'home')
  const devRoot = path.join(root, 'dev')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.writeFile(path.join(home, 'gitconfig'), '', 'utf8')
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid'
  }
  const repository = path.join(devRoot, 'repo')
  await fs.mkdir(repository)

  for (const args of [['init', '-q', '-b', 'main'], ['add', '--all'], ['commit', '-q', '--allow-empty', '-m', 'initial']]) {
    execFileSync('git', args, { cwd: repository, env, stdio: 'ignore' })
  }

  const stateDir = await createTaskState(dataDir, TASK_KEY)
  const hash = dataDirHash(dataDir)

  return { root, devRoot, dataDir, env, stateDir, hash }
}

// 試行の scope の名前で git と検証のコマンドを起動する経路（runner が渡すもの）を、偽物の systemd で組み立てる
function scopedDependencies(fixture: ScopeFixture, fake: ReturnType<typeof createFakeSystemd>) {
  return {
    runGit: createScopedRunner(fake.ops, () => {
      return gitScopeUnit(fixture.hash, TASK_KEY)
    }),
    runVerification: createScopedVerificationRunner(fake.ops, (index) => {
      return verifyScopeUnit(fixture.hash, TASK_KEY, index)
    })
  }
}

const PRINT_SCOPE = [process.execPath, '-e', 'console.log(process.env.ARAYA_FAKE_SCOPE)']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// evidence の最初の worktree の検証の結果
function firstVerifications(evidence: Record<string, unknown>) {
  const worktree = Array.isArray(evidence.worktrees) ? evidence.worktrees[0] : undefined
  assert.ok(isRecord(worktree) && Array.isArray(worktree.verifications))

  return worktree.verifications.map((verification: unknown) => {
    assert.ok(isRecord(verification))

    return verification
  })
}

test('scope: araya_create_worktree と差分の収集の git は git-<r>、検証は verify-<n> の scope 名で起動される', async () => {
  const fixture = await createScopeFixture()
  const fake = createFakeSystemd()
  const deps = scopedDependencies(fixture, fake)

  try {
    const service = createWorktreeService({ devRoot: fixture.devRoot, stateDir: fixture.stateDir, taskKey: TASK_KEY, env: fixture.env, runGit: deps.runGit })
    const worktree = await service.createWorktree({ repository: 'repo' })
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.txt'), 'feature\n', 'utf8')
    await service.registerVerification({ repository: 'repo', command: PRINT_SCOPE })
    await service.registerVerification({ repository: 'repo', command: [...PRINT_SCOPE, 'second'] })
    const createLaunches = fake.launches().length

    const result = await collectDevelopmentResult({
      taskKey: TASK_KEY,
      title: 'fixture Task',
      draftPrDelivery: false,
      devRoot: fixture.devRoot,
      stateDir: fixture.stateDir,
      agent: { status: 'completed', summary: '報告', model: { provider: 'faux', id: 'faux-1', thinkingLevel: 'medium', source: 'araya-config' } },
      env: fixture.env,
      verificationTimeoutMs: 10_000,
      redact: (text) => text,
      redactTruncated: (text) => text
    }, deps)

    assert.equal(result.status, 'completed', JSON.stringify(result.evidence))
    const gitUnit = new RegExp(`^araya-${fixture.hash}-${TASK_KEY}-git-[a-z2-7]{12}\\.scope$`, 'u')
    const launches = fake.launches()
    const gitLaunches = launches.filter((launch) => {
      return path.basename(launch.argv[0] ?? '') === 'git'
    })
    const verifyLaunches = launches.filter((launch) => {
      return launch.argv[0] === process.execPath
    })

    // git と検証のコマンドのほかは scope の中で起動していない
    assert.equal(gitLaunches.length + verifyLaunches.length, launches.length)
    // araya_create_worktree の git（hook を無効にしない）と差分の収集の git（core.hooksPath=/dev/null）の両方が scope の中
    assert.ok(createLaunches > 0)
    assert.ok(gitLaunches.slice(0, createLaunches).every((launch) => {
      return !launch.argv.includes('core.hooksPath=/dev/null')
    }))
    assert.ok(gitLaunches.slice(createLaunches).length > 0)
    assert.ok(gitLaunches.slice(createLaunches).every((launch) => {
      return launch.argv.includes('core.hooksPath=/dev/null')
    }))

    for (const launch of gitLaunches) {
      assert.match(launch.unit, gitUnit)
    }

    // git の scope の名前は起動のたびに違う
    assert.equal(new Set(gitLaunches.map((launch) => launch.unit)).size, gitLaunches.length)
    assert.deepEqual(verifyLaunches.map((launch) => [launch.unit, launch.argv]), [
      [verifyScopeUnit(fixture.hash, TASK_KEY, 0), PRINT_SCOPE],
      [verifyScopeUnit(fixture.hash, TASK_KEY, 1), [...PRINT_SCOPE, 'second']]
    ])

    // 検証のコマンドは、その scope の中で動き、終わったら scope を止める
    assert.deepEqual(firstVerifications(result.evidence).map((verification) => {
      return verification.stdout
    }), [`${verifyScopeUnit(fixture.hash, TASK_KEY, 0)}\n`, `${verifyScopeUnit(fixture.hash, TASK_KEY, 1)}\n`])
    assert.deepEqual(fake.records().flatMap((entry) => {
      return entry.type === 'stop' ? [entry.pattern] : []
    }), [verifyScopeUnit(fixture.hash, TASK_KEY, 0), verifyScopeUnit(fixture.hash, TASK_KEY, 1)])
  } finally {
    await fake.ops.stopScopes(scopePattern(fixture.hash))
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('scope: 検証の後に scope を止めるので、検証が setsid で切り離した process も残らない', async () => {
  const fixture = await createScopeFixture()
  const fake = createFakeSystemd()
  const deps = scopedDependencies(fixture, fake)
  const pidFile = path.join(fixture.root, 'detached.pid')

  try {
    const result = await deps.runVerification({
      command: ['/bin/sh', '-c', `setsid sleep 30 > /dev/null 2>&1 < /dev/null & echo $! > ${shellQuote(pidFile)}`],
      cwd: fixture.root,
      env: fixture.env,
      timeoutMs: 10_000,
      index: 0
    })
    const pid = Number(await fs.readFile(pidFile, 'utf8'))

    assert.equal(result.status, 'passed')
    assert.equal(result.terminationConfirmed, true)
    assert.equal(isAlive(pid), false)
    assert.deepEqual(await findMarkedProcesses(scopePattern(fixture.hash)), [])
  } finally {
    await fake.ops.stopScopes(scopePattern(fixture.hash))
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('scope: 検証の scope を止められなければ termination_unconfirmed で、残りの検証を実行しない', async () => {
  const fixture = await createScopeFixture()
  const firstVerify = verifyScopeUnit(fixture.hash, TASK_KEY, 0)
  const fake = createFakeSystemd({
    failStop: (pattern) => {
      return pattern === firstVerify
    }
  })
  const deps = scopedDependencies(fixture, fake)

  try {
    const service = createWorktreeService({ devRoot: fixture.devRoot, stateDir: fixture.stateDir, taskKey: TASK_KEY, env: fixture.env, runGit: deps.runGit })
    const worktree = await service.createWorktree({ repository: 'repo' })
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.txt'), 'feature\n', 'utf8')
    await service.registerVerification({ repository: 'repo', command: PRINT_SCOPE })
    await service.registerVerification({ repository: 'repo', command: [...PRINT_SCOPE, 'second'] })

    const result = await collectDevelopmentResult({
      taskKey: TASK_KEY,
      title: 'fixture Task',
      draftPrDelivery: false,
      devRoot: fixture.devRoot,
      stateDir: fixture.stateDir,
      agent: { status: 'completed', summary: '報告', model: { provider: 'faux', id: 'faux-1', thinkingLevel: 'medium', source: 'araya-config' } },
      env: fixture.env,
      verificationTimeoutMs: 10_000,
      redact: (text) => text,
      redactTruncated: (text) => text
    }, deps)

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'termination_unconfirmed')
    assert.deepEqual(firstVerifications(result.evidence).map((verification) => [verification.status, verification.reason]), [
      ['passed', 'termination_unconfirmed'],
      ['not_run', 'previous_termination_unconfirmed']
    ])
    assert.equal(fake.launches().filter((launch) => launch.argv[0] === process.execPath).length, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
