import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config/environment.ts'
import { parseCliArguments } from '../src/cli/arguments.ts'
import { runCli } from '../src/cli/main.ts'

async function runArayaCliWithoutPiBinary(args: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-no-pi-cli-test-'))
  const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: dir, PATH: dir },
    stdio: 'pipe'
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.stdin.end()
    })

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

test('config: Pi agent directory is isolated from the host environment variable', () => {
  const config = loadConfig({
    ARAYA_DATA_DIR: '/tmp/araya-config-test',
    PI_CODING_AGENT_DIR: '/tmp/host-pi'
  })

  assert.equal(config.piAgentDir, '/tmp/araya-config-test/pi')
})

test('config: 開発 root と timeout の範囲を設定から読む', () => {
  const config = loadConfig({
    ARAYA_DATA_DIR: '/tmp/araya-config-test',
    ARAYA_DEV_ROOT: '/workspace/dev/../dev',
    ARAYA_DEVELOPMENT_TIMEOUT_MS: '7000000',
    ARAYA_VERIFICATION_TIMEOUT_MS: '500'
  })

  assert.equal(config.devRoot, '/workspace/dev')
  assert.equal(config.developmentTimeoutMs, 60 * 60 * 1000)
  assert.equal(config.verificationTimeoutMs, 1000)
})

test('config: 設定ファイル path と開発 root の既定を解決する', () => {
  const config = loadConfig({ ARAYA_DATA_DIR: '/tmp/araya-config-test' })

  assert.equal(config.configPath, '/tmp/araya-config-test/config.json')
  assert.equal(config.developmentModel, null)
  assert.equal(loadConfig({}).configPath, path.join(os.homedir(), '.araya', 'config.json'))
  assert.equal(loadConfig({}).devRoot, path.join(os.homedir(), 'dev'))
  assert.equal(loadConfig({ ARAYA_DEV_ROOT: '' }).devRoot, path.join(os.homedir(), 'dev'))
})

test('config: 子 process に引き継ぐ環境変数を copy として持つ', () => {
  const env = { ARAYA_DATA_DIR: '/tmp/araya-config-test', PATH: '/usr/bin', CUSTOM_TOKEN_NAME: 'value' }
  const config = loadConfig(env)

  assert.deepEqual(config.env, {
    ...env,
    PI_CODING_AGENT_DIR: path.join(config.dataDir, 'pi'),
    PI_CODING_AGENT_SESSION_DIR: undefined
  })
  assert.notEqual(config.env, env)
})

test('CLI arguments: --help は help flag として解析する', () => {
  assert.deepEqual(parseCliArguments(['--help']), { help: true, positionals: [] })
})

test('CLI: 引数なしと pi command は Pi SDK に引数を転送する', async () => {
  const started: string[][] = []
  const env = { ARAYA_DATA_DIR: '/tmp/araya-cli-test' }

  await runCli([], async (args) => {
    started.push(args)
  }, env)
  await runCli(['pi', '--model', 'codex'], async (args) => {
    started.push(args)
  }, env, { platform: 'darwin' })

  assert.deepEqual(started, [[], ['--model', 'codex']])
})

test('CLI: help は現行 command を案内する', async () => {
  const help = await captureConsoleLog(async () => {
    await runCli(['--help'], async () => {})
  })

  for (const command of [
    'araya task create --file <path|->',
    'araya task list [--status <状態>] [--limit <1〜200>]',
    'araya task show <taskId> [--events <0〜500>] [--full]',
    'araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]',
    'araya task cancel <taskId>',
    'araya runner install',
    'araya runner uninstall'
  ]) {
    assert.ok(help.includes(`\n  ${command}\n`), command)
  }

  assert.match(help, /^ {2}ARAYA_DEV_ROOT$/mu)
  assert.match(help, /linger は変えない/u)
  assert.doesNotMatch(help, /blocked の質問への答え/u)
  assert.match(help, /--note は追加の指示。SHIKI が判断を求めて blocked になった Task では、\s*質問（decisionQuestion）への答えを書く/u)
  assert.match(help, /SHIKI（開発の agent）/u)
  assert.match(help, /runner（台帳の Task を取り込んで SHIKI を動かす常駐の process）を、systemd の user service/u)
  assert.match(help, /<dataDir>\/pi\/settings\.json に defaultProvider と defaultModel が両方ある場合だけ model を初期設定する/u)
  assert.match(help, /既存 config は変更せず/u)
})

test('CLI: unknown command は設定を読まず、dataDir に変更を加えない', async () => {
  const dataDir = path.join(os.tmpdir(), `araya-unknown-command-${process.pid}`)
  const env = { ARAYA_DATA_DIR: dataDir }

  try {
    const output = await captureConsoleLog(async () => {
      await assert.rejects(runCli(['unknown-command'], async () => {}, env), /不明な command: unknown-command/u)
    })

    assert.match(output, /使い方:/u)
    await assert.rejects(fs.access(dataDir), { code: 'ENOENT' })
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: 引数なし、pi、help は設定ファイルを読まない', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  await fs.writeFile(path.join(dataDir, 'config.json'), 'not json', 'utf8')
  const env = { ARAYA_DATA_DIR: dataDir }
  const started: string[][] = []

  try {
    await runCli([], async (args) => {
      started.push(args)
    }, env)
    await runCli(['pi', '--version'], async (args) => {
      started.push(args)
    }, env)
    const help = await captureConsoleLog(async () => {
      await runCli(['--help'], async () => {}, env)
      await runCli(['help'], async () => {}, env)
    })

    assert.deepEqual(started, [[], ['--version']])
    assert.match(help, /araya task create/u)
    assert.match(help, /araya runner install/u)
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: task・runner command は不正な設定 file で何も処理せずに失敗する', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  const configPath = path.join(dataDir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openai/gpt-5.5', fallbackModels: [] } }), 'utf8')
  const env = { ARAYA_DATA_DIR: dataDir }

  try {
    for (const args of [['task', 'list'], ['runner', 'install']]) {
      await assert.rejects(
        runCli(args, async () => {}, env, { platform: 'linux' }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(error.message.startsWith(`invalid Araya config file ${configPath}: `))
          return true
        }
      )
      assert.deepEqual(await fs.readdir(dataDir), ['config.json'])
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})

test('CLI: 不正な設定 file では exit code 1 で終わり、path を含む message を出す', async () => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-cli-config-test-')))
  const configPath = path.join(dataDir, 'config.json')
  await fs.mkdir(configPath)
  const cliPath = fileURLToPath(new URL('../bin/cli.ts', import.meta.url))

  try {
    const child = spawn(process.execPath, [cliPath, 'task', 'list'], {
      env: { PATH: process.env.PATH, HOME: dataDir, ARAYA_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })

    assert.deepEqual(exit, { code: 1, signal: null })
    assert.equal(stdout.join(''), '')
    assert.equal(stderr.join(''), `invalid Araya config file ${configPath}: not a regular file\n`)
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
