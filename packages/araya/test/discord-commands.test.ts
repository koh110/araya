import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DISCORD_CONTROL_USAGE,
  createDiscordControlCommands,
  tokenizeDiscordArguments,
  type DiscordControlContext,
} from '../src/discord/commands.ts'
import { readHootState, upsertProposal } from '../src/hoot/store.ts'
import { proposalKeyOf } from '../src/hoot/model.ts'
import { runHootCommand } from '../src/cli/hoot-commands.ts'

const CONTROL_NOW_ISO = '2026-11-20T09:00:00.000Z'

async function makeControlFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-commands-test-')))
  const dataDir = path.join(root, 'data')
  const sent: string[] = []
  const log: Record<string, unknown>[] = []
  const commands = createDiscordControlCommands({
    dataDir,
    nowMs: () => {
      return Date.parse(CONTROL_NOW_ISO)
    },
    log: (entry) => {
      log.push(entry)
    },
  })

  const context = (overrides: Partial<DiscordControlContext> = {}): DiscordControlContext => {
    return {
      messageId: '12345678901234567',
      conversationId: 7,
      runningCount: 0,
      queuedCount: 0,
      sessionAvailable: true,
      send: async (content) => {
        sent.push(content)
      },
      cancelQueued: () => {
        return 2
      },
      stopSession: async () => {
        return '実行中・実行待ちの作業があれば中止を要求しました'
      },
      resetSession: async (requestId) => {
        sent.push(`reset:${requestId}`)

        return 'この channel の会話をリセットしました'
      },
      ...overrides,
    }
  }

  const run = async (content: string, overrides: Partial<DiscordControlContext> = {}) => {
    sent.length = 0
    await commands.handle(content, context(overrides))

    return sent.join('\n')
  }

  const hootRun = async (args: readonly string[]) => {
    const lines: string[] = []

    await runHootCommand(args, {
      dataDir,
      stdout: (text) => {
        lines.push(text)
      },
      nowMs: () => {
        return Date.parse(CONTROL_NOW_ISO)
      },
    })

    return lines.join('\n')
  }

  return { root, dataDir, commands, run, sent, log, hootRun }
}

async function seedActiveSettings(dataDir: string) {
  await runHootCommand(['settings', 'set', '--enabled', 'true', '--mode', 'active'], {
    dataDir,
    stdout: () => {},
    nowMs: () => {
      return Date.parse(CONTROL_NOW_ISO)
    },
  })
}

async function seedDispatchProposal(dataDir: string) {
  await upsertProposal(dataDir, {
    key: 'dispatch-proposal',
    decision: 'dispatch',
    goalKeys: ['araya-quality'],
    reason: 'draft PR #12 の diff を人間に渡す',
    occurrenceKey: `hoot:${CONTROL_NOW_ISO}`,
    nowMs: Date.parse(CONTROL_NOW_ISO),
  })
}

test('discord commands: control command を認識し、会話本文は認識しない', async () => {
  const fixture = await makeControlFixture()

  assert.equal(fixture.commands.matches('help'), true)
  assert.equal(fixture.commands.matches('  STATUS  '), true)
  assert.equal(fixture.commands.matches('Stop'), true)
  assert.equal(fixture.commands.matches('session reset'), true)
  assert.equal(fixture.commands.matches('hoot'), true)
  assert.equal(fixture.commands.matches('hoot status'), true)
  assert.equal(fixture.commands.matches('hoot dispatch --key abc'), true)
  assert.equal(fixture.commands.matches('hootstatus'), false)
  assert.equal(fixture.commands.matches('status?'), false)
  assert.equal(fixture.commands.matches('status please'), false)
  assert.equal(fixture.commands.matches('stop  '), true)
  assert.equal(fixture.commands.matches('shoot status'), false)

  // `hoot` は予約 prefix。この語で始まる message は model に渡さず control command として解析する
  assert.equal(fixture.commands.matches('hoot の状態を教えて'), true)
  const natural = await fixture.run('hoot の状態を教えて')
  assert.match(natural, /hoot_invalid_argument: 不明な command/u)
  // 大文字始まりでも予約 prefix（case insensitive）
  assert.equal(fixture.commands.matches('HOOT status'), true)
})

test('discord commands: quote を 1 引数として扱い、閉じていなければ誤りにする', () => {
  assert.deepEqual(
    tokenizeDiscordArguments('settings set --objective "a b  c" --scope github:koh110/araya'),
    ['settings', 'set', '--objective', 'a b  c', '--scope', "github:koh110/araya"],
  )
  assert.deepEqual(tokenizeDiscordArguments("goal add --key k --objective 'single quoted'"), [
    'goal',
    'add',
    '--key',
    'k',
    '--objective',
    'single quoted',
  ])
  assert.deepEqual(tokenizeDiscordArguments(''), [])
  assert.throws(() => {
    tokenizeDiscordArguments('goal add --objective "閉じていない')
  }, /quote を閉じてください/u)
})

test('discord commands: help と status は model を通さない 1 画面を返す', async () => {
  const fixture = await makeControlFixture()
  const help = await fixture.run('help')
  assert.match(help, /hoot dispatch --key <proposal key>/u)
  assert.match(help, /session reset/u)

  await fixture.hootRun(['goal', 'add', '--key', 'araya-quality', '--objective', 'テストカバレッジを保つ'])

  const status = await fixture.run('status', { runningCount: 1, queuedCount: 2 })
  assert.match(status, /main conversation #7 \/ 実行中 1 \/ 待ち 2/u)
  assert.match(status, /objective: テストカバレッジを保つ/u)
  assert.match(status, /enabled: false/u)
  assert.deepEqual(
    fixture.log.filter((entry) => entry.type === 'discord_control_command').map((entry) => entry.command),
    ['help', 'status'],
  )

  const noSession = await fixture.run('status', { conversationId: null })
  assert.match(noSession, /会話 session は開けていません/u)
})

test('discord commands: stop は queue を取り消して session に中止要求を渡す', async () => {
  const fixture = await makeControlFixture()
  let cancelled = 0
  const output = await fixture.run('stop', {
    cancelQueued: () => {
      cancelled += 1

      return 3
    },
  })

  assert.equal(cancelled, 1)
  assert.match(output, /中止を要求しました（実行待ち 3 件を取り消しました）/u)

  const reset = await fixture.run('reset')
  assert.match(reset, /会話をリセットしました/u)
  assert.deepEqual(fixture.sent, ['reset:12345678901234567', 'この channel の会話をリセットしました'])

  const sessionReset = await fixture.run('session   reset')
  assert.match(sessionReset, /会話をリセットしました/u)

  const withoutSession = await fixture.run('reset', {
    sessionAvailable: false,
    resetSession: async () => {
      return '会話 session が開いていないので、リセットできませんでした'
    },
  })
  assert.match(withoutSession, /リセットできませんでした/u)
})

test('discord commands: hoot goal / settings / dispatch / inject list が state に効く', async () => {
  const fixture = await makeControlFixture()

  const added = await fixture.run(
    'hoot goal add --key araya-quality --objective "テストカバレッジを保つ" --scope github:koh110/araya',
  )
  assert.match(added, /araya-quality/u)

  let state = await readHootState(fixture.dataDir)
  assert.equal(state.goals.length, 1)
  assert.equal(state.goals[0]?.objective, 'テストカバレッジを保つ')

  // dry_run では dispatch 承認を作れない
  await seedDispatchProposal(fixture.dataDir)
  const dryRun = await fixture.run('hoot dispatch --key dispatch-proposal')
  assert.match(dryRun, /hoot_mode_dry_run/u)
  assert.equal((await readHootState(fixture.dataDir)).injectRequests.length, 0)
  assert.equal(
    fixture.log.some((entry) => entry.type === 'discord_control_failed'),
    true,
  )

  const settings = await fixture.run('hoot settings set --enabled true --mode active')
  assert.match(settings, /mode: active/u)

  const dispatched = await fixture.run('hoot dispatch --key dispatch-proposal')
  assert.match(dispatched, /hoot-inject:dispatch-proposal:1/u)

  state = await readHootState(fixture.dataDir)
  assert.equal(state.injectRequests.length, 1)
  assert.equal(state.injectRequests[0]?.authorizedBy, 'human')
  assert.equal(state.injectRequests[0]?.status, 'pending')

  const listed = await fixture.run('hoot inject list')
  assert.match(listed, /pending/u)
  assert.match(listed, /dispatch-proposal/u)

  const goals = await fixture.run('hoot goal list')
  assert.match(goals, /objective: テストカバレッジを保つ/u)

  const runs = await fixture.run('hoot runs')
  assert.match(runs, /判断 run の記録はありません/u)
})

test('discord commands: --data-dir は拒否し、bot process の dataDir だけを使う', async () => {
  const fixture = await makeControlFixture()
  const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-discord-commands-other-')))

  const output = await fixture.run(`hoot status --data-dir ${other}`)
  assert.match(output, /--data-dir/u)
  assert.equal(
    fixture.log.some((entry) => entry.type === 'discord_control_failed' && /data-dir/u.test(String(entry.message))),
    true,
  )

  // 通常の状態読みは bot の dataDir を使う（goal を作って確認）
  await fixture.hootRun(['goal', 'add', '--key', 'bot-dir', '--objective', 'bot の dataDir を使う'])
  const status = await fixture.run('hoot status')
  assert.match(status, /bot-dir/u)
  assert.equal((await fs.readdir(other)).length, 0)
})

test('discord commands: 不明な hoot command は human 向けの 1 文と log で返す', async () => {
  const fixture = await makeControlFixture()
  const output = await fixture.run('hoot bogus --key x')
  assert.match(output, /hoot_invalid_argument: 不明な command: bogus/u)
  assert.match(output, /status \/ goal \/ settings/u)

  const missingKey = await fixture.run('hoot dispatch')
  assert.match(missingKey, /--key/u)

  await seedActiveSettings(fixture.dataDir)

  const unknownProposal = await fixture.run('hoot dispatch --key not-there')
  assert.match(unknownProposal, /hoot_proposal_not_found/u)

  assert.equal(DISCORD_CONTROL_USAGE.includes('hoot inject list'), true)
})

test('discord commands: agent session の目印が process に残っても Discord の承認は効く（guard は CLI boundary だけ）', async () => {
  const fixture = await makeControlFixture()
  await fixture.hootRun(['goal', 'add', '--key', 'araya-quality', '--objective', 'diff を見る'])
  await seedActiveSettings(fixture.dataDir)
  await seedDispatchProposal(fixture.dataDir)

  process.env.ARAYA_AGENT_SESSION = '1'

  try {
    const output = await fixture.run('hoot dispatch --key dispatch-proposal')
    assert.match(output, /inject request を作りました: hoot-inject:dispatch-proposal:1/u)
    const state = await readHootState(fixture.dataDir)
    assert.equal(state.injectRequests.length, 1)
    assert.equal(state.injectRequests[0]?.authorizedBy, 'human')
  } finally {
    delete process.env.ARAYA_AGENT_SESSION
  }
})
