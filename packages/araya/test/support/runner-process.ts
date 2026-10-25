import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { shellQuote } from '../../src/systemd-units.ts'
import { answer, toolCall, worktreePathFrom, type FauxView } from './faux-shiki.ts'
import { readRunnerLog, teardownRunner, withTimeout, type RunnerSetup } from './runner-loop.ts'
import { completingStep, isRecord, PASS_COMMAND } from './runner-scenarios.ts'

// process をまたぐ test（runner の SIGKILL・SIGTERM と再開）の support。test 用の entrypoint（task-runner-entry.ts）を子 process で起動し、
// 待ち、signal を送り、後始末をする。SHIKI の応答（processStep）は entrypoint の process の中で動くので、
// 課題の本文に書いた script の名前と、会話の中の tool の結果だけで決める（process の memory に状態を持たない）

const ENTRY_PATH = fileURLToPath(new URL('./task-runner-entry.ts', import.meta.url))
const EXIT_TIMEOUT_MS = 30_000
const RECORD_FILE = 'fake-systemd.jsonl'

// bash_setsid は bash_sleep と同じ流れで、1回目の bash が setsid で切り離した process も残す（本物の systemd の test）
export type ProcessScript = 'complete' | 'bash_sleep' | 'bash_setsid' | 'verify_sleep'
// kill_before_agent_commit は、起動のたびに agent の phase の commit の前に落ちる（restartLimit まで落ち続ける試行）
export type ProcessFault = 'kill_after_claim' | 'kill_after_evidence_file' | 'kill_before_agent_commit'

export function isProcessFault(value: string): value is ProcessFault {
  return value === 'kill_after_claim' || value === 'kill_after_evidence_file' || value === 'kill_before_agent_commit'
}

// 課題の本文（goal）に script の名前を書く。processStep はこれを読んで応答を選ぶ
export function scriptGoal(script: ProcessScript) {
  return `README に1行足し、検証を登録する。script=${script}`
}

// 試行ごとに SHIKI と検証のコマンドが書く file（workDir は test の一時 directory）
export function processFiles(workDir: string, taskKey: string) {
  return {
    bashPid: path.join(workDir, `${taskKey}.bash.pid`),
    interrupted: path.join(workDir, `${taskKey}.interrupted`),
    setsidPid: path.join(workDir, `${taskKey}.setsid.pid`),
    verifyPid: path.join(workDir, `${taskKey}.verify.pid`)
  }
}

// 1回目は pid を書いて止まるまで待ち続け、2回目（pid の file がある）は成功する検証のコマンド
function sleepOnceVerification(pidFile: string) {
  const script = [
    "const fs = require('node:fs')",
    `const file = ${JSON.stringify(pidFile)}`,
    "if (fs.existsSync(file)) { console.log('verified') } else { fs.writeFileSync(file, String(process.pid)); setInterval(() => {}, 1000) }"
  ].join('\n')

  return [process.execPath, '-e', script]
}

// entrypoint の faux の model の応答
export function processStep(view: FauxView, workDir: string) {
  const script = /script=([a-z_]+)/u.exec(view.prompt)?.[1] ?? 'complete'
  const files = processFiles(workDir, view.taskKey)
  const results = view.toolResults

  if (script === 'verify_sleep') {
    return completingStep(view, { command: sleepOnceVerification(files.verifyPid) })
  }

  if (script !== 'bash_sleep' && script !== 'bash_setsid') {
    return completingStep(view)
  }

  switch (results.length) {
    case 0:
      return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
    case 1: {
      // setsid した process は自分の pid を書いてから sleep に置き換わる（setsid が fork しても、書かれるのは残る process の pid）
      const detached = `setsid sh -c ${shellQuote(`echo $$ > ${shellQuote(files.setsidPid)}; exec sleep 300`)} >/dev/null 2>&1 </dev/null & `

      return toolCall('bash', { command: `${script === 'bash_setsid' ? detached : ''}echo $$ > ${shellQuote(files.bashPid)}; sleep 30` })
    }
    case 2: {
      // 途中で止まった bash が、model に interrupted の誤りとして返ったかを file に残す
      const previous = results[1]
      const state = previous?.isError === true && /interrupted/u.test(previous.text) ? 'interrupted' : 'not-interrupted'

      return toolCall('bash', {
        command: `printf '%s\\n' ${state} > ${shellQuote(files.interrupted)}; printf 'changed\\n' >> ${shellQuote(`${worktreePathFrom(results[0])}/README.md`)}`
      })
    }
    case 3:
      return toolCall('araya_register_verification', { repository: 'repo', command: [...PASS_COMMAND] })
    default:
      return answer(`${view.taskKey} を再開して終わりました`)
  }
}

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null }
export type RunnerProcess = Awaited<ReturnType<typeof startRunnerProcess>>

// test 用の entrypoint を子 process で起動する。run は起動の番号（INVOCATION_ID と出力の file の名前に使う）
export async function startRunnerProcess(setup: RunnerSetup, options: { run: number; fault?: ProcessFault }) {
  const outputPath = path.join(setup.fixture.root, `runner-${options.run}.out`)
  const output = await fs.open(outputPath, 'a')
  const args = [
    ENTRY_PATH,
    '--data-dir', setup.fixture.dataDir,
    '--work-dir', setup.fixture.root,
    ...(options.fault === undefined ? [] : ['--fault', options.fault])
  ]
  let child: ReturnType<typeof spawn>

  try {
    child = spawn(process.execPath, args, {
      env: { ...setup.env, INVOCATION_ID: `process-run-${options.run}` },
      stdio: ['ignore', output.fd, output.fd]
    })
  } finally {
    await output.close()
  }

  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal })
    })
  })
  const pid = child.pid

  if (pid === undefined) {
    throw new Error('the runner process did not start')
  }

  let exit: ProcessExit | null = null
  void exited.then((value) => {
    exit = value
  })

  return {
    pid,
    outputPath,
    exited,
    hasExited() {
      return exit !== null
    },
    signal(name: NodeJS.Signals) {
      if (exit === null) {
        child.kill(name)
      }
    }
  }
}

export function waitForExit(runner: RunnerProcess, timeoutMs = EXIT_TIMEOUT_MS) {
  return withTimeout(runner.exited, `runner process ${runner.pid} exits`, timeoutMs)
}

// SIGTERM を送り（一時停止）、終わりを待つ
export async function stopRunnerProcess(runner: RunnerProcess) {
  runner.signal('SIGTERM')

  return waitForExit(runner)
}

// 偽物の systemd が process をまたいで追記した記録
export async function readProcessRecords(setup: RunnerSetup) {
  let text: string

  try {
    text = await fs.readFile(path.join(setup.fixture.root, RECORD_FILE), 'utf8')
  } catch {
    return []
  }

  return text.split('\n').filter((line) => {
    return line !== ''
  }).map((line) => {
    const value: unknown = JSON.parse(line)

    return isRecord(value) ? value : {}
  })
}

export function recordFilePath(workDir: string) {
  return path.join(workDir, RECORD_FILE)
}

// 失敗したときに runner の log と子 process の出力を test の診断に出す
async function reportDiagnostics(t: TestContext, setup: RunnerSetup, runners: readonly RunnerProcess[]) {
  t.diagnostic(`runner.log:\n${await readRunnerLog(setup.fixture)}`)

  for (const runner of runners) {
    const output = await fs.readFile(runner.outputPath, 'utf8').catch(() => {
      return ''
    })
    t.diagnostic(`runner ${runner.pid} output:\n${output}`)
  }
}

// 残った runner を SIGKILL し、偽物の systemd の印の付いた process（bash・検証のコマンド）を止めて、一時 directory を消す
export async function teardownRunnerProcesses(setup: RunnerSetup, runners: readonly RunnerProcess[]) {
  for (const runner of runners) {
    if (!runner.hasExited()) {
      runner.signal('SIGKILL')
      await waitForExit(runner).catch(() => {})
    }
  }

  await teardownRunner(setup)
}

// test の本体を動かし、失敗したら診断を出す。最後に必ず後始末をする
export async function withRunnerProcesses(t: TestContext, setup: RunnerSetup, body: (runners: RunnerProcess[]) => Promise<void>) {
  const runners: RunnerProcess[] = []

  try {
    await body(runners)
  } catch (error) {
    await reportDiagnostics(t, setup, runners)
    throw error
  } finally {
    await teardownRunnerProcesses(setup, runners)
  }
}
