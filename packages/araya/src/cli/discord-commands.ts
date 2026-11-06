// araya discord <init|register|install|uninstall|run>。
// init: 標準の設定 file（<dataDir>/.env）を作る（既存 file は上書きしない）。
// register: slash command 定義を Discord の guild に登録する（必要なら1Password参照を事前に解決する）。
// install: 平文 .env を既定にし、明示 option で1Password launcherを選ぶ。
// uninstall: unit を止めて file を消す。state.json・台帳は残す。
// run: foreground で 1 度動かす（unit 稼働の確かめなし）。
// unit の file 作成・enable・restart は人間の実行（runner と同じ運用）

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { collectSecretValues, createRedactor, type Redactor } from '../infrastructure/redaction.ts'
import {
  buildDiscordUnitFile,
  commandSucceeded,
  dataDirHash,
  discordOpServiceAccountTokenFilePath,
  discordUnitName,
  resolveDiscordEnvRunnerEntrypoint,
  resolveDiscordOpRunnerEntrypoint,
  resolveOpCliPath,
  selectUnitEnvironment,
  unitFilePath,
} from '../infrastructure/systemd.ts'
import {
  createDiscordEnvFile,
  discordEnvFilePath,
  loadDiscordConfig,
  OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME,
  type DiscordAuthMode,
  type DiscordConfig,
} from '../discord/config.ts'
import { discordStateFilePath, readDiscordBotState } from '../discord/state.ts'
import { registerDiscordCommands } from '../discord/gateway.ts'
import { runDiscordBot, type DiscordBotDependencies } from '../discord/bot.ts'
import {
  commandError,
  parseCommandArgs,
  readLinger,
  realpathOrResolved,
  runSystemctl,
  systemdCommandError,
  writeUnitFile,
  type RunnerCommandConfig,
  type RunnerCommandDependencies,
} from './task-commands.ts'

const SYSTEMCTL_TIMEOUT_MS = 30_000
const SYSTEMCTL_RESTART_TIMEOUT_MS = 90_000
const SYSTEMD_CONNECT_TIMEOUT_MS = 10_000
const UNIT_START_WAIT_MS = 10_000
const UNIT_START_POLL_MS = 200
const MAX_OP_SERVICE_ACCOUNT_TOKEN_BYTES = 16 * 1024
const REACHABLE_MANAGER_STATES = [
  'initializing',
  'starting',
  'running',
  'degraded',
  'maintenance',
  'stopping',
]
const UNIT_MISSING_PATTERN = /does not exist|not loaded|not found/iu
const UNIT_NOT_LOADED_PATTERN = /not loaded/iu

export const DISCORD_SUBCOMMANDS = ['init', 'register', 'install', 'uninstall', 'run'] as const

export type DiscordCommandDependencies = RunnerCommandDependencies & {
  // test 用に差し替える。既定は実際の gateway 登録と bot 実行
  registerDiscordCommands?: (config: DiscordConfig) => Promise<void>
  runBot?: (deps: DiscordBotDependencies) => Promise<number>
  resolveDiscordEnvRunnerEntrypoint?: () => Promise<string>
  resolveDiscordOpRunnerEntrypoint?: () => Promise<string>
  resolveOpCliPath?: (searchPath: string | undefined) => Promise<string>
}

function notConfiguredMessage(envFilePath: string) {
  return `Discord の設定がありません。araya discord init で ${envFilePath}（mode 0600）を作成し、Bot token と Discord ID を設定してください。1Password の op:// 参照は任意です（README参照）`
}

async function loadConfiguredOrThrow(
  config: RunnerCommandConfig,
  deps: DiscordCommandDependencies,
) {
  const source = await loadDiscordConfig(config.dataDir, deps.env)

  if (!source.enabled) {
    throw commandError('discord_not_configured', notConfiguredMessage(source.envFilePath))
  }

  return source
}

async function initDiscord(config: RunnerCommandConfig) {
  return await createDiscordEnvFile(config.dataDir)
}

async function registerDiscord(config: RunnerCommandConfig, deps: DiscordCommandDependencies) {
  const source = await loadConfiguredOrThrow(config, deps)
  await (deps.registerDiscordCommands ?? registerDiscordCommands)(source.config)

  return {
    applicationId: source.config.applicationId,
    guildId: source.config.guildId,
    command: 'araya',
    subcommands: ['list', 'show', 'submit', 'cancel', 'retry'],
  }
}

async function validateOpServiceAccountCredential(
  filePath: string,
  uid: number,
  allowMissing = false,
) {
  let stat

  try {
    stat = await fs.lstat(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      if (allowMissing) {
        return false
      }

      throw commandError(
        'op_service_account_credential_missing',
        `1Password Service Account credential がありません: ${filePath}`,
      )
    }

    throw error
  }

  if (!stat.isFile() || stat.uid !== uid) {
    throw commandError(
      'op_service_account_credential_invalid',
      `1Password Service Account credential は service user が所有する通常の file にしてください: ${filePath}`,
    )
  }

  const mode = stat.mode & 0o777

  if (mode !== 0o400 && mode !== 0o600) {
    throw commandError(
      'op_service_account_credential_permissions',
      `1Password Service Account credential は owner のみ読める mode 0400 または 0600 にしてください: ${filePath}`,
    )
  }

  if (stat.size === 0 || stat.size > MAX_OP_SERVICE_ACCOUNT_TOKEN_BYTES) {
    throw commandError(
      'op_service_account_credential_invalid',
      `1Password Service Account credential の size が不正です: ${filePath}`,
    )
  }

  return true
}

function hasControlCharacter(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true
    }
  }

  return false
}

async function validateCredentialDirectoryAncestors(directoryPath: string, uid: number) {
  let current = directoryPath

  while (true) {
    const stat = await fs.lstat(current)
    const mode = stat.mode & 0o7777

    if (
      !stat.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== uid) ||
      ((mode & 0o022) !== 0 && (mode & 0o1000) === 0)
    ) {
      throw commandError(
        'op_service_account_credential_directory_unsafe',
        `1Password Service Account credential の path に置換可能な ancestor があります: ${current}`,
      )
    }

    const parent = path.dirname(current)

    if (parent === current) {
      return
    }

    current = parent
  }
}

async function validateExistingCredentialDirectoryPath(directoryPath: string, uid: number) {
  let current = directoryPath

  while (true) {
    let stat

    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        const parent = path.dirname(current)

        if (parent === current) {
          throw commandError(
            'op_service_account_credential_directory_invalid',
            '1Password Service Account credential の保存先を確認できません',
          )
        }

        current = parent
        continue
      }

      throw commandError(
        'op_service_account_credential_directory_invalid',
        '1Password Service Account credential の保存先を確認できません',
      )
    }

    let resolvedPath

    try {
      resolvedPath = await fs.realpath(current)
    } catch {
      throw commandError(
        'op_service_account_credential_directory_invalid',
        '1Password Service Account credential の保存先を確認できません',
      )
    }

    if (!stat.isDirectory() || resolvedPath !== current) {
      throw commandError(
        'op_service_account_credential_directory_invalid',
        '1Password Service Account credential の保存先は通常の directory にしてください',
      )
    }

    if (current === directoryPath) {
      if (stat.uid !== uid) {
        throw commandError(
          'op_service_account_credential_directory_invalid',
          '1Password Service Account credential の保存先は service user 所有の directory にしてください',
        )
      }

      await validateCredentialDirectoryAncestors(path.dirname(current), uid)
    } else {
      await validateCredentialDirectoryAncestors(current, uid)
    }

    return
  }
}

async function ensurePrivateCredentialDirectory(directoryPath: string, uid: number) {
  await validateExistingCredentialDirectoryPath(directoryPath, uid)
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 })

  let directoryStat
  let resolvedDirectory

  try {
    directoryStat = await fs.lstat(directoryPath)
    resolvedDirectory = await fs.realpath(directoryPath)
  } catch {
    throw commandError(
      'op_service_account_credential_directory_invalid',
      '1Password Service Account credential の保存先を確認できません',
    )
  }

  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== uid ||
    resolvedDirectory !== directoryPath
  ) {
    throw commandError(
      'op_service_account_credential_directory_invalid',
      '1Password Service Account credential の保存先は service user 所有の通常の directory にしてください',
    )
  }

  await validateCredentialDirectoryAncestors(path.dirname(directoryPath), uid)

  if ((directoryStat.mode & 0o777) !== 0o700) {
    try {
      await fs.chmod(directoryPath, 0o700)
    } catch {
      throw commandError(
        'op_service_account_credential_directory_permissions',
        `1Password Service Account credential の保存先を mode 0700 にできません: ${directoryPath}`,
      )
    }
  }

  await validateCredentialDirectoryAncestors(directoryPath, uid)
}

async function writeOpServiceAccountCredential(filePath: string, token: string, uid: number) {
  if (
    token === '' ||
    Buffer.byteLength(token, 'utf8') > MAX_OP_SERVICE_ACCOUNT_TOKEN_BYTES ||
    hasControlCharacter(token)
  ) {
    throw commandError(
      'op_service_account_token_invalid',
      `${OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME} の内容が不正です`,
    )
  }

  const directoryPath = path.dirname(filePath)

  if (!path.isAbsolute(directoryPath) || path.resolve(directoryPath) !== directoryPath) {
    throw commandError(
      'op_service_account_credential_directory_invalid',
      '1Password Service Account credential の保存先が不正です',
    )
  }

  await ensurePrivateCredentialDirectory(directoryPath, uid)

  // 既存 file が symlink・別 user 所有・公開 permission なら、置き換えずに停止する。
  await validateOpServiceAccountCredential(filePath, uid, true)

  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let temporaryCreated = false

  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    temporaryCreated = true

    try {
      await handle.writeFile(token, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await fs.chmod(temporaryPath, 0o600)
    await fs.rename(temporaryPath, filePath)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) {
      await fs.rm(temporaryPath, { force: true })
    }
  }

  await validateOpServiceAccountCredential(filePath, uid)
}

async function installDiscord(
  config: RunnerCommandConfig,
  deps: DiscordCommandDependencies,
  redactor: Redactor,
  authMode: DiscordAuthMode,
) {
  const systemdEnvironment = { ...deps.env }
  delete systemdEnvironment[OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME]
  const ops = await deps.createSystemdOps(systemdEnvironment)

  // 1. user manager に接続できることを確かめる（runner install と同じ）
  const managerState = await ops.systemctl(
    ['--user', 'is-system-running'],
    SYSTEMD_CONNECT_TIMEOUT_MS,
  )
  const state = managerState.stdout.split('\n')[0]?.trim() ?? ''

  if (!REACHABLE_MANAGER_STATES.includes(state)) {
    const stderr = redactor.redact(managerState.stderr.trim()).slice(0, 500)
    throw commandError(
      'systemd_unavailable',
      `systemd の user manager に接続できません（${state === '' ? stderr || '応答なし' : state}）`,
    )
  }

  // 2. dataDir・logs を用意し、設定 file（.env）を確かめる
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(config.dataDir, 'logs'), { recursive: true, mode: 0o700 })
  const dataDirReal = await fs.realpath(config.dataDir)
  const envFile = discordEnvFilePath(dataDirReal)
  const source = await loadDiscordConfig(dataDirReal, deps.env, {
    forPersistentService: true,
    authMode,
  })

  if (source.enabled !== true || !source.fromFile) {
    throw commandError(
      'discord_env_file_required',
      `常駐の service は設定を ${envFile} から読みます。araya discord init で作成してください（mode 0600）`,
    )
  }

  const unit = discordUnitName(dataDirHash(dataDirReal))
  const unitPath = unitFilePath(deps.env, deps.homeDir, unit)
  const environment = selectUnitEnvironment(deps.env, {
    dataDir: config.dataDir,
    devRoot: config.devRoot,
    piAgentDir: config.piAgentDir,
  })
  let content: string
  let opCredentialFile: string | undefined

  if (authMode === '1password') {
    // 3a. install の環境変数から Service Account credential を保存する
    opCredentialFile = discordOpServiceAccountTokenFilePath(deps.env, deps.homeDir)
    const [opPath, opRunnerEntrypoint] = await Promise.all([
      (deps.resolveOpCliPath ?? resolveOpCliPath)(deps.env.PATH),
      (deps.resolveDiscordOpRunnerEntrypoint ?? resolveDiscordOpRunnerEntrypoint)(),
    ])
    const serviceAccountToken = deps.env[OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME]

    if (serviceAccountToken === undefined) {
      throw commandError(
        'op_service_account_token_missing',
        `${OP_SERVICE_ACCOUNT_TOKEN_ENV_NAME} を環境変数に設定してください`,
      )
    }

    content = buildDiscordUnitFile({
      authMode: '1password',
      dataDir: dataDirReal,
      nodePath: deps.nodePath,
      runnerEntrypoint: opRunnerEntrypoint,
      opPath,
      opCredentialFile,
      environment,
    })
    await writeOpServiceAccountCredential(opCredentialFile, serviceAccountToken, deps.uid)
  } else {
    // 3b. 通常の .env mode は systemd LoadCredential で file を launcher に渡す
    const envRunnerEntrypoint = await (
      deps.resolveDiscordEnvRunnerEntrypoint ?? resolveDiscordEnvRunnerEntrypoint
    )()
    content = buildDiscordUnitFile({
      authMode: 'env-file',
      dataDir: dataDirReal,
      nodePath: deps.nodePath,
      runnerEntrypoint: envRunnerEntrypoint,
      envFilePath: envFile,
      environment,
    })
  }

  // 4. unit file を書いて reader に読ませ、有効にして起動し直す
  await writeUnitFile(unitPath, content)
  await runSystemctl(ops, ['--user', 'daemon-reload'], SYSTEMCTL_TIMEOUT_MS, redactor)
  const fragmentPath = (
    await runSystemctl(
      ops,
      ['--user', 'show', '--property=FragmentPath', '--value', unit],
      SYSTEMCTL_TIMEOUT_MS,
      redactor,
    )
  ).stdout.trim()

  if (fragmentPath !== unitPath) {
    throw commandError(
      'unit_not_loaded',
      `user manager が ${unitPath} ではなく ${fragmentPath === '' ? '（なし）' : fragmentPath} を読んでいます`,
    )
  }

  await runSystemctl(ops, ['--user', 'enable', unit], SYSTEMCTL_TIMEOUT_MS, redactor)

  let previousReadyId: string | null = null

  try {
    const previousState = readDiscordBotState(config.dataDir)

    if (previousState?.unit === unit) {
      previousReadyId = previousState.readyId ?? null
    }
  } catch {
    // 古い state が無効なら、起動後に読み直せた state の ready だけを使う
  }

  await runSystemctl(ops, ['--user', 'restart', unit], SYSTEMCTL_RESTART_TIMEOUT_MS, redactor)

  // restart 前の ready 識別子を再利用せず、新しい process の readyId が現れるのを待つ
  const deadline = deps.nowMs() + UNIT_START_WAIT_MS
  let ready = false

  for (;;) {
    let state

    try {
      state = readDiscordBotState(config.dataDir)
    } catch {
      state = null
    }

    if (
      state !== null &&
      state.unit === unit &&
      typeof state.readyId === 'string' &&
      state.readyId !== previousReadyId &&
      state.lastReadyAt !== null
    ) {
      ready = true
      break
    }

    if (deps.nowMs() >= deadline) {
      break
    }

    await deps.sleep(UNIT_START_POLL_MS)
  }

  // 6. linger は変えずに読むだけ
  const linger = await readLinger(ops, deps.uid)

  if (linger === false) {
    deps.stderr(
      'logout すると Discord bot が止まります。logout の後も動かすには、loginctl enable-linger で linger を有効にしてください',
    )
  }

  if (!ready) {
    deps.stderr(
      `warning: ${unit} の起動が確認できませんでした。${path.join(config.dataDir, 'logs', 'discord.log')}、${path.join(config.dataDir, 'logs', 'discord-launcher.log')} と systemctl --user status ${unit} を確認してください`,
    )
  }

  return {
    unit,
    unitPath,
    envFile,
    authMode,
    ...(opCredentialFile === undefined ? {} : { opCredentialFile }),
    ready,
    linger,
  }
}

async function uninstallDiscord(
  config: RunnerCommandConfig,
  deps: DiscordCommandDependencies,
  redactor: Redactor,
) {
  const ops = await deps.createSystemdOps(deps.env)
  const unit = discordUnitName(dataDirHash(await realpathOrResolved(config.dataDir)))
  const unitPath = unitFilePath(deps.env, deps.homeDir, unit)
  const disableArgs = ['--user', 'disable', '--now', unit]
  const disabled = await ops.systemctl(disableArgs, SYSTEMCTL_RESTART_TIMEOUT_MS)

  // unit file の有無にかかわらず、unit が無いための失敗だけを無視する（runner uninstall と同じ）
  if (!commandSucceeded(disabled)) {
    if (disabled.timedOut || !UNIT_MISSING_PATTERN.test(disabled.stderr)) {
      throw systemdCommandError('systemctl', disableArgs, disabled, redactor)
    }

    const stopArgs = ['--user', 'stop', unit]
    const stopped = await ops.systemctl(stopArgs, SYSTEMCTL_RESTART_TIMEOUT_MS)

    if (
      !commandSucceeded(stopped) &&
      (stopped.timedOut || !UNIT_NOT_LOADED_PATTERN.test(stopped.stderr))
    ) {
      throw systemdCommandError('systemctl', stopArgs, stopped, redactor)
    }
  }

  let removed = false

  try {
    await fs.unlink(unitPath)
    removed = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }

  await runSystemctl(ops, ['--user', 'daemon-reload'], SYSTEMCTL_TIMEOUT_MS, redactor)

  // state.json と台帳は残す（入れ直すと続きから進む）
  return { unit, removed, stateFile: discordStateFilePath(config.dataDir) }
}

async function runForeground(config: RunnerCommandConfig, deps: DiscordCommandDependencies) {
  await loadConfiguredOrThrow(config, deps)
  const controller = new AbortController()
  function onSignal() {
    controller.abort()
  }

  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)

  try {
    const code = await (deps.runBot ?? runDiscordBot)({
      dataDir: config.dataDir,
      env: deps.env,
      stopSignal: controller.signal,
      verifyUnit: false,
    })

    if (code !== 0) {
      throw commandError(
        'discord_run_failed',
        `Discord bot の foreground 実行は終了 code ${code} で終わりました`,
      )
    }
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }

  return { ok: true }
}

export async function runDiscordCommand(
  args: string[],
  config: RunnerCommandConfig,
  deps: DiscordCommandDependencies,
) {
  const parsed = parseCommandArgs(() => {
    return parseArgs({
      args,
      options: { 'auth-mode': { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
  })
  const { positionals } = parsed
  const subcommand = DISCORD_SUBCOMMANDS.find((candidate) => {
    return candidate === positionals[0]
  })

  if (subcommand === undefined || positionals.length !== 1) {
    throw commandError(
      'invalid_arguments',
      `不明な discord の command: ${positionals.join(' ') || '（なし）'}。${DISCORD_SUBCOMMANDS.join('・')} のどれかを指定してください`,
    )
  }

  const requestedAuthMode = parsed.values['auth-mode']

  if (
    requestedAuthMode !== undefined &&
    requestedAuthMode !== 'env-file' &&
    requestedAuthMode !== '1password'
  ) {
    throw commandError(
      'invalid_arguments',
      '--auth-mode は env-file または 1password を指定してください',
    )
  }

  if (subcommand !== 'install' && requestedAuthMode !== undefined) {
    throw commandError('invalid_arguments', '--auth-mode は discord install でのみ指定できます')
  }

  const redactor = createRedactor(collectSecretValues(deps.env))
  let body: Record<string, unknown>

  switch (subcommand) {
    case 'init':
      body = await initDiscord(config)
      break
    case 'register':
      body = await registerDiscord(config, deps)
      break
    case 'install':
      body = await installDiscord(config, deps, redactor, requestedAuthMode ?? 'env-file')
      break
    case 'uninstall':
      body = await uninstallDiscord(config, deps, redactor)
      break
    case 'run':
      body = await runForeground(config, deps)
      break
    default:
      throw commandError('invalid_arguments', '上記の command を指定してください')
  }

  deps.stdout(JSON.stringify(body, null, 2))
}
