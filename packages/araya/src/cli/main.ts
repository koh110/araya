import os from 'node:os'

import { parseCliArguments } from './arguments.ts'
import { loadConfig, loadPiSdk, withPiEnvironment } from '../config/environment.ts'
import { loadConfigFile } from '../config/file.ts'
import {
  createSystemdOps,
  resolveDiscordEnvRunnerEntrypoint,
  resolveDiscordOpRunnerEntrypoint,
  resolveOpCliPath,
  resolveRunnerEntrypoint,
} from '../infrastructure/systemd.ts'
import {
  assertSupportedPlatform,
  runRunnerCommand,
  runTaskCommand,
  type RunnerCommandDependencies,
} from './task-commands.ts'
import { runDiscordCommand, type DiscordCommandDependencies } from './discord-commands.ts'
import { runRuntimeCommand } from './runtime-commands.ts'

async function launchPi(args: string[], agentDir: string) {
  const { main } = await loadPiSdk(agentDir)
  await withPiEnvironment(agentDir, async () => {
    await main(args)
  })
}

function printHelp() {
  console.log(`araya MVP

使い方:
  araya
    引数なし: Pi の interactive TUI を同じプロセス内で起動する。

  araya pi [arguments...]
    Pi に指定した引数を渡して起動する。

  araya --help
    このヘルプを表示する。

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
    外部 branch や Draft PR が作成・更新された可能性がある試行の後は --confirm-side-effects が必要。

  araya task cancel <taskId>
    待ちの試行をその場で中止するか、動いている試行の中止を求める。

  araya runner install
    runner（台帳の Task を取り込んで SHIKI を動かす常駐の process）を、systemd の user service（araya-runner-<hash>.service）として入れる。
    unit file を書き、有効にして起動し直す。linger は変えない（無効なら logout で runner が止まり、次に起動したときに続きから進む）。
    <dataDir>/config.json が無ければ、<dataDir>/pi/settings.json に defaultProvider と defaultModel が両方ある場合だけ model を初期設定する（thinkingLevel・認証情報は写さない）。
    既存 config は変更せず、default が足りなければ warning を出して続ける。npm run deploy もこの処理を行う。
    unit file に書く環境変数は PATH・LANG・LANGUAGE・TZ・LC_*・秘密を除いた ARAYA_* だけ。
    環境変数を変えたときは、やり直す（npm run deploy は、araya を入れた後にこれを実行する）。ARAYA_DATA_DIR を変えると別の runner になる
    （前の runner を残さないときは、先に前の ARAYA_DATA_DIR で araya runner uninstall を実行する）。

  araya runner uninstall
    runner の unit を止めて無効にし、unit file を消す。台帳は変えない（動いていた試行は、入れ直すと続きから進む）。

  araya discord init
    <ARAYA_DATA_DIR>/.env（既定: ~/.araya/.env）を mode 0600 で作る。既存 file は上書きしない。
  araya discord register
    slash command（/araya task list・show・submit・cancel・retry）を Discord の guild に登録する。.env または環境変数の設定が必要。
    1Password の op:// 参照を使う場合は、op run で解決してから実行する（README参照）。
  araya discord install [--auth-mode env-file|1password]
    Discord bot を常駐の process（araya-discord-<hash>.service）として入れる。unit file を書き、有効にして起動し直す。
    既定は平文 .env mode で、1Password CLI は使わない。1Password Service Account launcher を使う場合は --auth-mode 1password を明示する。
    Bot token は unit file・Environment=・bot process の起動引数に書かない。linger は変えない（無効なら logout で bot が止まる）。
  araya discord uninstall
    Discord bot の unit を止めて無効にし、unit file を消す。state.json・台帳は残す（入れ直すと cursor の続きから進む）。
    Discord 側の slash command 定義は残る（Discord 側で削除する）。
  araya discord run
    unit 稼働の確かめをせず、foreground で Discord bot を 1 度動かす（試験起動）。Ctrl+C で止める。
    1Password の op:// 参照を使う場合は op run で設定を解決してから実行する。

  araya runtime install
    既存の runner / Discord unit を1つの araya-runtime-<hash>.target で起動・停止する設定を入れて起動する。
    先に araya runner install と araya discord install を実行し、両 unit が runtime target に連動する状態にする。
    component service・ExecStart・Discord credential は変更しない。
  araya runtime uninstall
    runtime target だけを停止・無効化して削除する。runner / Discord service・台帳・設定・credential は残す。

  /araya task list: Task 一覧と runner の状態。/araya task show <task>: Task の詳細（SHIKI の要約と途中経過）。
  /araya task submit <title> <goal> [targets] [constraints] [permissions]: Task を登録する（targets・constraints・permissions はカンマ区切り）。
  /araya task cancel <task>: 中止を求める。/araya task retry <task> [note] [confirm_side_effects]: 終わった Task の再実行を求める。
  外部 branch・Draft PR が作成された可能性がある Task の retry は、confirm_side_effects を認めてから実行する。
  通知は Task 登録・再実行・中止・実行の開始・再開・終了と、SHIKI tool の開始・完了だけ ARAYA_DISCORD_CHANNEL_ID の既定送信先に出す。tool 通知に command や出力は含めない。
  slash command の受付 channel は絞らない。設定した Guild 内で、Discord 側が許可する channel から実行できる。

  araya task・runner・discord・runtime は Linux と systemd（254 以降）の user manager が必要。

設定ファイル:
  <ARAYA_DATA_DIR>/config.json（既定: ~/.araya/config.json）
    runner の SHIKI（開発の agent）の model と thinking level を指定する。task・runner command は起動時に1回だけ読み、
    runner は試行を取り込むたびに読む。

内蔵 Pi の設定:
  <ARAYA_DATA_DIR>/pi（既定: ~/.araya/pi）に settings.json・auth.json・models.json・models-store.json・sessions/・Pi SDK が管理する bin/ を置く。
  Pi SDK は ARAYA_CODING_AGENT_DIR を使う。
  araya 側で /login と /model を設定する。

環境変数:
  ARAYA_DATA_DIR
  ARAYA_DEV_ROOT
  ARAYA_DEVELOPMENT_TIMEOUT_MS
  ARAYA_VERIFICATION_TIMEOUT_MS
  ARAYA_DISCORD_APPLICATION_ID・ARAYA_DISCORD_GUILD_ID・ARAYA_DISCORD_CHANNEL_ID・ARAYA_DISCORD_BOT_TOKEN・ARAYA_DISCORD_ALLOWED_USER_IDS
    （Discord の設定。通常は araya discord init で作る <ARAYA_DATA_DIR>/.env（mode 0600）を使う。1Password の op:// 参照は任意）
`)
}

// この環境では araya task と araya runner を使えないことを表す誤りの code
const UNSUPPORTED_ENVIRONMENT_CODES = ['unsupported_platform', 'systemd_unavailable']
// その誤りの終了 code（sysexits.h の EX_UNAVAILABLE）。Node.js が自分の誤りに使う終了 code（14 以下、124、128 より大きい値）と重ならない。
// npm run deploy は、この終了 code のときに runner を入れずに成功で終わる
export const UNSUPPORTED_ENVIRONMENT_EXIT_CODE = 69

// CLI の誤りの終了 code。この環境では使えない誤りは UNSUPPORTED_ENVIRONMENT_EXIT_CODE、それ以外は 1
export function exitCodeOf(error: unknown) {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    UNSUPPORTED_ENVIRONMENT_CODES.includes(error.code)
  ) {
    return UNSUPPORTED_ENVIRONMENT_EXIT_CODE
  }

  return 1
}

async function loadCliConfig(env: NodeJS.ProcessEnv | undefined) {
  // task・runner command の開始時に一度だけ読み込む
  const baseConfig = loadConfig(env)
  const { developmentModel } = await loadConfigFile(baseConfig.configPath)

  return { ...baseConfig, developmentModel }
}

function defaultCommandDependencies(env: Readonly<Record<string, string | undefined>>) {
  const deps: RunnerCommandDependencies = {
    platform: process.platform,
    env,
    stdin: process.stdin,
    stdout: (text) => {
      return console.log(text)
    },
    stderr: (text) => {
      return console.error(text)
    },
    nowMs: () => {
      return Date.now()
    },
    createSystemdOps,
    nodePath: process.execPath,
    resolveRunnerEntrypoint: () => {
      return resolveRunnerEntrypoint()
    },
    homeDir: os.homedir(),
    uid: process.getuid?.() ?? -1,
    sleep: (ms) => {
      return new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    },
  }

  return deps
}

// env と taskDependencies は test 用。省略時は loadConfig が process.env を読む
export async function runCli(
  args: string[],
  startPi = launchPi,
  env?: NodeJS.ProcessEnv,
  taskDependencies: Partial<DiscordCommandDependencies> = {},
) {
  if (args.length === 0) {
    await startPi([], loadConfig(env).piAgentDir)
    return
  }

  if (args[0] === 'pi') {
    await startPi(args.slice(1), loadConfig(env).piAgentDir)
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

  if (args[0] === 'runtime') {
    assertSupportedPlatform(taskDependencies.platform ?? process.platform)
    const config = await loadCliConfig(env)
    const deps = { ...defaultCommandDependencies(config.env), ...taskDependencies }

    await runRuntimeCommand(args.slice(1), config, deps)

    return
  }

  // Discord の command も独自の option を持つので、共通の引数の解析より先に振り分ける
  if (args[0] === 'discord') {
    assertSupportedPlatform(taskDependencies.platform ?? process.platform)
    const config = await loadCliConfig(env)
    const deps: DiscordCommandDependencies = {
      ...defaultCommandDependencies(config.env),
      ...taskDependencies,
      resolveDiscordEnvRunnerEntrypoint:
        taskDependencies.resolveDiscordEnvRunnerEntrypoint ??
        (async () => {
          return resolveDiscordEnvRunnerEntrypoint()
        }),
      resolveDiscordOpRunnerEntrypoint:
        taskDependencies.resolveDiscordOpRunnerEntrypoint ??
        (async () => {
          return resolveDiscordOpRunnerEntrypoint()
        }),
      resolveOpCliPath:
        taskDependencies.resolveOpCliPath ??
        ((searchPath) => {
          return resolveOpCliPath(searchPath)
        }),
    }

    await runDiscordCommand(args.slice(1), config, deps)

    return
  }

  const { help, positionals } = parseCliArguments(args)
  const command = positionals[0] ?? 'help'

  if (help || command === 'help') {
    printHelp()
    return
  }

  printHelp()
  throw new Error(`不明な command: ${command}`)
}
