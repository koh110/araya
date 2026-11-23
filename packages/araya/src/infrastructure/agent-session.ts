// agent session の shell だけに置く目印（Issue #33）。
// main 会話の agent は bash tool を持つので、放置すると `araya hoot dispatch` を自分で実行して
// 自己承認できてしまう。HOOT の承認・設定変更は人間の CLI か Discord の control command からだけにする
export const ARAYA_AGENT_SESSION_ENV = 'ARAYA_AGENT_SESSION'

export type HootInvocationCommand = {
  command: string
  subcommand: string | undefined
}

// agent から実行を止める hoot command（読み取りは allows）
const AGENT_BLOCKED: { command: string; blockSubcommands: readonly string[] | null }[] = [
  { command: 'dispatch', blockSubcommands: null },
  { command: 'reset-schedule', blockSubcommands: null },
  { command: 'settings', blockSubcommands: ['set'] },
  { command: 'goal', blockSubcommands: ['add', 'update', 'pause', 'resume', 'retire'] },
  { command: 'proposal', blockSubcommands: ['resolve'] },
]

export function agentSessionShellEnv(): Record<string, string> {
  return { [ARAYA_AGENT_SESSION_ENV]: '1' }
}

export function isInAgentSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[ARAYA_AGENT_SESSION_ENV] === '1'
}

// parseHootArguments と同じ規則で positional だけを取り出す（--key の値を subcommand と取り違えない）
export function hootPositionalsOf(args: readonly string[]): string[] {
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''

    if (arg.startsWith('--')) {
      const value = args[index + 1]

      if (value !== undefined && !value.startsWith('--')) {
        index += 1
      }

      continue
    }

    positionals.push(arg)
  }

  return positionals
}

export function hootInvocationCommandOf(args: readonly string[]): HootInvocationCommand {
  const positionals = hootPositionalsOf(args)

  return {
    command: positionals[0] ?? 'status',
    subcommand: positionals[1],
  }
}

export function isAgentBlockedHootInvocation(args: readonly string[]): boolean {
  const { command, subcommand } = hootInvocationCommandOf(args)

  return AGENT_BLOCKED.some((entry) => {
    if (entry.command !== command) {
      return false
    }

    // subcommand を持つ command は「書き込みだけ」止める（goal list / proposal list / settings show は allowed）
    return entry.blockSubcommands === null || (subcommand !== undefined && entry.blockSubcommands.includes(subcommand))
  })
}

export function assertHumanHootInvocation(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (!isInAgentSession(env) || !isAgentBlockedHootInvocation(args)) {
    return
  }

  const { command, subcommand } = hootInvocationCommandOf(args)
  const name = subcommand === undefined ? command : `${command} ${subcommand}`

  throw new Error(
    `hoot_agent_session_blocked: agent session の内側で araya hoot ${name} は実行できません。人間の shell の CLI か Discord の slash command（/hoot ${name}）で実行してください`,
  )
}

// 会話 control（/araya status・stop・reset に対応する CLI 入口）。status は読み取りなので allowed、
// stop / reset は会話 session を壊すので人間専用（agent が自分の会話を止めたり文脈を切れないようにする）。
// command 名の一覧そのものは src/infrastructure/control-bus.ts が持つ
const AGENT_BLOCKED_CONTROL_COMMANDS = ['stop', 'reset'] as const

export function isAgentBlockedControlInvocation(name: string): boolean {
  return (AGENT_BLOCKED_CONTROL_COMMANDS as readonly string[]).includes(name.toLowerCase())
}

export function assertHumanControlInvocation(name: string, env: Readonly<Record<string, string | undefined>>): void {
  if (!isInAgentSession(env) || !isAgentBlockedControlInvocation(name)) {
    return
  }

  throw new Error(
    `araya_control_agent_session_blocked: agent session の内側で araya ${name} は実行できません。人間の shell の CLI か Discord の slash command（/araya ${name}）で実行してください`,
  )
}
