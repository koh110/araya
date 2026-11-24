import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vite-plus/test'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config/environment.ts'
import { parseCliArguments } from '../src/cli/arguments.ts'
import { runCli } from '../src/cli/main.ts'
import { readAllProcessEnvironment, readProcessEnvironment } from './config.ts'
import { createFakeSystemd } from './support/fake-systemd.ts'

// CLI spawn に host shell の環境をそのまま継承しない（test を host の environment 依存にしない）
function cliBaseEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [name, value] of Object.entries(readAllProcessEnvironment())) {
    if (value === undefined) {
      continue
    }

    env[name] = value
  }

  return env
}

async function runArayaCliWithoutPiBinary(args: string[], extraEnv: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-no-pi-cli-test-'))
  const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...cliBaseEnvironment(), HOME: dir, PATH: dir, ...extraEnv },
    stdio: 'pipe',
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    return stdout.push(chunk)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    return stderr.push(chunk)
  })

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => {
          return resolve({ code, signal })
        })
        child.stdin.end()
      },
    )

    return { result, stdout: stdout.join(''), stderr: stderr.join('') }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function captureConsoleLog(run: () => Promise<void>) {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(' '))
  }

  try {
    await run()
  } finally {
    console.log = originalLog
  }

  return lines.join('\n')
}

test('config: Araya Pi directory ignores the legacy host PI variable', () => {
  const config = loadConfig({
    ARAYA_DATA_DIR: '/tmp/araya-config-test',
    PI_CODING_AGENT_DIR: '/tmp/host-pi',
  })

  assert.equal(config.piAgentDir, '/tmp/araya-config-test/pi')
  assert.equal(config.env.ARAYA_CODING_AGENT_DIR, config.piAgentDir)
  assert.equal(config.env.PI_CODING_AGENT_DIR, undefined)
})

test('config: 開発 root は canonical path で持ち、不正値は既定に戻す', () => {
  const config = loadConfig({
    ARAYA_DATA_DIR: '/tmp/araya-config-test',
    ARAYA_DEV_ROOT: '/workspace/dev/../dev',
  })

  assert.equal(config.devRoot, '/workspace/dev')
  assert.equal(loadConfig({ ARAYA_DEV_ROOT: '' }).devRoot, path.join(os.homedir(), 'dev'))
})

test('config: 設定ファイル path と開発 root の既定を解決する', () => {
  const config = loadConfig({ ARAYA_DATA_DIR: '/tmp/araya-config-test' })

  assert.equal(config.configPath, '/tmp/araya-config-test/config.json')
  assert.equal(config.agentModel, null)
  assert.equal(loadConfig({}).configPath, path.join(os.homedir(), '.araya', 'config.json'))
  assert.equal(loadConfig({}).devRoot, path.join(os.homedir(), 'dev'))
  assert.equal(loadConfig({ ARAYA_DEV_ROOT: '' }).devRoot, path.join(os.homedir(), 'dev'))
})

test('config: 子 process に引き継ぐ環境変数を copy として持つ', () => {
  const env = {
    ARAYA_DATA_DIR: '/tmp/araya-config-test',
    PATH: '/usr/bin',
    CUSTOM_TOKEN_NAME: 'value',
  }
  const config = loadConfig(env)

  assert.deepEqual(config.env, {
    ...env,
    ARAYA_CODING_AGENT_DIR: path.join(config.dataDir, 'pi'),
    ARAYA_CODING_AGENT_SESSION_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CODING_AGENT_SESSION_DIR: undefined,
    PI_PACKAGE_DIR: undefined,
  })
  assert.notEqual(config.env, env)
})

test('CLI arguments: --help は help flag として解析する', () => {
  assert.deepEqual(parseCliArguments(['--help']), { help: true, positionals: [] })
})

test('CLI: 引数なしと pi command は Pi SDK に引数を転送する', async () => {
  const started: string[][] = []
  const env = { ARAYA_DATA_DIR: '/tmp/araya-cli-test' }

  await runCli(
    [],
    async (args) => {
      started.push(args)
    },
    env,
  )
  await runCli(
    ['pi', '--model', 'codex'],
    async (args) => {
      started.push(args)
    },
    env,
    { platform: 'darwin' },
  )

  assert.deepEqual(started, [[], ['--model', 'codex']])
})

test('CLI: help は現行 command を案内する', async () => {
  const help = await captureConsoleLog(async () => {
    await runCli(['--help'], async () => {})
  })

  for (const command of [
    'araya discord init',
    'araya discord install [--auth-mode env-file|1password]',
    'araya discord uninstall',
    'araya discord run',
  ]) {
    assert.ok(help.includes(`\n  ${command}\n`), command)
  }

  assert.match(help, /^ {2}ARAYA_DEV_ROOT$/mu)
  assert.match(help, /linger は変えない/u)
  assert.match(help, /<ARAYA_DATA_DIR>\/\.env（既定: ~\/\.araya\/\.env）を mode 0600 で作る/u)
  assert.match(
    help,
    /1Password Service Account launcher を使う場合は --auth-mode 1password を明示/u,
  )
  assert.match(help, /task ledger・runner・\/araya task slash command は撤去済み/u)
  assert.match(help, /state.json と agent session の SQLite（<ARAYA_DATA_DIR>\/agent\/）は残す/u)
  assert.doesNotMatch(help, /araya task create/u)
  assert.doesNotMatch(help, /araya runner install/u)
  assert.doesNotMatch(help, /Bot token が op:\/\/ 参照の場合/u)
  assert.match(help, /1Password の op:\/\/ 参照は任意/u)
})

test('CLI: unknown command は設定を読まず、dataDir に変更を加えない', async () => {
  const dataDir = path.join(os.tmpdir(), `araya-unknown-command-${process.pid}`)
  const env = { ARAYA_DATA_DIR: dataDir }

  try {
    const output = await captureConsoleLog(async () => {
      await assert.rejects(
        runCli(['unknown-command'], async () => {}, env),
        /不明な command: unknown-command/u,
      )
    })

    assert.match(output, /使い方:/u)
    await assert.rejects(fs.access(dataDir), { code: 'ENOENT' })
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: 引数なし、pi、help は設定ファイルを読まない', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')),
  )
  await fs.writeFile(path.join(dataDir, 'config.json'), 'not json', 'utf8')
  const env = { ARAYA_DATA_DIR: dataDir }
  const started: string[][] = []

  try {
    await runCli(
      [],
      async (args) => {
        started.push(args)
      },
      env,
    )
    await runCli(
      ['pi', '--version'],
      async (args) => {
        started.push(args)
      },
      env,
    )
    const help = await captureConsoleLog(async () => {
      await runCli(['--help'], async () => {}, env)
      await runCli(['help'], async () => {}, env)
    })

    assert.deepEqual(started, [[], ['--version']])
    assert.match(help, /araya discord install/u)
    assert.match(help, /araya discord uninstall/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: discord command は config.json を読まない（config file を読むのは agent session の開始だけ）', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')),
  )
  const configPath = path.join(dataDir, 'config.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ agent: { model: 'openai/gpt-5.5', fallbackModels: [] } }),
    'utf8',
  )
  const env = { ARAYA_DATA_DIR: dataDir }
  const fake = createFakeSystemd({})
  const lines = await captureConsoleLog(async () => {
    await runCli(['discord', 'uninstall'], async () => {}, env, {
      platform: 'linux',
      createSystemdOps: async () => {
        return fake.ops
      },
    })
  })

  assert.match(lines, /"unit": "araya-discord-/u)
  assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  await fs.rm(dataDir, { recursive: true, force: true })
})

test('CLI: 設定が無い discord run は exit code 1 で discord_not_configured を出す', async () => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')),
  )
  const configPath = path.join(dataDir, 'config.json')
  await fs.writeFile(configPath, 'not json', 'utf8')
  const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))

  try {
    const child = spawn(process.execPath, [cliPath, 'discord', 'run'], {
      env: { PATH: readProcessEnvironment('PATH'), HOME: dataDir, ARAYA_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      return stdout.push(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      return stderr.push(chunk)
    })
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => {
          return resolve({ code, signal })
        })
      },
    )

    assert.deepEqual(exit, { code: 1, signal: null })
    assert.equal(stdout.join(''), '')
    assert.match(stderr.join(''), /discord_not_configured/u)
    assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: Pi SDK はグローバル pi command なしで使える', async () => {
  const { result, stdout, stderr } = await runArayaCliWithoutPiBinary(['pi', '--version'])

  assert.equal(result.signal, null)
  assert.equal(result.code, 0)
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/)
  assert.equal(stderr, '')
})

test('araya status: 稼働中の bot が居ないとき HOOT の状態と unit 案内を返して exit 0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-control-status-'))
  const { result, stdout, stderr } = await runArayaCliWithoutPiBinary(
    ['status', '--wait-seconds', '1'],
    { ARAYA_DATA_DIR: dir },
  )
  assert.equal(result.code, 0, `status: ${stdout}${stderr}`)
  assert.match(stdout, /enabled: false/)
  assert.match(stdout, /araya discord status/)
  // 待ち切れた要求は残さない（bot が後で実行しない）
  assert.deepEqual(await fs.readdir(path.join(dir, 'control', 'requests')).catch(() => []), [])
})

test('araya stop・reset: 稼働中の bot が応答しないとき araya_control_unavailable で失敗する', async () => {
  for (const command of ['stop', 'reset']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-control-down-'))
    const { result, stdout, stderr } = await runArayaCliWithoutPiBinary(
      [command, '--wait-seconds', '1'],
      { ARAYA_DATA_DIR: dir },
    )
    assert.notEqual(result.code, 0, `${command}: ${stdout}${stderr}`)
    assert.match(stderr, /araya_control_unavailable/u)
    assert.deepEqual(await fs.readdir(path.join(dir, 'control', 'requests')).catch(() => []), [])
  }
})

test('agent session の目印入り shell でも araya hoot settings set・stop・reset は同じ動作する（gate を撤去）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-agent-gate-removed-'))
  const agentEnv = { ARAYA_DATA_DIR: dir, ARAYA_AGENT_SESSION: '1' }

  const enabled = await runArayaCliWithoutPiBinary(
    ['hoot', 'settings', 'set', '--enabled', 'true', '--mode', 'dry_run'],
    agentEnv,
  )
  assert.equal(enabled.result.code, 0, `settings set: ${enabled.stdout}${enabled.stderr}`)
  assert.doesNotMatch(enabled.stderr, /hoot_agent_session_blocked/u)

  const shown = await runArayaCliWithoutPiBinary(['hoot', 'settings', 'show'], {
    ARAYA_DATA_DIR: dir,
  })
  assert.equal(shown.result.code, 0, `settings show: ${shown.stdout}${shown.stderr}`)
  assert.match(shown.stdout, /enabled: true/u)

  const goal = await runArayaCliWithoutPiBinary(
    [
      'hoot',
      'goal',
      'add',
      '--key',
      'agent-gate-goal',
      '--objective',
      'agent shell から add できる',
      '--scope',
      'github:koh110/araya',
    ],
    agentEnv,
  )
  assert.equal(goal.result.code, 0, `goal add: ${goal.stdout}${goal.stderr}`)

  for (const command of ['stop', 'reset']) {
    const { result, stderr } = await runArayaCliWithoutPiBinary(
      [command, '--wait-seconds', '1'],
      agentEnv,
    )
    assert.notEqual(result.code, 0, `${command}: ${stderr}`)
    // bot が応答しないので control bus 側で失敗する（agent gate では止まらない）
    assert.match(stderr, /araya_control_unavailable/u)
    assert.doesNotMatch(stderr, /araya_control_agent_session_blocked/u)
  }
})

test('araya --help・hoot --help・discord --help・status --help は slash command との対応表を出す', async () => {
  for (const args of [
    ['--help'],
    ['hoot', '--help'],
    ['discord', '--help'],
    ['status', '--help'],
  ]) {
    const { result, stdout, stderr } = await runArayaCliWithoutPiBinary(args)
    assert.equal(result.code, 0, `${args.join(' ')}: ${stdout}${stderr}`)
    assert.match(stdout, /Discord slash command と CLI の対応/)
    assert.match(stdout, /araya status \| stop \| reset/)
  }
})
