import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARAYA_AGENT_SESSION_ENV,
  agentSessionShellEnv,
  assertHumanHootInvocation,
  hootInvocationCommandOf,
  isInAgentSession,
} from '../src/infrastructure/agent-session.ts'

const AGENT_ENV = { [ARAYA_AGENT_SESSION_ENV]: '1', HOME: '/home/koh110' }
const HUMAN_ENV = { HOME: '/home/koh110' }

function blocked(args: readonly string[], env: Record<string, string> = AGENT_ENV) {
  assert.throws(() => {
    assertHumanHootInvocation(args, env)
  }, /hoot_agent_session_blocked/u)
}

function allowed(args: readonly string[], env: Record<string, string> = AGENT_ENV) {
  assert.doesNotThrow(() => {
    assertHumanHootInvocation(args, env)
  })
}

test('agent session: 目印は shell env の object として返し、process env は書き換えない', () => {
  // host process の env 自体が目印を持ちうる（dev unit など）ので、比較は host の値を保存して行う
  const hostMarker = process.env[ARAYA_AGENT_SESSION_ENV]
  const shellWithoutMarker: Record<string, string> = {}

  for (const [name, value] of Object.entries(process.env)) {
    if (name !== ARAYA_AGENT_SESSION_ENV && value !== undefined) {
      shellWithoutMarker[name] = value
    }
  }

  const marker = agentSessionShellEnv()
  assert.equal(marker[ARAYA_AGENT_SESSION_ENV], '1')
  assert.equal(isInAgentSession(shellWithoutMarker), false)
  assert.equal(isInAgentSession({ ...shellWithoutMarker, ...marker }), true)
  assert.equal(process.env[ARAYA_AGENT_SESSION_ENV], hostMarker)
})

test('agent session: hoot の command 名を positional から読む（--key の値は subcommand にしない）', () => {
  assert.deepEqual(hootInvocationCommandOf(['dispatch', '--key', 'abc']), {
    command: 'dispatch',
    subcommand: undefined,
  })
  assert.deepEqual(hootInvocationCommandOf(['goal', 'add', '--key', 'k', '--objective', '目的  text']), {
    command: 'goal',
    subcommand: 'add',
  })
  assert.deepEqual(hootInvocationCommandOf(['settings', 'set', '--enabled', 'true']), {
    command: 'settings',
    subcommand: 'set',
  })
  assert.deepEqual(hootInvocationCommandOf([]), { command: 'status', subcommand: undefined })
  assert.deepEqual(hootInvocationCommandOf(['--data-dir', '/tmp/araya-other']), {
    command: 'status',
    subcommand: undefined,
  })
})

test('agent session: 承認・設定変更・goal の書き込みは agent から拒否する', () => {
  blocked(['dispatch', '--key', 'proposal-key'])
  blocked(['settings', 'set', '--enabled', 'true'])
  blocked(['settings', 'set', '--mode', 'active', '--auto-dispatch', 'true'])
  blocked(['goal', 'add', '--key', 'k', '--objective', '目的'])
  blocked(['goal', 'update', '--key', 'k', '--objective', '目的'])
  blocked(['goal', 'pause', '--key', 'k'])
  blocked(['goal', 'retire', '--key', 'k'])
  blocked(['proposal', 'resolve', '--key', 'k'])
  blocked(['reset-schedule'])

  // 拒否文は人間が打てる経路を示す（秘密も token も含まない）
  let message = ''

  try {
    assertHumanHootInvocation(['dispatch', '--key', 'proposal-key'], AGENT_ENV)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }

  assert.match(message, /araya hoot dispatch は実行できません/u)
  assert.match(message, /Discord/u)
  assert.equal(message.includes('proposal-key'), false, 'option の値を command 名にしない')
})

test('agent session: 読み取りと inject list は agent にも allowed', () => {
  allowed([])
  allowed(['status'])
  allowed(['goal', 'list'])
  allowed(['settings', 'show'])
  allowed(['proposal', 'list'])
  allowed(['inject', 'list'])
  allowed(['runs', '--limit', '5'])
  allowed(['--data-dir', '/tmp/araya-other'])
})

test('agent session: 目印が無ければ人間の CLI なので止めない', () => {
  allowed(['dispatch', '--key', 'proposal-key'], HUMAN_ENV)
  allowed(['settings', 'set', '--enabled', 'true'], HUMAN_ENV)
  allowed(['goal', 'add', '--key', 'k', '--objective', '目的'], HUMAN_ENV)
  allowed(['reset-schedule'], HUMAN_ENV)
})
