import os from 'node:os'

import { parseCliArguments } from './arguments.ts'
import { loadConfig } from './config.ts'
import { loadConfigFile } from './config-file.ts'
import {
  approveOpportunity,
  initAraya,
  rejectOpportunity,
  runAraya,
  statusAraya,
  tickAraya
} from './operations.ts'
import { createSystemdOps, resolveRunnerEntrypoint } from './systemd-units.ts'
import {
  assertSupportedPlatform,
  runRunnerCommand,
  runTaskCommand,
  type RunnerCommandDependencies
} from './task-commands.ts'

async function launchPi(args: string[]) {
  const { main } = await import('@earendil-works/pi-coding-agent')
  await main(args)
}

function printHelp() {
  console.log(`araya MVP

使い方:
  araya
    引数なし: Pi の interactive TUI を同じプロセス内で起動する。tick は自動では実行しない。

  araya pi [arguments...]
    Pi に指定した引数を渡して起動する。

  araya --help
    このヘルプを表示する。

  araya init
    状態領域と seed inbox を作成し、初期状態を status.json へ書き出す。

  araya tick
    1回だけ due goal を処理する。inbox の開発課題は実行せずに blocked にする（開発の課題は araya task create で登録する）。

  araya status
    control plane と live task graph を読み、status.json へ書き出す。

  araya run
    ARAYA_INTERVAL_MS ごとに tick を繰り返す。Ctrl+C で停止する。

  araya task create --file <path|->
    開発の Task を台帳（<ARAYA_DATA_DIR>/tasks.sqlite）に登録する。入力は UTF-8 の JSON 1件（- は stdin）。
    runner は起動しない。動いている runner が数秒以内に台帳を見て、実行枠に空きがあれば取り込み、SHIKI を動かす
    （ほかの Task が動いていれば queued で待つ）。

  araya task list [--status <状態>] [--limit <1〜200>]
    Task の一覧を、Task ID の大きい順に出す。

  araya task show <taskId> [--events <0〜500>] [--full]
    Task と試行、途中経過を出す。--full は evidence.json の差分と検証の出力の本文も出す。

  araya task retry <taskId> [--note <text> | --note-file <path|->] [--confirm-side-effects]
    failed と blocked の Task を再実行する。--note は追加の指示。SHIKI が判断を求めて blocked になった Task では、
    質問（decisionQuestion）への答えを書く。
    途中で止まった試行の後は --confirm-side-effects が必要。

  araya task cancel <taskId>
    待ちの試行をその場で中止するか、動いている試行の中止を求める。

  araya runner install
    runner（台帳の Task を取り込んで SHIKI を動かす常駐の process）を、systemd の user service（araya-runner-<hash>.service）として入れる。
    unit file を書き、有効にして起動し直す。linger は変えない（無効なら logout で runner が止まり、次に起動したときに続きから進む）。
    unit file に書く環境変数は PATH・LANG・LANGUAGE・TZ・LC_*・ARAYA_*（秘密とみなす名前を除く）・PI_CODING_AGENT_DIR だけ。
    環境変数を変えたときは、やり直す（npm run deploy は、araya を入れた後にこれを実行する）。ARAYA_DATA_DIR を変えると別の runner になる
    （前の runner を残さないときは、先に前の ARAYA_DATA_DIR で araya runner uninstall を実行する）。

  araya runner uninstall
    runner の unit を止めて無効にし、unit file を消す。台帳は変えない（動いていた試行は、入れ直すと続きから進む）。

  araya approve <opportunityId> [note...]
    承認待ち候補を承認する。外部実行はまだ行わない。

  araya reject <opportunityId> [note...]
    候補を却下する。

  araya task と araya runner は Linux と systemd（254 以降）の user manager が必要。

設定ファイル:
  <ARAYA_DATA_DIR>/config.json（既定: ~/.araya/config.json）
    runner の SHIKI（開発の agent）の model と thinking level を指定する。subcommand は起動時に1回だけ読み、
    runner は試行を取り込むたびに読む。

環境変数:
  ARAYA_DATA_DIR
  ARAYA_INBOX_DIR
  ARAYA_STATUS_FILE
  ARAYA_CONTROL_PLANE_PATH
  ARAYA_PI_DURABLE_PATH
  ARAYA_INTERVAL_MS
  ARAYA_MAX_ACTIONS
  ARAYA_DEV_ROOT
  ARAYA_DEVELOPMENT_TIMEOUT_MS
  ARAYA_VERIFICATION_TIMEOUT_MS
  PI_CODING_AGENT_DIR
`)
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

// この環境では araya task と araya runner を使えないことを表す誤りの code
const UNSUPPORTED_ENVIRONMENT_CODES = ['unsupported_platform', 'systemd_unavailable']
// その誤りの終了 code（sysexits.h の EX_UNAVAILABLE）。Node.js が自分の誤りに使う終了 code（14 以下、124、128 より大きい値）と重ならない。
// npm run deploy は、この終了 code のときに runner を入れずに成功で終わる
export const UNSUPPORTED_ENVIRONMENT_EXIT_CODE = 69

// CLI の誤りの終了 code。この環境では使えない誤りは UNSUPPORTED_ENVIRONMENT_EXIT_CODE、それ以外は 1
export function exitCodeOf(error: unknown) {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && UNSUPPORTED_ENVIRONMENT_CODES.includes(error.code)) {
    return UNSUPPORTED_ENVIRONMENT_EXIT_CODE
  }

  return 1
}

const SUBCOMMANDS = ['init', 'tick', 'status', 'run', 'approve', 'reject']

async function loadCliConfig(env: NodeJS.ProcessEnv | undefined) {
  // 設定ファイルは subcommand を処理する前に1回だけ読む。実行中に書き換えても再起動するまで反映しない
  const baseConfig = loadConfig(env)
  const { developmentModel } = await loadConfigFile(baseConfig.configPath)

  return { ...baseConfig, developmentModel }
}

function defaultCommandDependencies(env: Readonly<Record<string, string | undefined>>) {
  const deps: RunnerCommandDependencies = {
    platform: process.platform,
    env,
    stdin: process.stdin,
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    nowMs: () => Date.now(),
    createSystemdOps,
    nodePath: process.execPath,
    resolveRunnerEntrypoint: () => resolveRunnerEntrypoint(),
    homeDir: os.homedir(),
    uid: process.getuid?.() ?? -1,
    sleep: (ms) => new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  return deps
}

// env と taskDependencies は test 用。省略時は loadConfig が process.env を読む
export async function runCli(
  args: string[],
  startPi = launchPi,
  env?: NodeJS.ProcessEnv,
  taskDependencies: Partial<RunnerCommandDependencies> = {}
) {
  if (args.length === 0) {
    await startPi([])
    return
  }

  if (args[0] === 'pi') {
    await startPi(args.slice(1))
    return
  }

  // task と runner の command は独自の option を持つので、共通の引数の解析より先に振り分ける
  if (args[0] === 'task' || args[0] === 'runner') {
    assertSupportedPlatform(taskDependencies.platform ?? process.platform)
    const config = await loadCliConfig(env)
    const deps = { ...defaultCommandDependencies(config.env), ...taskDependencies }

    if (args[0] === 'task') {
      await runTaskCommand(args.slice(1), config, deps)
    } else {
      await runRunnerCommand(args.slice(1), config, deps)
    }

    return
  }

  const { help, positionals } = parseCliArguments(args)
  const command = positionals[0] ?? 'help'

  if (help || command === 'help') {
    printHelp()
    return
  }

  if (!SUBCOMMANDS.includes(command)) {
    printHelp()
    throw new Error(`不明な command: ${command}`)
  }

  const config = await loadCliConfig(env)

  if (command === 'init') {
    printJson(await initAraya(config))
    return
  }

  if (command === 'tick') {
    printJson(await tickAraya(config))
    return
  }

  if (command === 'status') {
    printJson(await statusAraya(config))
    return
  }

  if (command === 'run') {
    await runAraya(config)
    return
  }

  if (command === 'approve' || command === 'reject') {
    const opportunityId = positionals[1]

    if (opportunityId === undefined || opportunityId === '') {
      throw new Error(`${command} には opportunityId が必要です`)
    }

    const note = positionals.slice(2).join(' ')
    const result = command === 'approve'
      ? approveOpportunity(config, opportunityId, note)
      : rejectOpportunity(config, opportunityId, note)

    printJson(result)
  }
}
