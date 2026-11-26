import os from 'node:os'

import { parseCliArguments } from './arguments.ts'
import { loadConfig, loadPiSdk, withPiEnvironment } from '../config/environment.ts'
import { runHootCommand } from './hoot-commands.ts'
import { CLI_CONTROL_SUBCOMMANDS, runControlCommand } from './control-commands.ts'
import {
  createSystemdOps,
  resolveDiscordEnvRunnerEntrypoint,
  resolveDiscordOpRunnerEntrypoint,
  resolveOpCliPath,
} from '../infrastructure/systemd.ts'
import { assertSupportedPlatform, type CliCommandDependencies } from './command-support.ts'
import { runDiscordCommand, type DiscordCommandDependencies } from './discord-commands.ts'

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

  araya discord init
    <ARAYA_DATA_DIR>/.env（既定: ~/.araya/.env）を mode 0600 で作る。既存 file は上書きしない。
  araya discord install [--auth-mode env-file|1password]
    Discord bot を常駐の process（araya-discord-<hash>.service）として入れる。unit file を書き、有効にして起動し直す。
    既定は平文 .env mode で、1Password CLI は使わない。1Password Service Account launcher を使う場合は --auth-mode 1password を明示する。
    Bot token は unit file・Environment=・bot process の起動引数に書かない。linger は変えない（無効なら bot が止まる）。
  araya discord uninstall
    Discord bot の unit を止めて無効にし、unit file を消す。state.json と agent session の SQLite（<ARAYA_DATA_DIR>/agent/）は残す。
    Discord 側の slash command 定義は残る（Discord 側で削除する）。
  araya discord run
    unit 稼働の確かめをせず、foreground で Discord bot を 1 度動かす（試験起動）。Ctrl+C で止める。
    1Password の op:// 参照を使う場合は op run で設定を解決してから実行する。
  araya discord status
    unit の稼働状態を読むだけ（unit file の有無・ActiveState / SubState・restart 回数・last ready・state file の path）。
    token は読みません。bot が応答しないときの最初の確かめに使う。

  araya status | stop | reset
    Discord の slash command /araya status・stop・reset と同じ operation（bot process 内の同じ kernel を呼ぶ）。
    会話 session を操作できるのは稼働中の bot だけなので、要求は <ARAYA_DATA_DIR>/control/requests/ に書き、
    bot が次の poll（既定 1 秒）で実行して <ARAYA_DATA_DIR>/control/results/ に応答を書く。
    [--wait-seconds N]（既定 30、上限 120）。bot が応答しないときは araya discord status で稼働を確かめる。
    境界は <ARAYA_DATA_DIR> の control dir を書ける OS user（bot process と同じ user なら agent の shell からも叩ける）。

  Discord slash command と CLI の対応（HOOT は subcommand・option 名まで同じ。slash 側は -- を使わない）:
    /araya status・stop・reset                       = araya status・stop・reset
    /araya help                                       = araya --help（この一覧）
    /hoot status・runs・reset-schedule               = araya hoot status・runs・reset-schedule
    /hoot inject list                                = araya hoot inject list
    /hoot dispatch key:<key>                          = araya hoot dispatch --key <key>
    /hoot goal list・add・update・pause・resume・retire  = araya hoot goal …（--key --objective --scope --constraint --review-at）
    /hoot settings show・set                           = araya hoot settings show・set（16 の field 名が同じ）
    /hoot proposal list・resolve key:<key>            = araya hoot proposal list・resolve --key <key>
    araya discord init・install・uninstall・run・status は CLI 専用（unit・token を触る操作を Discord からは叩かない）
    araya hoot evidence は CLI 専用（delivery 後の観測差。Discord の slash にはまだ無い。follow-up）
    --data-dir は CLI だけ（Discord 側は bot process の dataDir だけを正とする）

  会話: 設定 channel に発言すると agent session が応答する。agent が report delivery を依頼した送信依頼は、
  設定 channel へ届くまで再送される。task ledger・runner・/araya task slash command は撤去済み。
  古い slash command 定義が残っている guild では、実行すると「撤去されました」の応答だけ返る。Discord 側で削除してください。

  araya discord は Linux と systemd（254 以降）の user manager が必要。

  araya hoot status
    HOOT（Human Out of the Loop）の goal・settings・schedule・直近の判断 run・open な proposal を表示する。
  araya hoot goal list | add | update | pause | resume | retire
    目的（goal）の一覧と変更。add / update は --key <key> --objective "<目的>" [--scope github:owner/repo,...] [--constraint "<制約>",...]
    [--review-at <YYYY-MM-DD|ISO datetime|none>]（goal の review 期限。過ぎた active goal は model を呼ばず自動 paused になる）
  araya hoot settings show | set
    動作設定の表示・変更。set は [--enabled true|false] [--tick-minutes N] [--max-runs-per-day N] [--notify-decisions a,b,c]
    [--precheck true|false] [--watchdog-hours N] [--digest-hour-utc N|none] [--reset-conversation-after-runs N]
    [--goal-review-days N] [--proposal-ttl-hours N] [--max-proposal-reminders N]
    [--auto-dispatch true|false] [--max-injects-per-day N] [--inject-cooldown-minutes N]
    [--conversation-read true|false]（true で HOOT 判断 run に main Discord 会話の transcript を読む read-only tool が入る。既定 false）
    mode は既定 dry_run（判断の記録だけ。作業は実行しない）。mode=active は「承認済みの dispatch proposal を main Discord 会話へ
    inject してよい」という gate で、autoDispatch（既定 false）を true にしたときだけ HOOT 自身の判断で inject します。
  araya hoot dispatch --key <proposal key>
    proposal list の key を人間が承認して、main Discord 会話へ流す inject request を作る（bot process の次の poll で届く）。
    inject してよい decision は dispatch / investigate（investigate は main 会話の read-only 調査案件になる）。dry_run では作りません。mode=active でも autoDispatch=false ならこの command が承認です。
  araya hoot inject list
    inject request（pending / injected / failed）を新しい順に表示する。失敗が重なったら proposal list で作り直す。
  araya hoot proposal list | resolve --key <key>
    人間の応答を待つ未解決の提案（investigate / dispatch / request_human）の一覧と解決。期限切れは expired になります。
  araya hoot evidence
    main 会話に渡した案件（delivery）の前後で GitHub の open list がどう変わったかを、state file の観測 snapshot から
    決定的に計算して表示する（read-only。closed / merged の区別は観測しておらず、goal の status は変更しません）。
    観測 snapshot は直近 8 occurrence、goal に出す delivery は直近 3 件まで。
  araya hoot runs [--limit N]
    判断 run の記録（decision と reason、source は model / precheck）を新しい順に表示する。
  araya hoot reset-schedule
    schedule をリセットする（次の tick が次の occurrence になる）。
  araya hoot <command> [--data-dir <path>]
    state file を読む data directory を明示する。未指定なら稼働中 bot と同じ resolution（ARAYA_DATA_DIR /
    config file）で <ARAYA_DATA_DIR>/hoot/state.json を見る。明示指定したときだけ別の file を指す（state
    復旧作業で unit を stop した file を確かめる用途など）。

  HOOT は <ARAYA_DATA_DIR>/hoot/state.json（version 5。version 1〜4 は読み取り時に migration します）を使い、Discord bot process の loop が
  interval ごとに tick します。enabled=false または active goal が無ければ model も gh も呼びません。判断 run は tool を持たない専用の
  会話で走り、観測は Araya の code が gh の read-only command で集めます。観測 fingerprint が前回と同じ occurrence では model を呼ばず
  noop を記録し、観測に gap が 1 件でもある occurrence では precheck せず model を呼びます。watchdogHours 以内に 1 回は model で全体を
  見ます。即時の Discord 通知は notifyDecisions（既定 request_human / invalid）だけで、他は UTC 1 日 1 回の digest にまとめます
  （digest には open proposal の key も出るので proposal resolve --key の key はそこから使えます）。inject は人間の message と同じ queue で
  main 会話に submit し、届いたことは Discord の message にも出ます（HOOT 判断 run 自体は tool を持たない）。

設定ファイル:
  <ARAYA_DATA_DIR>/config.json（既定: ~/.araya/config.json）
    agent session の model と thinking level を指定する。起動時に 1 回読む。

内蔵 Pi の設定:
  <ARAYA_DATA_DIR>/pi（既定: ~/.araya/pi）に settings.json・auth.json・models.json・models-store.json・sessions/・Pi SDK が管理する bin/ を置く。
  Pi SDK は ARAYA_CODING_AGENT_DIR を使う。
  araya 側で /login と /model を設定する。

環境変数:
  ARAYA_DATA_DIR
  ARAYA_DEV_ROOT
  ARAYA_DISCORD_APPLICATION_ID・ARAYA_DISCORD_GUILD_ID・ARAYA_DISCORD_CHANNEL_ID・ARAYA_DISCORD_BOT_TOKEN・ARAYA_DISCORD_ALLOWED_USER_IDS
    （Discord の設定。通常は araya discord init で作る <ARAYA_DATA_DIR>/.env（mode 0600）を使う。1Password の op:// 参照は任意）
`)
}

// この環境では araya discord を unit として使えないことを表す誤りの code
const UNSUPPORTED_ENVIRONMENT_CODES = ['unsupported_platform', 'systemd_unavailable']
// その誤りの終了 code（sysexits.h の EX_UNAVAILABLE）。Node.js が自分の誤りに使う終了 code（14 以下、124、128 より大きい値）と重ならない。
// npm run deploy は、この終了 code のときに Discord bot の unit を入れずに成功で終わる
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

function defaultCommandDependencies(env: Readonly<Record<string, string | undefined>>) {
  const deps: CliCommandDependencies = {
    platform: process.platform,
    env,
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

// env と commandDependencies は test 用。省略時は loadConfig が process.env を読む
export async function runCli(
  args: string[],
  startPi = launchPi,
  env?: NodeJS.ProcessEnv,
  commandDependencies: Partial<DiscordCommandDependencies> = {},
) {
  if (args.length === 0) {
    await startPi([], loadConfig(env).piAgentDir)
    return
  }

  if (args[0] === 'pi') {
    await startPi(args.slice(1), loadConfig(env).piAgentDir)
    return
  }

  // Discord の command は独自の option を持つので、共通の引数の解析より先に振り分ける
  if (args[0] === 'discord') {
    if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
      printHelp()

      return
    }

    assertSupportedPlatform(commandDependencies.platform ?? process.platform)
    const config = loadConfig(env)
    const deps: DiscordCommandDependencies = {
      ...defaultCommandDependencies(config.env),
      ...commandDependencies,
      resolveDiscordEnvRunnerEntrypoint:
        commandDependencies.resolveDiscordEnvRunnerEntrypoint ??
        (async () => {
          return resolveDiscordEnvRunnerEntrypoint()
        }),
      resolveDiscordOpRunnerEntrypoint:
        commandDependencies.resolveDiscordOpRunnerEntrypoint ??
        (async () => {
          return resolveDiscordOpRunnerEntrypoint()
        }),
      resolveOpCliPath:
        commandDependencies.resolveOpCliPath ??
        ((searchPath) => {
          return resolveOpCliPath(searchPath)
        }),
    }

    await runDiscordCommand(args.slice(1), config, deps)

    return
  }

  // Discord の slash command と同じ operation を CLI にも置く（araya status・stop・reset）。
  // 会話 session を操作するのは bot process なので、要求は file の control request で渡す
  if ((CLI_CONTROL_SUBCOMMANDS as readonly string[]).includes(args[0] ?? '')) {
    if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
      printHelp()

      return
    }

    const controlConfig = loadConfig(env)
    await runControlCommand(args, {
      dataDir: controlConfig.dataDir,
      stdout: (text) => {
        return console.log(text)
      },
      nowMs: () => {
        return Date.now()
      },
      env: env ?? process.env,
    })

    return
  }

  // HOOT の command も独自の option を持つので、共通の引数の解析より先に振り分ける
  if (args[0] === 'hoot') {
    const hootArgs = args.slice(1)

    if (hootArgs.includes('--help') || hootArgs.includes('-h')) {
      printHelp()

      return
    }

    const config = loadConfig(env)
    await runHootCommand(hootArgs, {
      dataDir: config.dataDir,
      stdout: (text) => {
        return console.log(text)
      },
      nowMs: () => {
        return Date.now()
      },
    })

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
