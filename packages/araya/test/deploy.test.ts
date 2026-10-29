import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { shellQuote } from '../src/infrastructure/systemd.ts'

// scripts/deploy.sh（npm run deploy）の test。npm と、npm が入れる araya を偽物にする。本物の npm を使う test と、
// 本物の araya の CLI を使う test もある。どの test も、利用者の prefix・dataDir・systemd には触れない

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const DEPLOY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'deploy.sh')
const CLI_PATH = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))
// npm 11 の npm run が PATH に足す node-gyp-bin の場所（「技術調査結果」）
const NODE_GYP_BIN = '/usr/local/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin'

// 偽物の npm。呼ばれ方を記録し、pack では tarball を、install では DEPLOY_TEST_ARAYA を <prefix>/bin/araya に置く
const FAKE_NPM = `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\n' npm "$*" "$0" "$PATH" >> "$DEPLOY_TEST_LOG"
command=$1
destination=''
prefix=''
while [ "$#" -gt 0 ]; do
  case $1 in
    --pack-destination) destination=$2; shift ;;
    --prefix) prefix=$2; shift ;;
  esac
  shift
done
case $command in
  pack)
    : > "$destination/araya-0.0.1.tgz"
    ;;
  install)
    if [ "\${DEPLOY_TEST_NPM_INSTALL:-}" = 'fail' ]; then
      echo 'npm error: install failed' >&2
      exit 1
    fi
    mkdir -p "$prefix/bin"
    cp "$DEPLOY_TEST_ARAYA" "$prefix/bin/araya"
    chmod 755 "$prefix/bin/araya"
    ;;
esac
`

// 偽物の araya。呼ばれ方を記録し、DEPLOY_TEST_ARAYA_RESULT の結果で終わる（ok 以外は、その値を誤りの code にして stderr に出し、
// DEPLOY_TEST_ARAYA_EXIT の終了 code（無ければ 1）で終わる）
const FAKE_ARAYA = `#!/bin/sh
printf '%s\\t%s\\t%s\\t%s\\n' araya "$*" "$0" "$PATH" >> "$DEPLOY_TEST_LOG"
result=\${DEPLOY_TEST_ARAYA_RESULT:-ok}
if [ "$result" = 'ok' ]; then
  echo '{"unit":"araya-runner-test.service"}'
  echo 'logout すると runner が止まります（test）' >&2
  exit 0
fi
echo "$result: test の失敗" >&2
exit \${DEPLOY_TEST_ARAYA_EXIT:-1}
`

type Call = { command: string; args: string; self: string; path: string }

type DeployFixture = Awaited<ReturnType<typeof makeDeployFixture>>

async function makeDeployFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-deploy-test-')))
  const binDir = path.join(root, 'bin')
  const prefix = path.join(root, 'prefix')
  const logPath = path.join(root, 'calls.log')
  const fakeAraya = path.join(root, 'fake-araya')
  await fs.mkdir(binDir)
  await fs.mkdir(path.join(root, 'home'))
  await fs.mkdir(path.join(root, 'tmp'))
  await fs.writeFile(path.join(binDir, 'npm'), FAKE_NPM, { mode: 0o755 })
  await fs.writeFile(fakeAraya, FAKE_ARAYA, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    ARAYA_INSTALL_PREFIX: prefix,
    DEPLOY_TEST_LOG: logPath,
    DEPLOY_TEST_ARAYA: fakeAraya
  }

  // 元の PATH（npm run deploy を実行した shell の PATH の代わり）。偽物の npm はここにある
  return { root, binDir, prefix, logPath, env, originalPath: [binDir, '/usr/bin', '/bin'].join(':') }
}

// npm run が PATH の先頭に足す entry。package の directory から / までの node_modules/.bin と、npm の node-gyp-bin
function npmRunEntries(packageDir: string) {
  const entries: string[] = []
  let directory = packageDir
  let parent = path.dirname(directory)
  entries.push(path.join(directory, 'node_modules', '.bin'))

  while (parent !== directory) {
    directory = parent
    parent = path.dirname(directory)
    entries.push(path.join(directory, 'node_modules', '.bin'))
  }

  return [...entries, NODE_GYP_BIN]
}

async function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout.push(chunk)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr.push(chunk)
  })
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      resolve({ code, signal })
    })
  })

  return { exit, stdout: stdout.join(''), stderr: stderr.join('') }
}

function runDeployScript(fixture: DeployFixture, pathValue: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return runProcess('/bin/sh', [DEPLOY_SCRIPT], { ...fixture.env, ...extraEnv, PATH: pathValue }, REPO_ROOT)
}

async function readCalls(logPath: string) {
  let text = ''

  try {
    text = await fs.readFile(logPath, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  return text.split('\n').filter((line) => {
    return line !== ''
  }).map((line) => {
    const [command = '', args = '', self = '', pathValue = ''] = line.split('\t')
    const call: Call = { command, args, self, path: pathValue }

    return call
  })
}

function commandsOf(calls: Call[]) {
  return calls.map((call) => {
    return `${call.command} ${call.args.split(' ')[0] ?? ''}`
  })
}

// test を動かしている npm の npm-cli.js。npm test から動かせば npm_execpath にある
async function findNpmCli() {
  const execPath = process.env.npm_execpath

  if (execPath !== undefined && execPath.endsWith('.js')) {
    return execPath
  }

  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory === '') {
      continue
    }

    try {
      const resolved = await fs.realpath(path.join(directory, 'npm'))

      if (resolved.endsWith('.js')) {
        return resolved
      }
    } catch {
      continue
    }
  }

  return null
}

test('deploy: npm install の後に、入れた araya で runner install を、npm run が足した PATH の entry を外して実行する', async () => {
  const fixture = await makeDeployFixture()

  try {
    const result = await runDeployScript(fixture, [...npmRunEntries(REPO_ROOT), fixture.originalPath].join(':'))

    assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr)
    const calls = await readCalls(fixture.logPath)
    assert.deepEqual(commandsOf(calls), ['npm pack', 'npm uninstall', 'npm install', 'araya runner'])
    const runnerInstall = calls[3]
    assert.ok(runnerInstall)
    assert.equal(runnerInstall.args, 'runner install')
    assert.equal(runnerInstall.self, path.join(fixture.prefix, 'bin', 'araya'))
    assert.equal(runnerInstall.path, fixture.originalPath)
    // runner install の stdout と stderr（linger の注意など）は、そのまま利用者に見える
    assert.match(result.stdout, /araya-runner-test\.service/u)
    assert.match(result.stderr, /logout すると runner が止まります（test）/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('deploy: npm run を入れ子で実行したときは、重ねて足された entry もすべて外し、元の PATH の node_modules/.bin は残す', async () => {
  const fixture = await makeDeployFixture()

  try {
    const originalPath = ['/home/user/project/node_modules/.bin', fixture.originalPath].join(':')
    const result = await runDeployScript(fixture, [...npmRunEntries(REPO_ROOT), ...npmRunEntries(REPO_ROOT), originalPath].join(':'))

    assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr)
    const runnerInstall = (await readCalls(fixture.logPath)).at(-1)
    assert.equal(runnerInstall?.command, 'araya')
    assert.equal(runnerInstall?.path, originalPath)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('deploy: npm run を通さずに実行したときは、PATH を変えずに runner install を実行する', async () => {
  const fixture = await makeDeployFixture()

  try {
    // node-gyp-bin が無ければ、先頭の node_modules/.bin も外さない
    const pathValue = ['/home/user/project/node_modules/.bin', fixture.originalPath].join(':')
    const result = await runDeployScript(fixture, pathValue)

    assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr)
    const runnerInstall = (await readCalls(fixture.logPath)).at(-1)
    assert.equal(runnerInstall?.command, 'araya')
    assert.equal(runnerInstall?.path, pathValue)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('deploy: runner install が終了 code 69（この環境では runner を使えない）で終わったときは、注意を出して終了 code 0 で終わる', async () => {
  for (const code of ['unsupported_platform', 'systemd_unavailable']) {
    const fixture = await makeDeployFixture()

    try {
      const result = await runDeployScript(fixture, fixture.originalPath, { DEPLOY_TEST_ARAYA_RESULT: code, DEPLOY_TEST_ARAYA_EXIT: '69' })

      assert.deepEqual(result.exit, { code: 0, signal: null }, `${code}: ${result.stderr}`)
      assert.match(result.stderr, new RegExp(`^${code}: test の失敗$`, 'mu'))
      assert.match(result.stderr, /runner を入れずに終わります/u)
      assert.doesNotMatch(result.stderr, /runner を入れられませんでした/u)
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test('deploy: runner install がほかの終了 code で終わったときは、stderr の文によらず、araya を入れたまま終了 code 1 で終わる', async () => {
  // stderr の行が systemd_unavailable などの形でも、終了 code が 69 でなければ deploy の失敗にする
  const cases = [
    { code: 'systemctl_failed', exit: '1' },
    { code: 'unsupported_path', exit: '1' },
    { code: 'systemd_unavailable', exit: '1' },
    { code: 'unsupported_platform', exit: '3' }
  ]

  for (const item of cases) {
    const fixture = await makeDeployFixture()

    try {
      const result = await runDeployScript(fixture, fixture.originalPath, { DEPLOY_TEST_ARAYA_RESULT: item.code, DEPLOY_TEST_ARAYA_EXIT: item.exit })

      assert.deepEqual(result.exit, { code: 1, signal: null }, `${item.code}: ${result.stderr}`)
      assert.match(result.stderr, new RegExp(`^${item.code}: test の失敗$`, 'mu'))
      assert.match(result.stderr, /runner を入れられませんでした/u)
      assert.doesNotMatch(result.stderr, /runner を入れずに終わります/u)
      await fs.access(path.join(fixture.prefix, 'bin', 'araya'))
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  }
})

test('deploy: npm install が失敗したときは、runner install を実行しない', async () => {
  const fixture = await makeDeployFixture()

  try {
    const result = await runDeployScript(fixture, fixture.originalPath, { DEPLOY_TEST_NPM_INSTALL: 'fail' })

    assert.notEqual(result.exit.code, 0)
    assert.deepEqual(commandsOf(await readCalls(fixture.logPath)), ['npm pack', 'npm uninstall', 'npm install'])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('deploy: 本物の npm で npm run deploy を実行しても、npm run が足した PATH の entry を外して runner install を実行する', async (t) => {
  const npmCli = await findNpmCli()

  if (npmCli === null) {
    t.skip('npm が見つかりません')
    return
  }

  const fixture = await makeDeployFixture()

  try {
    // npm run deploy を実行する package。npm run が PATH の先頭に足す node_modules/.bin に偽物の npm を置くので、deploy.sh の中の npm はその偽物になる
    const packageDir = path.join(fixture.root, 'package')
    await fs.mkdir(path.join(packageDir, 'node_modules', '.bin'), { recursive: true })
    await fs.writeFile(path.join(packageDir, 'node_modules', '.bin', 'npm'), FAKE_NPM, { mode: 0o755 })
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
      private: true,
      name: 'araya-deploy-test',
      version: '0.0.0',
      scripts: { deploy: `sh ${shellQuote(DEPLOY_SCRIPT)}` }
    }), 'utf8')
    const outerPath = '/usr/bin:/bin'
    const result = await runProcess(process.execPath, [npmCli, 'run', 'deploy'], {
      ...fixture.env,
      PATH: outerPath,
      npm_config_cache: path.join(fixture.root, 'npm-cache'),
      npm_config_update_notifier: 'false'
    }, packageDir)

    assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr)
    const calls = await readCalls(fixture.logPath)
    assert.deepEqual(commandsOf(calls), ['npm pack', 'npm uninstall', 'npm install', 'araya runner'])
    // deploy.sh の中の npm は、npm run が足した entry の付いた PATH で動いた
    const pack = calls[0]
    assert.ok(pack)
    assert.ok(pack.path.startsWith(`${path.join(packageDir, 'node_modules', '.bin')}:`), pack.path)
    assert.ok(pack.path.endsWith(`/node-gyp-bin:${outerPath}`), pack.path)
    assert.equal(calls[3]?.path, outerPath)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

// npm が入れる araya の代わりに checkout の araya の CLI を置いて、deploy.sh を実行する。
// systemctl・systemd-run・loginctl は、呼ばれたら記録して失敗する偽物（systemd の user manager に接続できない環境）。
// cliPath を指定したときは、CLI の PATH をその値にする
async function runDeployWithRealAraya(fixture: DeployFixture, cliPath: string | null) {
  const systemdDir = path.join(fixture.root, 'systemd-bin')
  const systemdLog = path.join(fixture.root, 'systemd.log')
  await fs.mkdir(systemdDir)

  for (const name of ['systemctl', 'systemd-run', 'loginctl']) {
    await fs.writeFile(path.join(systemdDir, name), `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${shellQuote(systemdLog)}\nexit 1\n`, { mode: 0o755 })
  }

  const realAraya = path.join(fixture.root, 'real-araya')
  const setPath = cliPath === null ? '' : `PATH=${shellQuote(cliPath)}\nexport PATH\n`
  await fs.writeFile(realAraya, `#!/bin/sh\n${setPath}exec ${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} "$@"\n`, { mode: 0o755 })
  const configHome = path.join(fixture.root, 'xdg-config')
  const runtimeDir = path.join(fixture.root, 'xdg-runtime')
  await fs.mkdir(runtimeDir, { mode: 0o700 })
  const result = await runProcess('/bin/sh', [DEPLOY_SCRIPT], {
    ...fixture.env,
    PATH: [systemdDir, fixture.originalPath].join(':'),
    DEPLOY_TEST_ARAYA: realAraya,
    ARAYA_DATA_DIR: path.join(fixture.root, 'data'),
    PI_CODING_AGENT_DIR: path.join(fixture.root, 'pi-agent'),
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeDir
  }, REPO_ROOT)

  return { result, systemdDir, systemdLog, configHome }
}

test('deploy: 本物の araya の CLI が、systemd の user manager に接続できずに systemd_unavailable で失敗したときも、注意を出して終了 code 0 で終わり、unit file を書かない', async () => {
  const fixture = await makeDeployFixture()

  try {
    const { result, systemdDir, systemdLog, configHome } = await runDeployWithRealAraya(fixture, null)

    assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr)
    assert.match(result.stderr, /^systemd_unavailable: systemd の user manager に接続できません/mu)
    assert.match(result.stderr, /runner を入れずに終わります/u)
    assert.deepEqual((await fs.readFile(systemdLog, 'utf8')).trim().split('\n'), [`${path.join(systemdDir, 'systemctl')} --user is-system-running`])
    await assert.rejects(fs.access(path.join(configHome, 'systemd')), { code: 'ENOENT' })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('deploy: 本物の araya の CLI が、PATH に systemctl が無くて systemd_unavailable で失敗したときも、注意を出して終了 code 0 で終わり、unit file を書かない', async () => {
  const fixture = await makeDeployFixture()

  try {
    const emptyDir = path.join(fixture.root, 'empty-bin')
    await fs.mkdir(emptyDir)
    const { result, systemdLog, configHome } = await runDeployWithRealAraya(fixture, emptyDir)

    assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr)
    assert.match(result.stderr, /^systemd_unavailable: PATH に systemd-run・systemctl・bash がありません$/mu)
    assert.match(result.stderr, /runner を入れずに終わります/u)
    await assert.rejects(fs.access(systemdLog), { code: 'ENOENT' })
    await assert.rejects(fs.access(path.join(configHome, 'systemd')), { code: 'ENOENT' })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('deploy: 本物の araya の CLI が設定ファイルの誤りで失敗したときは、誤りのメッセージに systemd_unavailable で始まる行があっても、終了 code 1 で終わる', async () => {
  const fixture = await makeDeployFixture()

  try {
    // 未知の key は、そのまま誤りのメッセージに入る。key の中の改行で「systemd_unavailable: 」で始まる行ができる
    const dataDir = path.join(fixture.root, 'data')
    await fs.mkdir(dataDir)
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ '\nsystemd_unavailable: test': true }), 'utf8')
    const { result, systemdLog, configHome } = await runDeployWithRealAraya(fixture, null)

    assert.deepEqual(result.exit, { code: 1, signal: null }, result.stderr)
    assert.match(result.stderr, /invalid Araya config file /u)
    assert.match(result.stderr, /^systemd_unavailable: test$/mu)
    assert.match(result.stderr, /runner を入れられませんでした/u)
    assert.doesNotMatch(result.stderr, /runner を入れずに終わります/u)
    await assert.rejects(fs.access(systemdLog), { code: 'ENOENT' })
    await assert.rejects(fs.access(path.join(configHome, 'systemd')), { code: 'ENOENT' })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
