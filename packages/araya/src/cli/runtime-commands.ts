import fs from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { collectSecretValues, createRedactor } from '../infrastructure/redaction.ts'
import {
  buildRuntimeTargetUnitFile,
  commandSucceeded,
  dataDirHash,
  discordUnitName,
  runnerUnitName,
  runtimeTargetUnitName,
  unitFilePath,
  type SystemdOps,
} from '../infrastructure/systemd.ts'
import {
  commandError,
  realpathOrResolved,
  runSystemctl,
  systemdCommandError,
  writeUnitFile,
  type RunnerCommandConfig,
  type RunnerCommandDependencies,
} from './task-commands.ts'

const SYSTEMCTL_TIMEOUT_MS = 30_000
const SYSTEMCTL_CONNECT_TIMEOUT_MS = 10_000
const SYSTEMCTL_STOP_TIMEOUT_MS = 90_000
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

export type RuntimeCommandDependencies = Pick<
  RunnerCommandDependencies,
  'platform' | 'env' | 'stdout' | 'stderr' | 'nowMs' | 'createSystemdOps' | 'homeDir'
>

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function isReachableManagerState(state: string) {
  return REACHABLE_MANAGER_STATES.includes(state)
}

async function requireRegularUnitFile(unitPath: string, unit: string) {
  let stat

  try {
    stat = await fs.lstat(unitPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw commandError(
        'runtime_component_missing',
        `${unit} がありません。先に araya runner install と araya discord install を実行してください`,
      )
    }

    throw error
  }

  if (!stat.isFile()) {
    throw commandError(
      'runtime_component_missing',
      `${unit} は通常の unit file ではありません。component unit を変更していません`,
    )
  }
}

async function requireComponentRelationship(ops: SystemdOps, unit: string, unitPath: string, target: string, redactor: ReturnType<typeof createRedactor>) {
  const fragment = await ops.systemctl(
    ['--user', 'show', '--property=FragmentPath', '--value', unit],
    SYSTEMCTL_TIMEOUT_MS,
  )

  if (!commandSucceeded(fragment) || fragment.stdout.trim() !== unitPath) {
    throw commandError(
      'runtime_component_not_loaded',
      `${unit} が期待する unit file から読み込まれていません。既存の component unit は自動変更しません`,
    )
  }

  const partOf = await ops.systemctl(
    ['--user', 'show', '--property=PartOf', '--value', unit],
    SYSTEMCTL_TIMEOUT_MS,
  )

  if (!commandSucceeded(partOf)) {
    throw systemdCommandError(
      'systemctl',
      ['--user', 'show', '--property=PartOf', '--value', unit],
      partOf,
      redactor,
    )
  }

  if (partOf.stdout.trim() !== target) {
    throw commandError(
      'runtime_component_not_linked',
      `${unit} は ${target} の停止・再起動に連動していません。先に araya runner install と araya discord install を再実行してください`,
    )
  }
}

async function requireUserManager(ops: SystemdOps, redactor: ReturnType<typeof createRedactor>) {
  const managerState = await ops.systemctl(
    ['--user', 'is-system-running'],
    SYSTEMCTL_CONNECT_TIMEOUT_MS,
  )
  const state = managerState.stdout.split('\n')[0]?.trim() ?? ''

  if (!commandSucceeded(managerState) && !isReachableManagerState(state)) {
    const stderr = redactor.redact(managerState.stderr.trim()).slice(0, 500)
    throw commandError(
      'systemd_unavailable',
      `systemd の user manager に接続できません（${state === '' ? stderr || '応答なし' : state}）`,
    )
  }

  if (!isReachableManagerState(state)) {
    const stderr = redactor.redact(managerState.stderr.trim()).slice(0, 500)
    throw commandError(
      'systemd_unavailable',
      `systemd の user manager に接続できません（${state === '' ? stderr || '応答なし' : state}）`,
    )
  }
}

async function installRuntime(config: RunnerCommandConfig, deps: RuntimeCommandDependencies, redactor: ReturnType<typeof createRedactor>) {
  const ops = await deps.createSystemdOps(deps.env)
  await requireUserManager(ops, redactor)

  const dataDir = await fs.realpath(config.dataDir)
  const hash = dataDirHash(dataDir)
  const runner = runnerUnitName(hash)
  const discord = discordUnitName(hash)
  const target = runtimeTargetUnitName(hash)
  const runnerPath = unitFilePath(deps.env, deps.homeDir, runner)
  const discordPath = unitFilePath(deps.env, deps.homeDir, discord)
  const targetPath = unitFilePath(deps.env, deps.homeDir, target)

  await requireRegularUnitFile(runnerPath, runner)
  await requireRegularUnitFile(discordPath, discord)
  await requireComponentRelationship(ops, runner, runnerPath, target, redactor)
  await requireComponentRelationship(ops, discord, discordPath, target, redactor)

  const content = buildRuntimeTargetUnitFile({ dataDir })
  await writeUnitFile(targetPath, content)
  await runSystemctl(ops, ['--user', 'daemon-reload'], SYSTEMCTL_TIMEOUT_MS, redactor)

  const fragmentPath = (
    await runSystemctl(
      ops,
      ['--user', 'show', '--property=FragmentPath', '--value', target],
      SYSTEMCTL_TIMEOUT_MS,
      redactor,
    )
  ).stdout.trim()

  if (fragmentPath !== targetPath) {
    throw commandError(
      'unit_not_loaded',
      `user manager が ${targetPath} ではなく ${fragmentPath === '' ? '（なし）' : fragmentPath} を読んでいます`,
    )
  }

  await runSystemctl(ops, ['--user', 'enable', target], SYSTEMCTL_TIMEOUT_MS, redactor)
  await runSystemctl(ops, ['--user', 'start', target], SYSTEMCTL_STOP_TIMEOUT_MS, redactor)

  return { target, targetPath, runner, discord }
}

async function uninstallRuntime(config: RunnerCommandConfig, deps: RuntimeCommandDependencies, redactor: ReturnType<typeof createRedactor>) {
  const ops = await deps.createSystemdOps(deps.env)
  const dataDir = await realpathOrResolved(config.dataDir)
  const target = runtimeTargetUnitName(dataDirHash(dataDir))
  const targetPath = unitFilePath(deps.env, deps.homeDir, target)
  const disableArgs = ['--user', 'disable', '--now', target]
  const disabled = await ops.systemctl(disableArgs, SYSTEMCTL_STOP_TIMEOUT_MS)

  if (!commandSucceeded(disabled)) {
    if (disabled.timedOut || !UNIT_MISSING_PATTERN.test(disabled.stderr)) {
      throw systemdCommandError('systemctl', disableArgs, disabled, redactor)
    }

    const stopArgs = ['--user', 'stop', target]
    const stopped = await ops.systemctl(stopArgs, SYSTEMCTL_STOP_TIMEOUT_MS)

    if (
      !commandSucceeded(stopped) &&
      (stopped.timedOut || !UNIT_NOT_LOADED_PATTERN.test(stopped.stderr))
    ) {
      throw systemdCommandError('systemctl', stopArgs, stopped, redactor)
    }
  }

  let removed = false

  try {
    await fs.unlink(targetPath)
    removed = true
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  await runSystemctl(ops, ['--user', 'daemon-reload'], SYSTEMCTL_TIMEOUT_MS, redactor)

  return { target, targetPath, removed }
}

// runtime install は existing component unit を変更せず、連動契約を確認してから target のみを導入
export async function runRuntimeCommand(args: string[], config: RunnerCommandConfig, deps: RuntimeCommandDependencies) {
  if (deps.platform !== 'linux') {
    throw commandError('unsupported_platform', `araya runtime は Linux でだけ使えます（${deps.platform}）`)
  }

  let positionals: string[]

  try {
    ;({ positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true }))
  } catch (error) {
    throw commandError('invalid_arguments', error instanceof Error ? error.message : String(error))
  }

  const subcommand = positionals[0]

  if ((subcommand !== 'install' && subcommand !== 'uninstall') || positionals.length !== 1) {
    throw commandError(
      'invalid_arguments',
      `不明な runtime の command: ${positionals.join(' ') || '（なし）'}。install・uninstall のどちらかを指定してください`,
    )
  }

  const redactor = createRedactor(collectSecretValues(deps.env))
  const result = subcommand === 'install'
    ? await installRuntime(config, deps, redactor)
    : await uninstallRuntime(config, deps, redactor)

  deps.stdout(JSON.stringify(result, null, 2))
}
