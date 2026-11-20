// Discord の message から会話 session と HOOT を操作する control command（Issue #33）。
// 人間の message を model に渡すのではなく、bot process の code が直接処理する。
// 実行待ち queue の外で走るので、会話の実行中・待ち状態でも常に効く
import { runHootCommand } from '../cli/hoot-commands.ts'

export type DiscordControlSend = (content: string) => Promise<void>

export type DiscordControlContext = {
  messageId: string
  // main conversation の durable id（session が未開なら null）
  conversationId: number | null
  runningCount: number
  queuedCount: number
  sessionAvailable: boolean
  // 応答は chat handler 側で redaction・分割・nonce 付きで channel に送る
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
  matches(content: string): boolean
  handle(content: string, context: DiscordControlContext): Promise<void>
}

export const DISCORD_CONTROL_USAGE = [
  'Discord control command:',
  '  help            … この一覧',
  '  status          … 会話 session と HOOT の状態（1 画面）',
  '  stop            … 実行中の submit と実行待ちの作業へ中止を要求',
  '  reset           … この channel の会話を作り直す（`session reset` でも同じ）',
  '  hoot status     … HOOT の状態（goal / proposal / inject queue / 歯止め）',
  '  hoot goal list  … goal 一覧（追加は hoot goal add --key <key> --objective "<目的>" [--scope github:owner/repo]）',
  '  hoot proposal list … 提案一覧',
  '  hoot dispatch --key <proposal key> … 承認済みの dispatch を main 会話へ inject する承認',
  '  hoot inject list … inject request の状態',
  '  hoot runs       … 判断 run の記録',
  '  hoot settings set --enabled true|false --mode dry_run|active --auto-dispatch true|false … 設定変更',
  '  hoot proposal resolve --key <key> / hoot reset-schedule',
  '（hoot の後は `araya hoot` と同じ引数で動きます。--data-dir は Discord からは指定できません）',
].join('\n')

// bot mention を落とした先頭がこれに一致する message だけ control plane に流す。
// help / status / stop / reset は message 全体が一致しなければ会話本文として model に渡す。
// `hoot` は予約 prefix（この語で始まる message は hoot の引数として解析する）
const SESSION_CONTROL_PATTERN = /^(?:help|status|stop|reset|session[ \t]+reset)$/iu
const HOOT_CONTROL_PATTERN = /^hoot(?=[ \t]|$)/iu

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// "..." / '...' を 1 引数として扱う。quote が閉じていなければ誤り
export function tokenizeDiscordArguments(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const character of text) {
    if (quote !== null) {
      if (character === quote) {
        quote = null
      } else {
        current += character
      }

      continue
    }

    if (character === '"' || character === "'") {
      quote = character

      continue
    }

    if (/\s/u.test(character)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }

      continue
    }

    current += character
  }

  if (quote !== null) {
    throw new Error('hoot_invalid_argument: quote を閉じてください')
  }

  if (current !== '') {
    tokens.push(current)
  }

  return tokens
}

export function createDiscordControlCommands(deps: DiscordControlDependencies): DiscordControlCommands {
  function matches(content: string) {
    const trimmed = content.trim()

    return SESSION_CONTROL_PATTERN.test(trimmed) || HOOT_CONTROL_PATTERN.test(trimmed)
  }

  // hoot の引数列を作る。--data-dir は bot process の dataDir だけを正とする
  function hootArgumentsOf(content: string) {
    const rest = content.trim().slice('hoot'.length).trim()

    if (rest.length > 1200) {
      throw new Error('hoot_invalid_argument: 長すぎます（1200 文字以内で送ってください）')
    }

    const args = tokenizeDiscordArguments(rest)

    if (args.some((arg) => arg === '--data-dir' || arg.startsWith('--data-dir='))) {
      throw new Error('hoot_invalid_argument: Discord からは --data-dir を指定できません（bot process の dataDir を使います）')
    }

    return args
  }

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

  async function handle(content: string, context: DiscordControlContext) {
    const trimmed = content.trim()
    const collapsed = trimmed.replace(/[ \t]+/gu, ' ').toLowerCase()

    if (collapsed === 'help') {
      deps.log({ type: 'discord_control_command', command: 'help' })
      await context.send(DISCORD_CONTROL_USAGE)

      return
    }

    if (collapsed === 'status') {
      deps.log({ type: 'discord_control_command', command: 'status' })
      const session =
        context.conversationId === null
          ? '会話 session は開けていません（agent session がありません）'
          : `会話: main conversation #${context.conversationId.toString()} / 実行中 ${context.runningCount.toString()} / 待ち ${context.queuedCount.toString()}`
      let hootText: string

      try {
        hootText = await runHoot(['status'])
      } catch (error) {
        deps.log({ type: 'discord_control_failed', command: 'status', message: errorMessage(error).slice(0, 500) })
        hootText = `HOOT の状態を読めませんでした: ${errorMessage(error)}`
      }

      await context.send(`${session}\n\n${hootText}`)

      return
    }

    if (collapsed === 'stop') {
      const cancelled = context.cancelQueued()
      const text = await context.stopSession()
      deps.log({ type: 'discord_control_command', command: 'stop', cancelled })
      await context.send(cancelled > 0 ? `${text}（実行待ち ${cancelled.toString()} 件を取り消しました）` : text)

      return
    }

    if (collapsed === 'reset' || collapsed === 'session reset') {
      const text = await context.resetSession(context.messageId)
      deps.log({ type: 'discord_control_command', command: 'reset' })
      await context.send(text)

      return
    }

    const args: string[] = []

    try {
      args.push(...hootArgumentsOf(trimmed))
    } catch (error) {
      deps.log({ type: 'discord_control_failed', command: 'hoot', message: errorMessage(error).slice(0, 500) })
      await context.send(`できませんでした: ${errorMessage(error)}`)

      return
    }

    let output: string

    try {
      output = await runHoot(args)
    } catch (error) {
      deps.log({
        type: 'discord_control_failed',
        command: `hoot ${args.join(' ')}`.slice(0, 200),
        message: errorMessage(error).slice(0, 500),
      })
      await context.send(`できませんでした: ${errorMessage(error)}`)

      return
    }

    deps.log({ type: 'discord_control_command', command: `hoot ${args.join(' ')}`.slice(0, 200) })
    await context.send(output === '' ? '出力はありません' : output)
  }

  return { matches, handle }
}
