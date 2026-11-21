// Discord の slash command 定義（Issue #33）。channel からの操作は message 解析ではなく
// slash command に統一する: 解析は Discord がやるので、bot 側は subcommand と option だけ受け取る。
// guild 登録は createDiscordGateway の registerCommands（application.commands.set）で行う。
// 型は discord.js の実行時 import を避けるため REST payload の形のまま手で書く。
// option type: 1 = SUB_COMMAND / 2 = SUB_COMMAND_GROUP / 3 = STRING / 4 = INTEGER / 5 = BOOLEAN

export const SLASH_SUB_COMMAND_TYPE = 1 as const
export const SLASH_SUB_COMMAND_GROUP_TYPE = 2 as const
export const SLASH_STRING_TYPE = 3 as const
export const SLASH_INTEGER_TYPE = 4 as const
export const SLASH_BOOLEAN_TYPE = 5 as const

// 会話 session を操作する command と、HOOT を操作する command の 2 本。
// Discord の subcommand は「group -> subcommand」の 2 段までなので `hoot goal add` は /hoot の group にした
export const ARAYA_COMMAND_NAMES = ['araya', 'hoot'] as const
export const SESSION_COMMAND_NAME = 'araya'
export const HOOT_COMMAND_NAME = 'hoot'

export type SlashOption = {
  name: string
  description: string
  type: number
  required?: boolean
  choices?: { name: string; value: string }[]
}

export type SlashSubCommand = {
  type: typeof SLASH_SUB_COMMAND_TYPE
  name: string
  description: string
  options?: SlashOption[]
}

export type SlashSubCommandGroup = {
  type: typeof SLASH_SUB_COMMAND_GROUP_TYPE
  name: string
  description: string
  options: SlashSubCommand[]
}

export type SlashCommand = {
  name: string
  description: string
  options: (SlashSubCommand | SlashSubCommandGroup)[]
}

function stringOption(name: string, description: string, required = false): SlashOption {
  return { name, description, type: SLASH_STRING_TYPE, required }
}

function booleanOption(name: string, description: string): SlashOption {
  return { name, description, type: SLASH_BOOLEAN_TYPE, required: false }
}

function integerOption(name: string, description: string): SlashOption {
  return { name, description, type: SLASH_INTEGER_TYPE, required: false }
}

function subcommand(name: string, description: string, options?: SlashOption[]): SlashSubCommand {
  return options === undefined
    ? { type: SLASH_SUB_COMMAND_TYPE, name, description }
    : { type: SLASH_SUB_COMMAND_TYPE, name, description, options }
}

// Discord の subcommand は 2 段まで（group -> subcommand）。hoot goal add は group 'goal' 配下にする
function group(name: string, description: string, options: SlashSubCommand[]): SlashSubCommandGroup {
  return { type: SLASH_SUB_COMMAND_GROUP_TYPE, name, description, options }
}

const GOAL_KEY_OPTION = stringOption('key', 'goal key（araya hoot goal list で見られる key）', true)
const GOAL_OBJECTIVE_OPTION = stringOption('objective', '目的（1 文。goal の objective）')
const GOAL_SCOPE_OPTION = stringOption('scope', '対象 scope。複数あるときは , で並べる（例: github:koh110/araya）')
const GOAL_CONSTRAINT_OPTION = stringOption('constraint', '制約。複数あるときは , で並べる')
const GOAL_REVIEW_AT_OPTION = stringOption('review-at', 'review 期限 YYYY-MM-DD、無制限なら none')

const SETTINGS_SET_OPTIONS: SlashOption[] = [
  booleanOption('enabled', 'HOOT loop を有効/無効にする'),
  {
    name: 'mode',
    description: 'inject gate の mode（dry_run は提案のみ）',
    type: SLASH_STRING_TYPE,
    required: false,
    choices: [
      { name: 'dry_run（提案のみ・実行しない）', value: 'dry_run' },
      { name: 'active（承認済み dispatch を inject する）', value: 'active' },
    ],
  },
  integerOption('tick-minutes', 'poll 間隔（分）'),
  integerOption('max-runs-per-day', '1 UTC 日の model 判断 run 上限'),
  stringOption('notify-decisions', '即時通知する decision。, で並べる（noop,wait,investigate,dispatch,request_human,invalid）'),
  booleanOption('precheck', '観測 fingerprint が同じ occurrence で model を呼ばない precheck'),
  integerOption('watchdog-hours', 'この時間内に 1 回 model で全体を見る（watchdog）'),
  stringOption('digest-hour-utc', 'digest を送る UTC 時（0-23）、出さないなら none'),
  integerOption('reset-conversation-after-runs', 'この回数 run を重ねた会話 session を作り直す'),
  integerOption('goal-review-days', '新しい goal の review 期限（日）'),
  integerOption('proposal-ttl-hours', 'open proposal の期限（時間）'),
  integerOption('max-proposal-reminders', 'open proposal の再提醒の上限（回）'),
  booleanOption('auto-dispatch', 'mode=active のとき dispatch を自動 inject する'),
  booleanOption(
    'conversation-read',
    'true で HOOT 判断 run に main 会話 transcript を読む read-only tool が入る（既定 false）'
  ),
  integerOption('max-injects-per-day', '1 UTC 日の inject 上限（人間の承認も含む）'),
  integerOption('inject-cooldown-minutes', 'inject 同士の間隔（分）'),
]

export const SESSION_COMMAND: SlashCommand = {
  name: SESSION_COMMAND_NAME,
  description: 'Araya の会話 session を操作する（実行中・待ちでも効く。model には渡さない）',
  options: [
    subcommand('status', '会話 session と HOOT の状態を 1 画面で返す'),
    subcommand('stop', '実行中の submit と実行待ちの依頼へ中止を要求する'),
    subcommand('reset', 'この channel の会話 session を作り直す（inject 済みの文脈も切れる）'),
    subcommand('help', 'command 一覧と HOOT の使い方を返す'),
  ],
}

export const HOOT_COMMAND: SlashCommand = {
  name: HOOT_COMMAND_NAME,
  description: 'HOOT（課題発見 loop）を人間が操作する（承認・goal・設定・提案・inject queue）',
  options: [
    subcommand('status', 'HOOT の状態（goal / proposal / inject queue / 歯止め）'),
    subcommand('dispatch', '承認済みの dispatch を main Discord 会話へ inject する承認', [
      stringOption('key', 'proposal key（araya hoot proposal list / digest に出る key）', true),
    ]),
    subcommand('runs', '判断 run の記録（直近）'),
    group('inject', 'inject request を操作・一覧する', [
      subcommand('list', 'inject request を直近 20 件、新しい順に出す'),
    ]),
    group('goal', 'goal を追加・変更・停止する', [
      subcommand('list', 'goal 一覧'),
      subcommand('add', 'goal を追加する', [
        GOAL_KEY_OPTION,
        { ...GOAL_OBJECTIVE_OPTION, required: true },
        GOAL_SCOPE_OPTION,
        GOAL_CONSTRAINT_OPTION,
        GOAL_REVIEW_AT_OPTION,
      ]),
      subcommand('update', 'goal を更新する（未指定の field は現状維持）', [
        GOAL_KEY_OPTION,
        GOAL_OBJECTIVE_OPTION,
        GOAL_SCOPE_OPTION,
        GOAL_CONSTRAINT_OPTION,
        GOAL_REVIEW_AT_OPTION,
      ]),
      subcommand('pause', 'goal を paused にする', [GOAL_KEY_OPTION]),
      subcommand('resume', 'goal を active に戻す', [GOAL_KEY_OPTION]),
      subcommand('retire', 'goal を retired にする', [GOAL_KEY_OPTION]),
    ]),
    group('settings', 'HOOT の設定を見る・変更する', [
      subcommand('show', '現在の settings'),
      subcommand('set', 'settings を変更する（指定した field だけ変わる）', SETTINGS_SET_OPTIONS),
    ]),
    group('proposal', '提案を見る・解決済みにする', [
      subcommand('list', 'open な proposal 一覧'),
      subcommand('resolve', 'proposal を resolved にする', [
        stringOption('key', 'proposal key', true),
      ]),
    ]),
    subcommand('reset-schedule', 'schedule だけ戻す（run 記録・settings・proposals・inject request は保つ）'),
  ],
}

export const ARAYA_SLASH_COMMANDS: SlashCommand[] = [SESSION_COMMAND, HOOT_COMMAND]

// task 機構の撤去後に返す案内（古い guild 定義を残している人向けの静的 text）
export const REMOVED_COMMAND_REPLY =
  'araya の task 機構（/araya task ...）は撤去しました。会話は channel の message で、操作は /araya status・/araya stop・/araya reset・/hoot ... の slash command でお願いします'

// 撤去済みの subcommand 名（guild に古い定義が残っている場合に分かる形での案内を返す）
export const REMOVED_TASK_SUBCOMMANDS = ['task', 'spawn', 'watch', 'submit', 'cancel', 'retry', 'list', 'show'] as const

// 登録済み command 名かどうか（未知の name の interaction は無視する）
export function isArayaCommandName(name: string) {
  return (ARAYA_COMMAND_NAMES as readonly string[]).includes(name.toLowerCase())
}

// Discord の subcommand name は `[a-z0-9_-]{1,32}`。定義が壊れていない startup 時に確かめる
export function validateArayaSlashCommands(commands: readonly SlashCommand[]): string[] {
  const problems: string[] = []
  const namePattern = /^[a-z0-9_-]{1,32}$/u

  for (const command of commands) {
    if (!namePattern.test(command.name)) {
      problems.push(`command name が不正: ${command.name}`)
    }

    if (command.description.length === 0 || command.description.length > 100) {
      problems.push(`command description が不正: ${command.name}`)
    }

    if (command.options.length > 25) {
      problems.push(`${command.name} の subcommand が 25 件を超えています`)
    }

    for (const entry of command.options) {
      if (!namePattern.test(entry.name)) {
        problems.push(`subcommand name が不正: ${command.name} ${entry.name}`)
      }

      if (entry.type === SLASH_SUB_COMMAND_GROUP_TYPE) {
        if (entry.options.length > 25) {
          problems.push(`${command.name} ${entry.name} の subcommand が 25 件を超えています`)
        }

        for (const option of entry.options) {
          if (option.type !== SLASH_SUB_COMMAND_TYPE) {
            problems.push(`${command.name} ${entry.name} の下に subcommand 以外があります`)
          }

          validateOptions(`${command.name} ${entry.name} ${option.name}`, option.options ?? [], problems)
        }

        continue
      }

      validateOptions(`${command.name} ${entry.name}`, entry.options ?? [], problems)
    }
  }

  return problems
}

function validateOptions(where: string, options: readonly SlashOption[], problems: string[]) {
  const namePattern = /^[a-z0-9_-]{1,32}$/u

  if (options.length > 25) {
    problems.push(`${where} の option が 25 件を超えています`)
  }

  for (const option of options) {
    if (!namePattern.test(option.name)) {
      problems.push(`option name が不正: ${where} ${option.name}`)
    }

    if (option.description.length === 0 || option.description.length > 100) {
      problems.push(`option description が不正: ${where} ${option.name}`)
    }

    if (option.type !== SLASH_STRING_TYPE && option.type !== SLASH_INTEGER_TYPE && option.type !== SLASH_BOOLEAN_TYPE) {
      problems.push(`option type が不正: ${where} ${option.name}`)
    }
  }
}
