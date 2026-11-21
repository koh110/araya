// Discord の slash command から会話 session と HOOT を操作する control plane（Issue #33）。
// channel からの操作は slash command に統一する（message 解析はしない。解析は Discord が行う）。
// interaction は queue の外で処理するので、会話の実行中・待ち状態でも常に効く。
// 人間の interaction だけがこの function 群に到達するので、HOOT の承認は agent 経由ではない
import { runHootCommand } from '../cli/hoot-commands.ts'
import { HOOT_COMMAND_NAME, REMOVED_COMMAND_REPLY, REMOVED_TASK_SUBCOMMANDS, SESSION_COMMAND_NAME } from './slash.ts'
import type { DiscordCommandRequest } from './gateway.ts'

export type DiscordControlSend = (content: string) => Promise<void>

export type DiscordControlContext = {
  // main conversation の durable id（session が未開なら null）
  conversationId: number | null
  runningCount: number
  queuedCount: number
  sessionAvailable: boolean
  // 応答は chat handler 側で redaction・分割して ephemeral に送る
  send: DiscordControlSend
  // 受付済みで未開始の message を無効化し、件数を返す
  cancelQueued(): number
  stopSession(): Promise<string>
  resetSession(requestId: string): Promise<string>
}

export type DiscordControlDependencies = {
  dataDir: string
  nowMs(): number
  log(entry: Record<string, unknown>): void
}

export type DiscordControlCommands = {
  handle(request: DiscordCommandRequest, context: DiscordControlContext): Promise<void>
}

export const DISCORD_CONTROL_USAGE = [
  'Discord slash command（ephemeral であなただけに見えます。text message はそのまま会話として model に渡ります）:',
  '  /araya status  … 会話 session と HOOT の状態（1 画面）',
  '  /araya stop    … 実行中の submit と実行待ちの依頼へ中止を要求',
  '  /araya reset   … この channel の会話を作り直す（inject 済みの文脈も切れる）',
  '  /araya help    … この一覧',
  '  /hoot status   … HOOT の状態（goal / proposal / inject queue / 歯止め）',
  '  /hoot dispatch key:<proposal key> … 承認済みの dispatch を main 会話へ inject する承認',
  '  /hoot inject list … inject request の状態',
  '  /hoot runs     … 判断 run の記録',
  '  /hoot goal list / pause / resume / retire key:<key> … goal の一覧と status 変更',
  '  /hoot goal add key:<key> objective:<1 文> [scope:github:owner/repo,...] [constraint:...] [review-at:YYYY-MM-DD|none]',
  '  /hoot goal update key:<key> … 指定した field だけ更新（未指定は現状維持）',
  '  /hoot proposal list / resolve key:<key> … 提案の一覧と解決済み化',
  '  /hoot settings show / set … 設定（enabled・mode・auto-dispatch・max-injects-per-day・inject-cooldown-minutes など）',
  '  /hoot reset-schedule … schedule だけ戻す（run 記録・settings・proposals・inject request は保つ）',
  '（HOOT の承認・goal・設定の変更は人間専用です。agent session の内側から araya hoot の書き込み command は拒否されます）',
].join('\n')

// hoot command の option を CLI の引数配列へ変換する対応表。Discord 側は option 名だけを渡す
const HOOT_TOP_SUBCOMMANDS = new Set(['status', 'dispatch', 'runs', 'reset-schedule'])
const HOOT_GOAL_SUBCOMMANDS = new Set(['list', 'add', 'update', 'pause', 'resume', 'retire'])
const HOOT_SETTINGS_SUBCOMMANDS = new Set(['show', 'set'])
const HOOT_PROPOSAL_SUBCOMMANDS = new Set(['list', 'resolve'])
const HOOT_INJECT_SUBCOMMANDS = new Set(['list'])
const HOOT_SETTINGS_FLAGS = [
  'enabled',
  'mode',
  'tick-minutes',
  'max-runs-per-day',
  'notify-decisions',
  'precheck',
  'watchdog-hours',
  'digest-hour-utc',
  'reset-conversation-after-runs',
  'goal-review-days',
  'proposal-ttl-hours',
  'max-proposal-reminders',
  'auto-dispatch',
  'max-injects-per-day',
  'inject-cooldown-minutes',
] as const

const MAX_CONTROL_ARGUMENT_CHARS = 4_000

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function invalid(message: string) {
  return new Error(`hoot_invalid_argument: ${message}`)
}

function optionValue(options: DiscordCommandRequest['options'], name: string) {
  const value = options[name]

  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  return String(value)
}

function requiredOptionValue(options: DiscordCommandRequest['options'], name: string, where: string) {
  const value = optionValue(options, name)

  if (value === undefined || value.trim() === '') {
    throw invalid(`${where} は ${name} が必要です`)
  }

  return value
}

function pushFlag(args: string[], options: DiscordCommandRequest['options'], name: string) {
  const value = optionValue(options, name)

  if (value === undefined) {
    return
  }

  args.push(`--${name}`, value)
}

// Discord の option を `araya hoot` と同じ引数列にする。--data-dir は Discord からは渡れない
// （option 定義に無いが、万一来ても拒否して bot process の dataDir を正とする）
export function hootArgumentsOf(request: DiscordCommandRequest): string[] {
  const options = request.options ?? {}

  if (optionValue(options, 'data-dir') !== undefined) {
    throw invalid('Discord から --data-dir は指定できません（bot process の dataDir を使います）')
  }

  const group = (request.subcommandGroup ?? '').toLowerCase()
  const subcommand = (request.subcommand ?? '').toLowerCase()

  if (group === '') {
    if (!HOOT_TOP_SUBCOMMANDS.has(subcommand)) {
      throw invalid(`/hoot ${subcommand} は知りません（/araya help で一覧）`)
    }

    if (subcommand === 'dispatch') {
      return ['dispatch', '--key', requiredOptionValue(options, 'key', '/hoot dispatch')]
    }

    return [subcommand]
  }

  if (group === 'goal') {
    if (!HOOT_GOAL_SUBCOMMANDS.has(subcommand)) {
      throw invalid(`/hoot goal ${subcommand} は知りません（list / add / update / pause / resume / retire）`)
    }

    const args = ['goal', subcommand]

    if (subcommand === 'list') {
      return args
    }

    args.push('--key', requiredOptionValue(options, 'key', `/hoot goal ${subcommand}`))

    if (subcommand === 'add' || subcommand === 'update') {
      if (subcommand === 'add') {
        args.push('--objective', requiredOptionValue(options, 'objective', '/hoot goal add'))
      } else {
        pushFlag(args, options, 'objective')
      }

      pushFlag(args, options, 'scope')
      pushFlag(args, options, 'constraint')
      pushFlag(args, options, 'review-at')
    }

    return args
  }

  if (group === 'settings') {
    if (!HOOT_SETTINGS_SUBCOMMANDS.has(subcommand)) {
      throw invalid(`/hoot settings ${subcommand} は知りません（show / set）`)
    }

    const args = ['settings', subcommand]

    if (subcommand === 'show') {
      return args
    }

    for (const flag of HOOT_SETTINGS_FLAGS) {
      pushFlag(args, options, flag)
    }

    if (args.length === 2) {
      throw invalid('/hoot settings set は 1 つ以上の field が必要です')
    }

    return args
  }

  if (group === 'proposal') {
    if (!HOOT_PROPOSAL_SUBCOMMANDS.has(subcommand)) {
      throw invalid(`/hoot proposal ${subcommand} は知りません（list / resolve）`)
    }

    const args = ['proposal', subcommand]

    if (subcommand === 'resolve') {
      args.push('--key', requiredOptionValue(options, 'key', '/hoot proposal resolve'))
    }

    return args
  }

  if (group === 'inject') {
    if (!HOOT_INJECT_SUBCOMMANDS.has(subcommand)) {
      throw invalid(`/hoot inject ${subcommand} は知りません（list）`)
    }

    return ['inject', 'list']
  }

  throw invalid(`/hoot ${group} は知りません（/araya help で一覧）`)
}

export function createDiscordControlCommands(deps: DiscordControlDependencies): DiscordControlCommands {
  async function runHoot(args: readonly string[]) {
    const lines: string[] = []

    await runHootCommand(args, {
      dataDir: deps.dataDir,
      stdout: (text) => {
        lines.push(text)
      },
      nowMs: deps.nowMs,
    })

    return lines.join('\n')
  }

  function commandLabel(request: DiscordCommandRequest) {
    const group = request.subcommandGroup ?? ''
    const subcommand = request.subcommand ?? ''

    return `${request.commandName} ${group} ${subcommand}`.replace(/\s+/gu, ' ').trim().slice(0, 200)
  }

  async function handle(request: DiscordCommandRequest, context: DiscordControlContext) {
    const commandName = (request.commandName ?? '').toLowerCase()
    const subcommand = (request.subcommand ?? '').toLowerCase()

    if (commandName === SESSION_COMMAND_NAME) {
      // guild に古い /araya task ... の定義が残っている人へは、打った subcommand を示す撤去案内を返す
      if ((request.subcommandGroup ?? '').toLowerCase() === 'task' || (REMOVED_TASK_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
        deps.log({ type: 'discord_control_command', command: `araya (removed) ${subcommand}` })
        await context.send(REMOVED_COMMAND_REPLY)

        return
      }

      if (subcommand === 'help') {
        deps.log({ type: 'discord_control_command', command: 'araya help' })
        await context.send(DISCORD_CONTROL_USAGE)

        return
      }

      if (subcommand === 'status') {
        deps.log({ type: 'discord_control_command', command: 'araya status' })
        const session =
          context.conversationId === null
            ? '会話 session は開けていません（agent session がありません）'
            : `会話: main conversation #${context.conversationId.toString()} / 実行中 ${context.runningCount.toString()} / 待ち ${context.queuedCount.toString()}`
        let hootText: string

        try {
          hootText = await runHoot(['status'])
        } catch (error) {
          deps.log({ type: 'discord_control_failed', command: 'araya status', message: errorMessage(error).slice(0, 500) })
          hootText = `HOOT の状態を読めませんでした: ${errorMessage(error)}`
        }

        await context.send(`${session}\n\n${hootText}`)

        return
      }

      if (subcommand === 'stop') {
        const cancelled = context.cancelQueued()
        const text = await context.stopSession()
        deps.log({ type: 'discord_control_command', command: 'araya stop', cancelled })
        await context.send(cancelled > 0 ? `${text}（実行待ち ${cancelled.toString()} 件を取り消しました）` : text)

        return
      }

      if (subcommand === 'reset') {
        // interaction id を durable submit の requestId にする（同じ interaction を繰り返さない）
        const text = await context.resetSession(request.interactionId)
        deps.log({ type: 'discord_control_command', command: 'araya reset' })
        await context.send(text)

        return
      }

      deps.log({ type: 'discord_control_failed', command: `araya ${subcommand}` })
      await context.send(`できませんでした: /araya ${subcommand} は知りません（/araya help で一覧）`)

      return
    }

    if (commandName !== HOOT_COMMAND_NAME) {
      deps.log({ type: 'discord_control_failed', command: commandName.slice(0, 200) })
      await context.send('できませんでした: /araya か /hoot を使ってください')

      return
    }

    const label = commandLabel(request)
    let args: string[]

    try {
      args = hootArgumentsOf(request)
    } catch (error) {
      deps.log({ type: 'discord_control_failed', command: label, message: errorMessage(error).slice(0, 500) })
      await context.send(`できませんでした: ${errorMessage(error)}`)

      return
    }

    if (args.join(' ').length > MAX_CONTROL_ARGUMENT_CHARS) {
      deps.log({ type: 'discord_control_failed', command: label, message: 'too_long' })
      await context.send('できませんでした: 入力が長すぎます')

      return
    }

    let output: string

    try {
      output = await runHoot(args)
    } catch (error) {
      deps.log({
        type: 'discord_control_failed',
        command: label,
        message: errorMessage(error).slice(0, 500),
      })
      await context.send(`できませんでした: ${errorMessage(error)}`)

      return
    }

    deps.log({ type: 'discord_control_command', command: label, args: args.join(' ').slice(0, 200) })
    await context.send(output === '' ? '出力はありません' : output)
  }

  return { handle }
}
