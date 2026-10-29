import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, TextDecoder } from 'node:util'

import { collectSecretValues, createRedactor, type Redactor } from '../infrastructure/redaction.ts'
import { initializeConfigFromPiSettings } from '../config/file.ts'
import {
  buildRunnerUnitFile,
  commandSucceeded,
  dataDirHash,
  runnerUnitName,
  selectUnitEnvironment,
  unitFilePath,
  type CommandResult,
  type SystemdOps
} from '../infrastructure/systemd.ts'
import {
  isLedgerError,
  MAX_CONCURRENT_ATTEMPTS,
  MAX_NOTE_CHARS,
  MAX_TASK_INPUT_BYTES,
  openTaskLedger,
  parseRetryNote,
  parseTaskInput,
  TASK_STATUSES,
  type AttemptView,
  type RunnerView,
  type TaskLedger
} from '../runner/ledger.ts'

// araya task の command。台帳だけを読み書きし、runner を起動しない

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const DEFAULT_EVENTS = 50
const MAX_EVENTS = 500
// 10,000 文字（UTF-16 の code unit）の UTF-8 は最大 30,000 byte
const MAX_NOTE_BYTES = MAX_NOTE_CHARS * 3

const SYSTEMCTL_TIMEOUT_MS = 30_000
const SYSTEMCTL_RESTART_TIMEOUT_MS = 90_000
const SYSTEMD_CONNECT_TIMEOUT_MS = 10_000
const RUNNER_START_WAIT_MS = 10_000
const RUNNER_START_POLL_MS = 200
const MAX_COMMAND_STDERR_CHARS = 500
// systemctl --user is-system-running の1行目がこれなら user manager に接続できた
const REACHABLE_MANAGER_STATES = ['initializing', 'starting', 'running', 'degraded', 'maintenance', 'stopping']
const UNIT_MISSING_PATTERN = /does not exist|not loaded|not found/iu
// systemctl --user stop の、unit が読み込まれていないための失敗（systemd 259 では終了 code 5、stderr は Unit <unit> not loaded.）
const UNIT_NOT_LOADED_PATTERN = /not loaded/iu

const SIDE_EFFECTS_MESSAGE = '前回の試行では外部の branch や Draft PR が作成・更新された可能性がある、または結果を確認できません。前回の worktree と GitHub の状態を確かめてから、--confirm-side-effects を付けて再実行してください'

export type TaskCommandDependencies = {
  platform: NodeJS.Platform
  // 秘密とみなす値を集める環境変数
  env: Readonly<Record<string, string | undefined>>
  stdin: AsyncIterable<Uint8Array | string>
  stdout(text: string): void
  stderr(text: string): void
  // runner の heartbeat が古いかを判定する壁時計
  nowMs(): number
}

// araya runner の command が使うもの。test では偽物の systemd を渡す
export type RunnerCommandDependencies = TaskCommandDependencies & {
  createSystemdOps(env: Readonly<Record<string, string | undefined>>): Promise<SystemdOps>
  // unit file の ExecStart に書く node の実行ファイル
  nodePath: string
  resolveRunnerEntrypoint(): Promise<string>
  // XDG_CONFIG_HOME が絶対 path でないときの ~/.config の ~
  homeDir: string
  uid: number
  sleep(ms: number): Promise<void>
}

export type RunnerCommandConfig = {
  dataDir: string
  devRoot: string
  piAgentDir: string | undefined
}

export type FullEvidenceError = 'not_stored' | 'missing' | 'unreadable' | 'digest_mismatch'

export type FullAttemptView = AttemptView & { fullEvidenceError?: FullEvidenceError }

function commandError(code: string, message: string) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

// araya task と araya runner は Linux と systemd の user manager を前提にする
export function assertSupportedPlatform(platform: NodeJS.Platform) {
  if (platform !== 'linux') {
    throw commandError('unsupported_platform', `araya task と araya runner は Linux でだけ使えます（${platform}）`)
  }
}

async function readBoundedFile(filePath: string, limit: number) {
  let fileHandle: FileHandle

  try {
    // FIFO などで止まらないように non-blocking で開く
    fileHandle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch (error) {
    throw commandError('invalid_arguments', `${filePath} を読めません（${error instanceof Error ? error.message : String(error)}）`)
  }

  try {
    if (!(await fileHandle.stat()).isFile()) {
      throw commandError('invalid_arguments', `${filePath} は通常の file ではありません`)
    }

    const buffer = Buffer.alloc(limit + 1)
    let length = 0

    while (length < buffer.byteLength) {
      const { bytesRead } = await fileHandle.read(buffer, length, buffer.byteLength - length, length)

      if (bytesRead === 0) {
        break
      }

      length += bytesRead
    }

    return buffer.subarray(0, length)
  } finally {
    await fileHandle.close()
  }
}

// 上限を1 byte 超えたところで読むのをやめる
async function readBoundedStream(stream: AsyncIterable<Uint8Array | string>, limit: number) {
  const chunks: Buffer[] = []
  let length = 0

  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    chunks.push(buffer)
    length += buffer.byteLength

    if (length > limit) {
      break
    }
  }

  return Buffer.concat(chunks).subarray(0, limit + 1)
}

async function readInput(source: string, limit: number, deps: TaskCommandDependencies) {
  return source === '-' ? readBoundedStream(deps.stdin, limit) : readBoundedFile(source, limit)
}

function parseTaskId(value: string | undefined) {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw commandError('invalid_arguments', 'taskId は 1 以上の10進の整数で指定してください')
  }

  return Number(value)
}

function parseBoundedInteger(value: string | undefined, name: string, minimum: number, maximum: number, fallback: number) {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number(value)

  if (!/^[0-9]+$/u.test(value) || parsed < minimum || parsed > maximum) {
    throw commandError('invalid_arguments', `${name} は ${minimum} から ${maximum} の整数で指定してください`)
  }

  return parsed
}

function parseCommandArgs<T>(parse: () => T) {
  try {
    return parse()
  } catch (error) {
    throw commandError('invalid_arguments', error instanceof Error ? error.message : String(error))
  }
}

// --full: 台帳の evidence の bodiesSha256 と一致する evidence.json があれば、その worktrees（本文を含む）に置き換える
async function withFullEvidence(attempt: AttemptView) {
  const evidence = attempt.evidence

  function failed(fullEvidenceError: FullEvidenceError) {
    const view: FullAttemptView = { ...attempt, fullEvidenceError }

    return view
  }

  if (evidence === null || evidence.bodiesStored !== true || typeof evidence.bodiesSha256 !== 'string') {
    return failed('not_stored')
  }

  if (attempt.stateDir === null) {
    return failed('missing')
  }

  let content: Buffer

  try {
    content = await fs.readFile(path.join(attempt.stateDir, 'evidence.json'))
  } catch (error) {
    return failed(isErrno(error, 'ENOENT') ? 'missing' : 'unreadable')
  }

  if (createHash('sha256').update(content).digest('hex') !== evidence.bodiesSha256) {
    return failed('digest_mismatch')
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(content.toString('utf8'))
  } catch {
    return failed('unreadable')
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.worktrees)) {
    return failed('unreadable')
  }

  const view: FullAttemptView = { ...attempt, evidence: { ...evidence, worktrees: parsed.worktrees } }

  return view
}

function warnIfRunnerStopped(runner: RunnerView, deps: TaskCommandDependencies) {
  if (runner.state !== 'running') {
    deps.stderr(`runner が動いていません（${runner.state}）。araya runner install で入れるか、systemctl --user start ${runner.unit} で起動してください`)
  }
}

async function createTask(args: string[], ledger: TaskLedger, deps: TaskCommandDependencies) {
  const { values, positionals } = parseCommandArgs(() => parseArgs({
    args,
    options: { file: { type: 'string' } },
    allowPositionals: true,
    strict: true
  }))

  if (positionals.length > 0) {
    throw commandError('invalid_arguments', `不明な引数: ${positionals.join(' ')}`)
  }

  if (values.file === undefined) {
    throw commandError('invalid_arguments', 'task create には --file <path|-> が必要です')
  }

  const input = parseTaskInput(await readInput(values.file, MAX_TASK_INPUT_BYTES, deps))
  const { created, task } = ledger.createTask(input)

  return { created, task }
}

function listTasks(args: string[], ledger: TaskLedger) {
  const { values, positionals } = parseCommandArgs(() => parseArgs({
    args,
    options: { status: { type: 'string' }, limit: { type: 'string' } },
    allowPositionals: true,
    strict: true
  }))

  if (positionals.length > 0) {
    throw commandError('invalid_arguments', `不明な引数: ${positionals.join(' ')}`)
  }

  const status = values.status === undefined
    ? undefined
    : TASK_STATUSES.find((candidate) => {
      return candidate === values.status
    })

  if (values.status !== undefined && status === undefined) {
    throw commandError('invalid_arguments', `--status は ${TASK_STATUSES.join('・')} のどれかで指定してください`)
  }

  const limit = parseBoundedInteger(values.limit, '--limit', 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT)

  return ledger.listTasks(status === undefined ? { limit } : { status, limit })
}

async function showTask(args: string[], ledger: TaskLedger) {
  const { values, positionals } = parseCommandArgs(() => parseArgs({
    args,
    options: { events: { type: 'string' }, full: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true
  }))

  if (positionals.length !== 1) {
    throw commandError('invalid_arguments', 'task show には taskId を1つ指定してください')
  }

  const taskId = parseTaskId(positionals[0])
  const events = parseBoundedInteger(values.events, '--events', 0, MAX_EVENTS, DEFAULT_EVENTS)
  const shown = ledger.showTask(taskId, { events })

  if (values.full !== true) {
    return shown
  }

  const attempts: FullAttemptView[] = []

  for (const attempt of shown.attempts) {
    attempts.push(await withFullEvidence(attempt))
  }

  return { ...shown, attempts }
}

async function retryTask(args: string[], ledger: TaskLedger, deps: TaskCommandDependencies) {
  const { values, positionals } = parseCommandArgs(() => parseArgs({
    args,
    options: {
      note: { type: 'string' },
      'note-file': { type: 'string' },
      'confirm-side-effects': { type: 'boolean', default: false }
    },
    allowPositionals: true,
    strict: true
  }))

  if (positionals.length !== 1) {
    throw commandError('invalid_arguments', 'task retry には taskId を1つ指定してください')
  }

  const taskId = parseTaskId(positionals[0])
  const noteFile = values['note-file']

  if (values.note !== undefined && noteFile !== undefined) {
    throw commandError('invalid_arguments', '--note と --note-file は同時に指定できません')
  }

  let note: string | null = null

  if (values.note !== undefined) {
    note = parseRetryNote(values.note)
  } else if (noteFile !== undefined) {
    const raw = await readInput(noteFile, MAX_NOTE_BYTES, deps)

    if (raw.byteLength > MAX_NOTE_BYTES) {
      throw commandError('invalid_note', `the note must be at most ${MAX_NOTE_CHARS} characters`)
    }

    let text: string

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      throw commandError('invalid_note', 'the note is not valid UTF-8')
    }

    note = parseRetryNote(text)
  }

  const confirmSideEffects = values['confirm-side-effects'] === true

  try {
    return ledger.retryTask(taskId, { note, confirmSideEffects })
  } catch (error) {
    if (isLedgerError(error) && error.code === 'side_effects_unconfirmed') {
      const worktrees = error.previousWorktrees ?? []
      const lines = worktrees.length === 0
        ? ['前回の worktree: なし']
        : ['前回の worktree:', ...worktrees.map((worktree) => {
          return `  - ${worktree.worktreePath}（branch ${worktree.branch}）`
        })]

      throw Object.assign(new Error([`side_effects_unconfirmed: ${SIDE_EFFECTS_MESSAGE}`, ...lines].join('\n')), {
        code: error.code
      })
    }

    throw error
  }
}

function cancelTask(args: string[], ledger: TaskLedger) {
  const { positionals } = parseCommandArgs(() => parseArgs({ args, options: {}, allowPositionals: true, strict: true }))

  if (positionals.length !== 1) {
    throw commandError('invalid_arguments', 'task cancel には taskId を1つ指定してください')
  }

  return ledger.cancelTask(parseTaskId(positionals[0]))
}

// araya task <subcommand>。dataDir は loadConfig で解決した絶対 path
export async function runTaskCommand(args: string[], config: { dataDir: string }, deps: TaskCommandDependencies) {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand !== 'create' && subcommand !== 'list' && subcommand !== 'show' && subcommand !== 'retry' && subcommand !== 'cancel') {
    throw commandError('invalid_arguments', `不明な task の command: ${subcommand ?? '（なし）'}。create・list・show・retry・cancel のどれかを指定してください`)
  }

  const ledger = openTaskLedger(config.dataDir, { secretValues: collectSecretValues(deps.env) })

  try {
    const unit = runnerUnitName(dataDirHash(await fs.realpath(config.dataDir)))

    let body: Record<string, unknown>

    if (subcommand === 'create') {
      body = await createTask(rest, ledger, deps)
    } else if (subcommand === 'list') {
      body = { tasks: listTasks(rest, ledger) }
    } else if (subcommand === 'show') {
      body = await showTask(rest, ledger)
    } else if (subcommand === 'retry') {
      body = { task: await retryTask(rest, ledger, deps) }
    } else {
      const { cancel, task } = cancelTask(rest, ledger)
      body = { task, cancel }
    }

    // runner と queue は、command の処理の後の台帳を読む
    const runner = ledger.readRunner(unit, deps.nowMs())
    const queue = ledger.queueView(MAX_CONCURRENT_ATTEMPTS)
    const output = subcommand === 'list' ? { runner, queue, ...body } : { ...body, runner, queue }

    deps.stdout(JSON.stringify(output, null, 2))
    warnIfRunnerStopped(runner, deps)
  } finally {
    ledger.close()
  }
}

// systemctl などの失敗。stderr は秘密を置き換えた先頭 500 文字
function systemdCommandError(name: string, args: readonly string[], result: CommandResult, redactor: Redactor) {
  const status = result.timedOut ? '時間切れで打ち切り' : `終了 code ${result.exitCode ?? 'なし'}`
  const stderr = redactor.redact(result.stderr.trim()).slice(0, MAX_COMMAND_STDERR_CHARS)

  return commandError(`${name}_failed`, `${name} ${args.join(' ')} が失敗しました（${status}）${stderr === '' ? '' : `: ${stderr}`}`)
}

async function runSystemctl(ops: SystemdOps, args: readonly string[], timeoutMs: number, redactor: Redactor) {
  const result = await ops.systemctl(args, timeoutMs)

  if (!commandSucceeded(result)) {
    throw systemdCommandError('systemctl', args, result, redactor)
  }

  return result
}

async function realpathOrResolved(target: string) {
  try {
    return await fs.realpath(target)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return path.resolve(target)
    }

    throw error
  }
}

// 同じ directory の一時 file（mode 0600）に書いてから rename する。directory が無ければ mode 0700 で作る
async function writeUnitFile(unitPath: string, content: string) {
  const directory = path.dirname(unitPath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = path.join(directory, `.${path.basename(unitPath)}.${randomBytes(6).toString('hex')}.tmp`)

  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporaryPath, unitPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function readLinger(ops: SystemdOps, uid: number) {
  const result = await ops.loginctl(['show-user', String(uid), '--property=Linger', '--value'], SYSTEMCTL_TIMEOUT_MS)
  const value = commandSucceeded(result) ? result.stdout.trim() : ''

  return value === 'yes' ? true : value === 'no' ? false : null
}

async function installRunner(config: RunnerCommandConfig, deps: RunnerCommandDependencies, redactor: Redactor) {
  const ops = await deps.createSystemdOps(deps.env)

  // 1. user manager に接続できることを確かめる（終了 code は見ない）
  const managerState = await ops.systemctl(['--user', 'is-system-running'], SYSTEMD_CONNECT_TIMEOUT_MS)
  const state = managerState.stdout.split('\n')[0]?.trim() ?? ''

  if (!REACHABLE_MANAGER_STATES.includes(state)) {
    const stderr = redactor.redact(managerState.stderr.trim()).slice(0, MAX_COMMAND_STDERR_CHARS)
    throw commandError('systemd_unavailable', `systemd の user manager に接続できません（${state === '' ? stderr || '応答なし' : state}）`)
  }

  // 2. dataDir と logs を用意し、unit file の内容を作る
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(config.dataDir, 'logs'), { recursive: true, mode: 0o700 })
  const dataDirReal = await fs.realpath(config.dataDir)
  const unit = runnerUnitName(dataDirHash(dataDirReal))
  const unitPath = unitFilePath(deps.env, deps.homeDir, unit)
  const content = buildRunnerUnitFile({
    dataDir: dataDirReal,
    nodePath: deps.nodePath,
    entrypoint: await deps.resolveRunnerEntrypoint(),
    systemctlPath: ops.systemctlPath,
    environment: selectUnitEnvironment(deps.env, {
      dataDir: config.dataDir,
      devRoot: config.devRoot,
      piAgentDir: config.piAgentDir === undefined ? undefined : path.resolve(config.piAgentDir)
    })
  })
  const piAgentDir = config.piAgentDir === undefined
    ? path.join(deps.homeDir, '.pi', 'agent')
    : path.resolve(config.piAgentDir)
  const configInitialization = await initializeConfigFromPiSettings(
    path.join(config.dataDir, 'config.json'),
    path.join(piAgentDir, 'settings.json')
  )

  if (configInitialization.status === 'skipped') {
    let reason: string

    if (configInitialization.reason === 'pi_settings_missing') {
      reason = 'Pi の settings.json がないため'
    } else if (configInitialization.reason === 'pi_settings_unreadable') {
      reason = 'Pi の settings.json を読み取れないため'
    } else if (configInitialization.reason === 'pi_settings_invalid') {
      reason = 'Pi の settings.json が有効な UTF-8 JSON file ではないため'
    } else if (configInitialization.reason === 'pi_default_missing') {
      reason = 'Pi の defaultProvider/defaultModel が両方設定されていないため'
    } else {
      reason = 'Pi の defaultProvider/defaultModel が有効でないため'
    }

    deps.stderr(`warning: ${reason}、Araya の config.json は作成しませんでした。`)
  }

  // 3. unit file を書く
  await writeUnitFile(unitPath, content)

  // 4. user manager が書いた file を読んだことを確かめる
  await runSystemctl(ops, ['--user', 'daemon-reload'], SYSTEMCTL_TIMEOUT_MS, redactor)
  const fragmentPath = (await runSystemctl(ops, ['--user', 'show', '--property=FragmentPath', '--value', unit], SYSTEMCTL_TIMEOUT_MS, redactor)).stdout.trim()

  if (fragmentPath !== unitPath) {
    throw commandError('unit_not_loaded', `user manager が ${unitPath} ではなく ${fragmentPath === '' ? '（なし）' : fragmentPath} を読んでいます`)
  }

  // 5. 有効にして起動し直す
  await runSystemctl(ops, ['--user', 'enable', unit], SYSTEMCTL_TIMEOUT_MS, redactor)
  await runSystemctl(ops, ['--user', 'restart', unit], SYSTEMCTL_RESTART_TIMEOUT_MS, redactor)

  // 6. 台帳の runner の行が新しい invocation の running になるのを待つ（待てなければ、そのときの値を出す）
  const invocationId = (await runSystemctl(ops, ['--user', 'show', '--property=InvocationID', '--value', unit], SYSTEMCTL_TIMEOUT_MS, redactor)).stdout.trim()
  const ledger = openTaskLedger(config.dataDir, { secretValues: collectSecretValues(deps.env) })
  let runner: RunnerView

  try {
    const deadline = deps.nowMs() + RUNNER_START_WAIT_MS
    runner = ledger.readRunner(unit, deps.nowMs())

    while (!(runner.state === 'running' && invocationId !== '' && ledger.readRunnerInvocationId() === invocationId) && deps.nowMs() < deadline) {
      await deps.sleep(RUNNER_START_POLL_MS)
      runner = ledger.readRunner(unit, deps.nowMs())
    }
  } finally {
    ledger.close()
  }

  // 7. linger は変えずに読むだけ
  const linger = await readLinger(ops, deps.uid)

  if (linger === false) {
    deps.stderr('logout すると runner が止まります。logout の後も動かすには、loginctl enable-linger で linger を有効にしてください')
  }

  return { unit, unitPath, linger, runner, config: configInitialization }
}

async function uninstallRunner(config: RunnerCommandConfig, deps: RunnerCommandDependencies, redactor: Redactor) {
  const ops = await deps.createSystemdOps(deps.env)
  const unit = runnerUnitName(dataDirHash(await realpathOrResolved(config.dataDir)))
  const unitPath = unitFilePath(deps.env, deps.homeDir, unit)
  const disableArgs = ['--user', 'disable', '--now', unit]
  const disabled = await ops.systemctl(disableArgs, SYSTEMCTL_RESTART_TIMEOUT_MS)

  // unit file の有無にかかわらず、unit が無いための失敗だけを無視する。打ち切りは無視しない
  if (!commandSucceeded(disabled)) {
    if (disabled.timedOut || !UNIT_MISSING_PATTERN.test(disabled.stderr)) {
      throw systemdCommandError('systemctl', disableArgs, disabled, redactor)
    }

    // unit file を消した後などは、unit が読み込まれたまま動いていることがあるので止める。読み込まれていないための失敗だけを無視する
    const stopArgs = ['--user', 'stop', unit]
    const stopped = await ops.systemctl(stopArgs, SYSTEMCTL_RESTART_TIMEOUT_MS)

    if (!commandSucceeded(stopped) && (stopped.timedOut || !UNIT_NOT_LOADED_PATTERN.test(stopped.stderr))) {
      throw systemdCommandError('systemctl', stopArgs, stopped, redactor)
    }
  }

  let removed = false

  try {
    await fs.unlink(unitPath)
    removed = true
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  await runSystemctl(ops, ['--user', 'daemon-reload'], SYSTEMCTL_TIMEOUT_MS, redactor)

  return { unit, removed }
}

// araya runner <install|uninstall>。台帳の試行は変えない
export async function runRunnerCommand(args: string[], config: RunnerCommandConfig, deps: RunnerCommandDependencies) {
  const { positionals } = parseCommandArgs(() => parseArgs({ args, options: {}, allowPositionals: true, strict: true }))
  const subcommand = positionals[0]

  if ((subcommand !== 'install' && subcommand !== 'uninstall') || positionals.length !== 1) {
    throw commandError('invalid_arguments', `不明な runner の command: ${positionals.join(' ') || '（なし）'}。install・uninstall のどちらかを指定してください`)
  }

  const redactor = createRedactor(collectSecretValues(deps.env))
  const body = subcommand === 'install'
    ? await installRunner(config, deps, redactor)
    : await uninstallRunner(config, deps, redactor)

  deps.stdout(JSON.stringify(body, null, 2))
}
