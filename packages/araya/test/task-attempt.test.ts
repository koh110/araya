import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { DIFF_TRUNCATION_MARKER, MAX_DIFF_BYTES } from '../src/development.ts'
import { VERIFICATION_OUTPUT_BYTES } from '../src/development-process.ts'
import { SHIKI_TOOL_NAMES } from '../src/shiki.ts'
import { bashScopeUnit, verifyScopeUnit } from '../src/systemd-units.ts'
import { AttemptsDoc, buildAttemptInput, resolveShikiModel, type PiModelSettings } from '../src/task-attempt.ts'
import { openTaskLedger } from '../src/task-ledger.ts'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'

import { answer, createFauxModels, toolCall, worktreePathFrom, type FauxView } from './support/faux-shiki.ts'
import { createFakeSystemd, findMarkedProcesses } from './support/fake-systemd.ts'
import {
  createRepository,
  createRunnerFixture,
  ctx,
  defaultSettings,
  git,
  openAttemptHarness,
  removeRunnerFixture,
  taskInput,
  waitUntil,
  type RunnerFixture
} from './support/runner-fixture.ts'

const PASS_COMMAND = [process.execPath, '-e', "console.log('verified')"]

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(extraEnv: Record<string, string> = {}, options: { failStop?: (pattern: string) => boolean } = {}) {
  const fixture = await createRunnerFixture(extraEnv)
  const models = await createFauxModels(fixture)
  const systemd = createFakeSystemd(options.failStop === undefined ? {} : { failStop: options.failStop })

  return { fixture, models, systemd }
}

async function teardown(setupValue: Setup, attempt?: { close(): Promise<void> }) {
  try {
    await attempt?.close()
  } finally {
    await removeRunnerFixture(setupValue.fixture)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function records(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error('not an array')
  }

  return value.filter(isRecord)
}

function readEvents(fixture: RunnerFixture) {
  const db = new DatabaseSync(path.join(fixture.dataDir, 'tasks.sqlite'))

  try {
    return db.prepare('SELECT type, data_json FROM task_events ORDER BY seq').all().map((row) => {
      return { type: String(row.type), data: JSON.parse(String(row.data_json)) }
    })
  } finally {
    db.close()
  }
}

// 台帳のすべての table の内容を1つの文字列にする（秘密が写っていないことを確かめる）
function dumpLedger(fixture: RunnerFixture) {
  const db = new DatabaseSync(path.join(fixture.dataDir, 'tasks.sqlite'))

  try {
    return ['tasks', 'runs', 'task_events', 'runner'].map((table) => {
      return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
    }).join('\n')
  } finally {
    db.close()
  }
}

// 大きな本文の詰め物。空白の無い長い英数字の並びは URL の userinfo の置き換えが遅くなるので、短い行にする
function filler(length: number) {
  return 'filler line\n'.repeat(Math.ceil(length / 12)).slice(0, length)
}

// 大きな本文を比べる。違えば、最初に違う位置の付近だけを表示する（全体の差分の表示は遅い）
function assertLongText(actual: unknown, expected: string, message: string) {
  assert.equal(typeof actual, 'string', message)
  const text = String(actual)

  if (text === expected) {
    return
  }

  let index = 0

  while (index < text.length && text[index] === expected[index]) {
    index += 1
  }

  const start = Math.max(0, index - 40)
  assert.equal(text.slice(start, index + 40), expected.slice(start, index + 40), `${message} (${index} 文字目)`)
  assert.equal(text.length, expected.length, message)
}

// file の内容。file が無ければ空文字列
async function readTextIfExists(file: string) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return ''
    }

    throw error
  }
}

// worktree を作り、bash で編集し、検証を登録して、報告で終わる SHIKI
function completingScript(options: { command?: readonly string[]; report?: string; bash?: (worktreePath: string) => string } = {}) {
  return (view: FauxView) => {
    const results = view.toolResults

    switch (results.length) {
      case 0:
        return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
      case 1: {
        const worktreePath = worktreePathFrom(results[0])
        return toolCall('bash', { command: options.bash?.(worktreePath) ?? `printf 'changed\\n' >> ${worktreePath}/README.md` })
      }
      case 2:
        return toolCall('araya_register_verification', { repository: 'repo', command: [...(options.command ?? PASS_COMMAND)] })
      default:
        return answer(options.report ?? 'README に1行足しました。npm test 相当の検証を登録しました。')
    }
  }
}

test('attempt: worktree を作り、編集し、検証を登録すると completed で、summary・model・tools の7つの名前・timeoutMs が記録される', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    const repo = await createRepository(fixture, 'repo')
    models.script(completingScript())
    const settings = defaultSettings(fixture, models.model)
    const done = await attempt.runAttempt(taskInput(), settings)

    assert.equal(done.outcome.status, 'completed')
    assert.equal(done.result?.status, 'completed')
    const shown = attempt.ledger.showTask(done.ledgerTaskId, { events: 500 })
    const run = shown.attempts[0]
    assert.equal(shown.task.status, 'completed')
    assert.equal(run?.status, 'completed')
    assert.equal(run?.summary, 'README に1行足しました。npm test 相当の検証を登録しました。')
    const expectedModel = { provider: models.model.provider, id: models.model.id, thinkingLevel: 'off', source: 'araya-config' }
    assert.deepEqual(run?.model, expectedModel)
    assert.equal(run?.stateDir, path.join(fixture.dataDir, 'development', done.taskKey))

    const evidence = run?.evidence ?? {}
    assert.equal(evidence.outcome, 'completed')
    assert.deepEqual(evidence.tools, [...SHIKI_TOOL_NAMES])
    assert.equal(SHIKI_TOOL_NAMES.length, 7)
    assert.equal(evidence.timeoutMs, settings.timeoutMs)
    assert.deepEqual(evidence.agent, { model: expectedModel })
    assert.equal(evidence.decisionQuestion, null)
    assert.equal(evidence.resumes, 0)
    assert.equal(evidence.activeMs, 0)
    assert.equal(evidence.bodiesStored, true)
    const worktree = records(evidence.worktrees)[0]
    const worktreePath = path.join(repo, '.worktree', `araya-${done.taskKey}`)
    assert.equal(worktree?.worktreePath, worktreePath)
    assert.equal(worktree?.branch, `araya/${done.taskKey}`)
    assert.deepEqual(worktree?.changedFiles, ['README.md'])
    assert.equal('diff' in (worktree ?? {}), false)
    assert.deepEqual(records(worktree?.verifications).map(({ status, exitCode }) => {
      return { status, exitCode }
    }), [{ status: 'passed', exitCode: 0 }])
    assert.equal(await fs.readFile(path.join(worktreePath, 'README.md'), 'utf8'), '# fixture\nchanged\n')
    assert.equal(git(fixture, repo, 'status', '--porcelain'), '')

    // 本文は evidence.json にだけあり、その SHA-256 が台帳に残る
    const evidenceFile = await fs.readFile(path.join(fixture.dataDir, 'development', done.taskKey, 'evidence.json'))
    assert.equal(evidence.bodiesSha256, createHash('sha256').update(evidenceFile).digest('hex'))
    const full: unknown = JSON.parse(evidenceFile.toString('utf8'))
    assert.equal(isRecord(full), true)
    const fullWorktree = isRecord(full) ? records(full.worktrees)[0] : undefined
    assert.match(String(fullWorktree?.diff), /\+changed/u)
    assert.match(String(records(fullWorktree?.verifications)[0]?.stdout), /verified/u)
    assert.equal(isRecord(full) && 'bodiesStored' in full, false)
    assert.equal((await fs.stat(path.join(fixture.dataDir, 'development', done.taskKey, 'evidence.json'))).mode & 0o777, 0o600)

    // bash・git・検証は、その試行の scope の名前で起動される
    const launches = systemd.launches()
    const bashLaunches = launches.filter((launch) => {
      return launch.argv[0] === '/bin/bash' && launch.argv[1] === '-c'
    })
    assert.equal(bashLaunches.length, 1)
    assert.match(bashLaunches[0]?.unit ?? '', new RegExp(`^araya-${fixture.hash}-${done.taskKey}-[0-9a-f]{12}\\.scope$`, 'u'))
    assert.equal(launches.some((launch) => {
      return launch.unit === verifyScopeUnit(fixture.hash, done.taskKey, 0)
    }), true)
    assert.equal(launches.filter((launch) => {
      return /-git-[a-z2-7]{12}\.scope$/u.test(launch.unit)
    }).length > 0, true)
    // evidence の phase の始めに、その試行の scope を止める
    assert.equal(systemd.records().some((entry) => {
      return entry.type === 'stop' && entry.pattern === `araya-${fixture.hash}-${done.taskKey}-*.scope`
    }), true)
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: bash の scope の名前は tool の呼び出しの id の SHA-256 から作る', () => {
  assert.equal(
    bashScopeUnit('0123456789ab', 'task-1-1-abcdef', 'call-1'),
    `araya-0123456789ab-task-1-1-abcdef-${createHash('sha256').update('call-1').digest('hex').slice(0, 12)}.scope`
  )
})

test('attempt: model が誤りを返すと agent_failed で、agent.error は model_error、agent.errorMessage は秘密を置き換えた message', async () => {
  const secret = 'model-secret-value-1234'
  const value = await setup({ ARAYA_TEST_TOKEN: secret })
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    await createRepository(fixture, 'repo')
    models.script(() => {
      return {
        ...answer('partial'),
        stopReason: 'error',
        errorMessage: `provider exploded TOKEN=${secret} https://user:pass@example.invalid/x`
      }
    })
    const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
    const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]

    assert.equal(run?.status, 'failed')
    assert.equal(run?.failureReason, 'agent_failed')
    const agent = run?.evidence?.agent
    assert.equal(isRecord(agent), true)
    assert.equal(isRecord(agent) ? agent.error : undefined, 'model_error')
    assert.equal(isRecord(agent) ? agent.errorMessage : undefined, 'provider exploded TOKEN=[REDACTED] https://[REDACTED]@example.invalid/x')
    assert.deepEqual(isRecord(agent) ? agent.model : undefined, { ...models.model, thinkingLevel: 'off', source: 'araya-config' })
    assert.equal(run?.evidence?.redactions, 2)
    assert.equal(dumpLedger(fixture).includes(secret), false)
  } finally {
    await teardown(value, attempt)
  }
})

function piSettings(values: { provider?: string; model?: string; thinkingLevel?: 'high' } = {}) {
  const settings: PiModelSettings = {
    getDefaultProvider: () => {
      return values.provider
    },
    getDefaultModel: () => {
      return values.model
    },
    getDefaultThinkingLevel: () => {
      return values.thinkingLevel
    },
    getModelThinkingLevel: () => {
      return undefined
    }
  }

  return settings
}

test('attempt: model が決まらない（Pi の既定が無い・ModelRuntime に無い・認証が無い）ときは agent_failed で agent.error は model_unavailable', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  // 認証の無い provider を ModelRuntime に足す
  const noAuth = fauxProvider({ provider: 'araya-noauth', models: [{ id: 'model-1' }] })
  models.runtime.registerNativeProvider({ ...noAuth.provider, auth: { apiKey: { name: 'NoAuth', resolve: async () => undefined } } })
  await models.runtime.refresh({ allowNetwork: false })
  let settingsFor = piSettings()
  const attempt = await openAttemptHarness(fixture, {
    models: models.runtime,
    systemd: systemd.ops,
    createPiSettings: () => {
      return settingsFor
    }
  })

  try {
    await createRepository(fixture, 'repo')
    models.script(completingScript())
    const cases = [
      { model: null, settings: piSettings(), message: 'no configured Pi model is available' },
      {
        model: null,
        settings: piSettings({ provider: 'faux', model: 'missing-model' }),
        message: 'configured model faux/missing-model is not in the Pi model list'
      },
      {
        model: { provider: 'faux', id: 'missing-model', thinkingLevel: null },
        settings: piSettings(),
        message: 'configured model faux/missing-model is not in the Pi model list'
      },
      {
        model: { provider: 'araya-noauth', id: 'model-1', thinkingLevel: null },
        settings: piSettings(),
        message: 'configured model araya-noauth/model-1 has no Pi authentication'
      }
    ] as const

    for (const [index, item] of cases.entries()) {
      settingsFor = item.settings
      const done = await attempt.runAttempt(taskInput({ title: `case ${index}` }), defaultSettings(fixture, item.model))
      const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]

      assert.equal(run?.status, 'failed', item.message)
      assert.equal(run?.failureReason, 'agent_failed', item.message)
      assert.deepEqual(run?.evidence?.agent, { error: 'model_unavailable', errorMessage: item.message })
      assert.equal(run?.model, null)
    }

    assert.equal(models.faux.state.callCount, 0)
    const attempts = await attempt.harness.snapshot(AttemptsDoc, ctx)
    assert.deepEqual(attempts?.byConversation, {})
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: thinking level は設定ファイル・Pi の model ごとの値・Pi の既定・medium の順で決め、model の対応範囲に丸める', async () => {
  const value = await setup()
  const { fixture, models } = value

  try {
    // reasoning に対応する faux の model
    const reasoning = await createFauxModels(fixture, { reasoning: true })
    const id = reasoning.model.id
    const settings = defaultSettings(fixture, null)
    const configured = defaultSettings(fixture, { provider: 'faux', id, thinkingLevel: null })
    const modelThinking: PiModelSettings = {
      ...piSettings({ provider: 'faux', model: id, thinkingLevel: 'high' }),
      getModelThinkingLevel: (provider, modelId) => {
        return provider === 'faux' && modelId === id ? 'low' : undefined
      }
    }

    function resolved(thinkingLevel: string, source: 'araya-config' | 'pi-settings', modelId = id) {
      return { ok: true, model: { provider: 'faux', id: modelId, thinkingLevel, source } }
    }

    // model を設定しないときは Pi の既定の model を使い、thinking level は model ごとの値 → 既定 → medium
    assert.deepEqual(resolveShikiModel(reasoning.runtime, settings, modelThinking), resolved('low', 'pi-settings'))
    assert.deepEqual(resolveShikiModel(reasoning.runtime, settings, piSettings({ provider: 'faux', model: id, thinkingLevel: 'high' })), resolved('high', 'pi-settings'))
    assert.deepEqual(resolveShikiModel(reasoning.runtime, settings, piSettings({ provider: 'faux', model: id })), resolved('medium', 'pi-settings'))
    // model を設定したときは、設定ファイルの thinking level → model ごとの値 → 既定 → medium
    assert.deepEqual(resolveShikiModel(reasoning.runtime, configured, modelThinking), resolved('low', 'araya-config'))
    assert.deepEqual(resolveShikiModel(reasoning.runtime, configured, piSettings({ thinkingLevel: 'high' })), resolved('high', 'araya-config'))
    assert.deepEqual(resolveShikiModel(reasoning.runtime, configured, piSettings()), resolved('medium', 'araya-config'))
    assert.deepEqual(
      resolveShikiModel(reasoning.runtime, defaultSettings(fixture, { provider: 'faux', id, thinkingLevel: 'minimal' }), modelThinking),
      resolved('minimal', 'araya-config')
    )
    // 対応範囲を超える値は丸める（faux の model は xhigh に対応しない）
    assert.deepEqual(
      resolveShikiModel(reasoning.runtime, defaultSettings(fixture, { provider: 'faux', id, thinkingLevel: 'xhigh' }), modelThinking),
      resolved('high', 'araya-config')
    )
    // reasoning に対応しない model は、どの値でも off に丸める
    const plain = models.model.id
    assert.deepEqual(resolveShikiModel(models.runtime, defaultSettings(fixture, { ...models.model, thinkingLevel: 'high' }), piSettings()), resolved('off', 'araya-config', plain))
    assert.deepEqual(resolveShikiModel(models.runtime, settings, piSettings({ provider: 'faux', model: plain })), resolved('off', 'pi-settings', plain))
  } finally {
    await teardown(value)
  }
})

test('attempt: thinking level の指定も Pi の設定も無いとき、reasoning に対応する model は medium、対応しない model は off を記録する', async () => {
  for (const reasoningModel of [true, false]) {
    const fixture = await createRunnerFixture()
    const models = await createFauxModels(fixture, { reasoning: reasoningModel })
    const systemd = createFakeSystemd()
    const value: Setup = { fixture, models, systemd }
    const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })
    const expected = reasoningModel ? 'medium' : 'off'

    try {
      await createRepository(fixture, 'repo')
      models.script(completingScript())
      // Pi の settings.json は無い（agentDir には auth.json だけがある）
      await assert.rejects(fs.access(path.join(fixture.agentDir, 'settings.json')))
      const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
      const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]
      const expectedModel = { provider: models.model.provider, id: models.model.id, thinkingLevel: expected, source: 'araya-config' }

      assert.equal(run?.status, 'completed', `reasoning: ${reasoningModel}`)
      assert.deepEqual(run?.model, expectedModel)
      assert.deepEqual(run?.evidence?.agent, { model: expectedModel })
    } finally {
      await teardown(value, attempt)
    }
  }
})

test('attempt: araya_request_decision で質問して成功で終わると blocked で、質問が記録され、検証は実行しない', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })
  const marker = path.join(fixture.root, 'verification-ran')
  const decisionResults: { isError: boolean; text: string }[] = []

  try {
    await createRepository(fixture, 'repo')
    // model を設定しないので、Pi の settings.json の既定の model を使う
    await fs.writeFile(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'faux', defaultModel: models.model.id }), 'utf8')
    models.script((view) => {
      const results = view.toolResults

      if (results.length >= 4) {
        decisionResults.push({ isError: results.at(-1)?.isError ?? false, text: results.at(-1)?.text ?? '' })
      }

      switch (results.length) {
        case 0:
          return toolCall('araya_create_worktree', { repository: 'repo' })
        case 1:
          return toolCall('bash', { command: `printf 'changed\\n' >> ${worktreePathFrom(results[0])}/README.md` })
        case 2:
          return toolCall('araya_register_verification', {
            repository: 'repo',
            command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker]
          })
        case 3:
          return toolCall('araya_request_decision', { question: 'どちらの API を使いますか' })
        case 4:
          return toolCall('araya_request_decision', { question: '2つ目の質問' })
        case 5:
          return toolCall('araya_request_decision', { question: '   ' })
        default:
          return answer('API の選択を質問しました。')
      }
    })
    const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, null))
    const shown = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 })
    const run = shown.attempts[0]

    assert.equal(shown.task.status, 'blocked')
    assert.equal(shown.task.decisionQuestion, 'どちらの API を使いますか')
    assert.equal(run?.status, 'blocked')
    assert.equal(run?.failureReason, null)
    assert.equal(run?.decisionQuestion, 'どちらの API を使いますか')
    assert.equal(run?.summary, 'API の選択を質問しました。')
    assert.deepEqual(run?.model, { provider: 'faux', id: models.model.id, thinkingLevel: 'off', source: 'pi-settings' })
    assert.equal(run?.evidence?.decisionQuestion, 'どちらの API を使いますか')
    const worktree = records(run?.evidence?.worktrees)[0]
    assert.deepEqual(records(worktree?.verifications).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'decision_requested' }])
    await assert.rejects(fs.access(marker))

    // 1回目は記録し、2回目以降は tool の誤りで、最初の質問を残す
    assert.deepEqual(decisionResults[0], { isError: false, text: '質問を記録しました。ここで作業を終え、ここまでの内容を報告してください' })
    assert.equal(decisionResults[1]?.isError, true)
    assert.match(decisionResults[1]?.text ?? '', /decision_already_requested/u)
    assert.equal(decisionResults[2]?.isError, true)
    assert.match(decisionResults[2]?.text ?? '', /question_invalid/u)
    const decision: unknown = JSON.parse(await fs.readFile(path.join(fixture.dataDir, 'development', done.taskKey, 'decision.json'), 'utf8'))
    assert.equal(isRecord(decision) ? decision.question : undefined, 'どちらの API を使いますか')
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: devRoot が directory でなければ dev_root_missing、課題の本文が 80000 文字を超えれば invalid_task で、どちらも会話を作らない', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    models.script(completingScript())
    const missing = await attempt.runAttempt(taskInput({ title: 'missing' }), { ...defaultSettings(fixture, models.model), devRoot: path.join(fixture.root, 'missing') })
    const longBody = await attempt.runAttempt(taskInput({ title: 'long' }), defaultSettings(fixture, models.model), (input) => {
      return { ...input, body: 'あ'.repeat(80_001) }
    })
    const exact = await attempt.runAttempt(taskInput({ title: 'exact' }), defaultSettings(fixture, models.model), (input) => {
      return { ...input, body: 'あ'.repeat(80_000) }
    })

    const missingRun = attempt.ledger.showTask(missing.ledgerTaskId, { events: 0 }).attempts[0]
    assert.equal(missingRun?.failureReason, 'dev_root_missing')
    assert.equal(missingRun?.evidence?.bodiesStored, false)
    assert.deepEqual(missingRun?.evidence?.worktrees, [])
    assert.equal(missingRun?.evidence?.stateDir, path.join(fixture.dataDir, 'development', missing.taskKey))
    assert.equal('agent' in (missingRun?.evidence ?? {}), false)
    assert.equal(attempt.ledger.showTask(longBody.ledgerTaskId, { events: 0 }).attempts[0]?.failureReason, 'invalid_task')
    // 80000 文字ちょうどは受け付けて SHIKI を動かす（repository が無いので worktree を作れずに終わる）
    assert.notEqual(attempt.ledger.showTask(exact.ledgerTaskId, { events: 0 }).attempts[0]?.failureReason, 'invalid_task')

    const attempts = await attempt.harness.snapshot(AttemptsDoc, ctx)
    assert.deepEqual(Object.values(attempts?.byConversation ?? {}).map((entry) => {
      return entry.taskKey
    }), [exact.taskKey])
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 状態 directory の attempt.json が別の taskKey のものなら task_state_already_exists', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    models.script(completingScript())
    const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model), (input) => {
      const stateDir = path.join(fixture.dataDir, 'development', input.taskKey)
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(stateDir, 'attempt.json'), JSON.stringify({ taskKey: 'task-99-1-zzzzzz', dataDir: fixture.dataDir }))

      return input
    })
    const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]

    assert.equal(run?.status, 'failed')
    assert.equal(run?.failureReason, 'task_state_already_exists')
    assert.match(run?.failureDetail ?? '', /belongs to another attempt/u)
    assert.equal(run?.stateDir, null)
    assert.equal(models.faux.state.callCount, 0)
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 途中経過は決まった key だけで記録し、bash のコマンドと tool の結果の秘密を写さない', async () => {
  const secret = 'progress-secret-value-5678'
  const value = await setup({ ARAYA_TEST_TOKEN: secret })
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    await createRepository(fixture, 'repo')
    models.script((view) => {
      const results = view.toolResults

      switch (results.length) {
        case 0:
          return toolCall('araya_create_worktree', { repository: 'repo', base: 'HEAD' })
        case 1:
          return toolCall('bash', { command: `echo ${secret}; echo $ARAYA_TEST_TOKEN` })
        case 2:
          return toolCall('write', { path: `${worktreePathFrom(results[0])}/notes.txt`, content: `token ${secret}\n` })
        case 3:
          return toolCall('read', { path: `${worktreePathFrom(results[0])}/notes.txt` })
        case 4:
          return toolCall('araya_register_verification', { repository: 'repo', command: PASS_COMMAND, cwd: '.' })
        case 5:
          return toolCall('read', { path: 'x'.repeat(400) })
        default:
          return answer('done')
      }
    })
    const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
    const events = readEvents(fixture).filter((event) => {
      return event.type.startsWith('tool.')
    })

    assert.deepEqual(events.map((event) => {
      return [event.type, event.data.tool]
    }), [
      ['tool.started', 'araya_create_worktree'], ['tool.finished', 'araya_create_worktree'],
      ['tool.started', 'bash'], ['tool.finished', 'bash'],
      ['tool.started', 'write'], ['tool.finished', 'write'],
      ['tool.started', 'read'], ['tool.finished', 'read'],
      ['tool.started', 'araya_register_verification'], ['tool.finished', 'araya_register_verification'],
      ['tool.started', 'read'], ['tool.finished', 'read']
    ])
    const worktreePath = path.join(fixture.devRoot, 'repo', '.worktree', `araya-${done.taskKey}`)
    assert.deepEqual(events[0]?.data, { tool: 'araya_create_worktree', repository: 'repo', base: 'HEAD' })
    assert.deepEqual(events[1]?.data, { tool: 'araya_create_worktree', repository: 'repo', base: 'HEAD', isError: false })
    assert.deepEqual(events[2]?.data, { tool: 'bash' })
    assert.deepEqual(events[3]?.data, { tool: 'bash', isError: false })
    assert.deepEqual(events[4]?.data, { tool: 'write', path: `${worktreePath}/notes.txt` })
    assert.deepEqual(events[8]?.data, { tool: 'araya_register_verification', repository: 'repo', cwd: '.' })
    // path は先頭 300 文字まで。読めない file の read は isError
    assert.deepEqual(events[10]?.data, { tool: 'read', path: 'x'.repeat(300) })
    assert.deepEqual(events[11]?.data, { tool: 'read', path: 'x'.repeat(300), isError: true })
    assert.equal(dumpLedger(fixture).includes(secret), false)
    assert.deepEqual(attempt.logs, [])
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 途中経過の path は秘密を置き換えてから 300 文字で切り、URL の userinfo と秘密の値が境界をまたいでも一部も残らない', async () => {
  const secret = 'Zq8kW3mX9pL2vN7r'
  const value = await setup({ ARAYA_TEST_TOKEN: secret })
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })
  // 300 文字で切ると、userinfo の後の @ と、秘密の値の後半が境界の外に出る
  const userinfoPath = `${'x'.repeat(300 - 'https://user:pass'.length)}https://user:pass@example.invalid/repo.git`
  const secretPath = `${'y'.repeat(300 - 6)}${secret}/file.txt`

  try {
    models.script((view) => {
      switch (view.toolResults.length) {
        case 0:
          return toolCall('read', { path: userinfoPath })
        case 1:
          return toolCall('write', { path: secretPath, content: 'x' })
        case 2:
          return toolCall('araya_create_worktree', { repository: userinfoPath, base: secretPath })
        default:
          return answer('done')
      }
    })
    await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
    const events = readEvents(fixture).filter((event) => {
      return event.type === 'tool.started'
    })

    assert.deepEqual(events.map((event) => {
      return event.data
    }), [
      { tool: 'read', path: `${'x'.repeat(283)}https://[REDACTED` },
      { tool: 'write', path: `${'y'.repeat(294)}[REDAC` },
      { tool: 'araya_create_worktree', repository: `${'x'.repeat(283)}https://[REDACTED`, base: `${'y'.repeat(294)}[REDAC` }
    ])
    const ledgerText = dumpLedger(fixture)
    assert.equal(ledgerText.includes('user:pass'), false)
    assert.equal(ledgerText.includes(secret.slice(0, 6)), false)
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 差分の収集の git の誤りは秘密を置き換えてから切り、failure_detail に URL の userinfo と秘密の値が一部も残らない', async () => {
  const secret = 'Hj4tR8nB2cY6wE1u'
  const prefix = 'git rev-parse --show-toplevel failed: '
  // failure_detail の元の誤りは 500 文字で切る。その境界を、userinfo の @ の前と、秘密の値の途中に置く
  const stderrs = [
    `${'x'.repeat(500 - prefix.length - 'https://user:pass'.length)}https://user:pass@example.invalid/repo.git`,
    `${'y'.repeat(500 - prefix.length - 6)}${secret} remains`
  ]

  for (const stderr of stderrs) {
    const value = await setup({ ARAYA_TEST_TOKEN: secret })
    const { fixture, models, systemd } = value
    // 差分の収集（evidence の phase）で worktree に対して実行する rev-parse --show-toplevel だけを失敗させる
    const ops: typeof systemd.ops = {
      ...systemd.ops,
      launchInScope(unit, command, args, options) {
        const worktreeIndex = args.indexOf('-C') + 1

        if (args.includes('--show-toplevel') && (args[worktreeIndex] ?? '').includes(`${path.sep}.worktree${path.sep}`)) {
          return Promise.resolve({
            exitCode: 128,
            signal: null,
            stdout: '',
            stderr,
            stdoutBytes: 0,
            stderrBytes: Buffer.byteLength(stderr),
            terminationReason: undefined,
            terminationConfirmed: true
          })
        }

        return systemd.ops.launchInScope(unit, command, args, options)
      }
    }
    const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: ops })

    try {
      await createRepository(fixture, 'repo')
      models.script(completingScript())
      const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
      const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]

      assert.equal(run?.failureReason, 'evidence_collection_failed')
      assert.ok(run?.failureDetail?.startsWith(prefix), run?.failureDetail ?? '')
      const ledgerText = dumpLedger(fixture)
      assert.equal(ledgerText.includes('user:pass'), false)
      assert.equal(ledgerText.includes(secret.slice(0, 6)), false)
    } finally {
      await teardown(value, attempt)
    }
  }
})

test('attempt: 末尾を切った差分の境界をまたぐ秘密の値と URL の userinfo は、evidence.json にも台帳にも一部も残らない', async () => {
  const secret = 'Zq8kW3mX9pL2vN7r'
  const longSecret = 'abcdefgh12345678'
  // 差分は、全 worktree の合計の上限から切り詰めの印の分を除いた byte 数で切る
  const keptBytes = MAX_DIFF_BYTES - Buffer.byteLength(DIFF_TRUNCATION_MARKER)
  const cases = [
    { kept: secret.slice(0, 6), lost: `${secret.slice(6)} after`, expected: '[REDACTED]', fragment: secret.slice(0, 6) },
    { kept: 'clone https://user:pas', lost: 's@example.invalid/repo.git', expected: 'clone https://[REDACTED]', fragment: 'user:pas' },
    // 短い秘密の値（abcdefgh）が長い秘密の値の一部に当たっても、1234 を残さない
    { kept: longSecret.slice(0, 12), lost: longSecret.slice(12), expected: '[REDACTED]', fragment: longSecret.slice(0, 12) }
  ]

  for (const item of cases) {
    const value = await setup({ ARAYA_TEST_TOKEN: secret, ARAYA_LONG_TOKEN: longSecret, ARAYA_SHORT_TOKEN: 'abcdefgh', ARAYA_OTHER_TOKEN: '12345678' })
    const { fixture, models, systemd } = value
    const padding = filler(keptBytes - item.kept.length)
    // 差分の収集の git diff の出力を、上限で止まった（output_overflow）ものに置き換える
    const ops: typeof systemd.ops = {
      ...systemd.ops,
      launchInScope(unit, command, args, options) {
        if (args.includes('diff') && args.includes('--binary')) {
          const limitBytes = options.stdout?.limitBytes ?? 0
          const stdout = `${padding}${item.kept}${item.lost}`.padEnd(limitBytes, 'y\n').slice(0, limitBytes)

          return Promise.resolve({
            exitCode: null,
            signal: null,
            stdout,
            stderr: '',
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: 0,
            terminationReason: 'output_overflow' as const,
            terminationConfirmed: true
          })
        }

        return systemd.ops.launchInScope(unit, command, args, options)
      }
    }
    const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: ops })

    try {
      await createRepository(fixture, 'repo')
      models.script(completingScript())
      const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
      const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]
      const evidenceText = await fs.readFile(path.join(fixture.dataDir, 'development', done.taskKey, 'evidence.json'), 'utf8')
      const full: unknown = JSON.parse(evidenceText)
      const worktree = isRecord(full) ? records(full.worktrees)[0] : undefined

      assert.equal(run?.status, 'completed', item.kept)
      assert.equal(worktree?.diffTruncated, true)
      assertLongText(worktree?.diff, `${padding}${item.expected}${DIFF_TRUNCATION_MARKER}`, item.kept)
      // 境界の置き換えも redactions に数える
      assert.equal(run?.evidence?.redactions, 1, item.kept)
      assert.equal(evidenceText.includes(item.fragment), false, item.kept)
      assert.equal(dumpLedger(fixture).includes(item.fragment), false, item.kept)
    } finally {
      await teardown(value, attempt)
    }
  }
})

test('attempt: 先頭を切った検証の出力の境界をまたぐ秘密の値と URL の userinfo は、evidence.json にも台帳にも一部も残らない', async () => {
  const secret = 'Zq8kW3mX9pL2vN7r'
  const value = await setup({ ARAYA_TEST_TOKEN: secret, ARAYA_TEST_URL: 'https://user:pass@example.invalid/repo.git' })
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })
  // 検証の出力は末尾の上限の byte 数だけを残す。stdout は秘密の値の 6 文字目の後、stderr は userinfo の us の後が境界になる
  const stdoutPadding = filler(VERIFICATION_OUTPUT_BYTES - (secret.length - 6))
  const stderrHead = 'clone https://us'
  const stderrKept = 'er:pass@example.invalid/repo.git '
  const stderrPadding = filler(VERIFICATION_OUTPUT_BYTES - stderrKept.length)
  const script = [
    'const env = process.env',
    `process.stdout.write(env.ARAYA_TEST_TOKEN + ${JSON.stringify(stdoutPadding)})`,
    `process.stderr.write("clone " + env.ARAYA_TEST_URL + " " + ${JSON.stringify(stderrPadding)})`
  ].join('\n')

  try {
    await createRepository(fixture, 'repo')
    models.script(completingScript({ command: [process.execPath, '-e', script] }))
    const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
    const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]
    const evidenceText = await fs.readFile(path.join(fixture.dataDir, 'development', done.taskKey, 'evidence.json'), 'utf8')
    const full: unknown = JSON.parse(evidenceText)
    const verification = isRecord(full) ? records(records(full.worktrees)[0]?.verifications)[0] : undefined

    assert.equal(run?.status, 'completed')
    assert.equal(stderrHead.length + stderrKept.length + stderrPadding.length > VERIFICATION_OUTPUT_BYTES, true)
    assertLongText(verification?.stdout, `[REDACTED]${stdoutPadding}`, 'stdout')
    assertLongText(verification?.stderr, `[REDACTED]@example.invalid/repo.git ${stderrPadding}`, 'stderr')
    assert.equal(run?.evidence?.redactions, 2)

    for (const fragment of [secret.slice(6), 'er:pass']) {
      assert.equal(evidenceText.includes(fragment), false, fragment)
      assert.equal(dumpLedger(fixture).includes(fragment), false, fragment)
    }
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 先頭を切った差分の収集の git の stderr は境界も置き換え、failure_detail に URL の userinfo と秘密の値が一部も残らない', async () => {
  const secret = 'Hj4tR8nB2cY6wE1u'
  const prefix = 'git rev-parse --show-toplevel failed: '
  // git の stderr は末尾の 8 KiB だけを残す。その先頭が userinfo と秘密の値の途中から始まる
  const cases = [
    { stderr: 'er:pass@example.invalid/repo.git denied', expected: `${prefix}[REDACTED]@example.invalid/repo.git denied`, fragment: 'er:pass' },
    { stderr: `${secret.slice(6)} denied`, expected: `${prefix}[REDACTED] denied`, fragment: secret.slice(6) }
  ]

  for (const item of cases) {
    const value = await setup({ ARAYA_TEST_TOKEN: secret })
    const { fixture, models, systemd } = value
    const ops: typeof systemd.ops = {
      ...systemd.ops,
      launchInScope(unit, command, args, options) {
        const worktreeIndex = args.indexOf('-C') + 1

        if (args.includes('--show-toplevel') && (args[worktreeIndex] ?? '').includes(`${path.sep}.worktree${path.sep}`)) {
          return Promise.resolve({
            exitCode: 128,
            signal: null,
            stdout: '',
            stderr: item.stderr,
            stdoutBytes: 0,
            stderrBytes: 8 * 1024 + 100,
            terminationReason: undefined,
            terminationConfirmed: true
          })
        }

        return systemd.ops.launchInScope(unit, command, args, options)
      }
    }
    const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: ops })

    try {
      await createRepository(fixture, 'repo')
      models.script(completingScript())
      const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
      const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]

      assert.equal(run?.failureReason, 'evidence_collection_failed')
      assert.equal(run?.failureDetail, item.expected)
      assert.equal(dumpLedger(fixture).includes(item.fragment), false, item.fragment)
    } finally {
      await teardown(value, attempt)
    }
  }
})

test('attempt: 1試行の途中経過が 2000 件を超えると events.truncated を1件だけ記録し、それ以降は記録しない', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    models.script((view) => {
      if (view.toolResults.length > 0) {
        return answer('done')
      }

      // 1回の応答で 1001 件の read を呼ぶ（開始と終了で 2002 件）
      return fauxAssistantMessage(Array.from({ length: 1001 }, (_item, index) => {
        return fauxToolCall('read', { path: `missing-${index}.txt` })
      }), { stopReason: 'toolUse' })
    })
    await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
    const events = readEvents(fixture)

    assert.equal(events.filter((event) => {
      return event.type === 'tool.started' || event.type === 'tool.finished'
    }).length, 2000)
    assert.equal(events.filter((event) => {
      return event.type === 'events.truncated'
    }).length, 1)
    const truncatedAt = events.findIndex((event) => {
      return event.type === 'events.truncated'
    })
    assert.equal(events.slice(truncatedAt + 1).some((event) => {
      return event.type.startsWith('tool.')
    }), false)
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 検証の出力と報告の秘密は台帳にも evidence.json にも写らず、redactions に回数が残り、台帳の evidence には本文が無い', async () => {
  const secret = 'evidence-secret-value-9012'
  const value = await setup({ ARAYA_TEST_TOKEN: secret })
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    await createRepository(fixture, 'repo')
    models.script(completingScript({
      // コマンドの文字列には userinfo 付きの URL を書かず、出力にだけ出す
      command: [process.execPath, '-e', 'console.log(process.env.ARAYA_TEST_TOKEN); console.error("clone https://" + "user:pass@example.invalid/repo.git")'],
      report: `検証しました。token は ${secret} でした`
    }))
    const done = await attempt.runAttempt(taskInput(), defaultSettings(fixture, models.model))
    const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]
    const evidenceText = await fs.readFile(path.join(fixture.dataDir, 'development', done.taskKey, 'evidence.json'), 'utf8')

    assert.equal(run?.status, 'completed')
    assert.equal(run?.summary, '検証しました。token は [REDACTED] でした')
    assert.equal(run?.evidence?.redactions, 3)
    assert.equal(dumpLedger(fixture).includes(secret), false)
    assert.equal(dumpLedger(fixture).includes('https://user:pass@'), false)
    assert.equal(evidenceText.includes(secret), false)
    assert.equal(evidenceText.includes('https://user:pass@'), false)
    const full: unknown = JSON.parse(evidenceText)
    const verification = isRecord(full) ? records(records(full.worktrees)[0]?.verifications)[0] : undefined
    assert.equal(verification?.stdout, '[REDACTED]\n')
    assert.equal(verification?.stderr, 'clone https://[REDACTED]@example.invalid/repo.git\n')
    assert.equal(isRecord(full) ? full.redactions : undefined, 3)
    const ledgerVerification = records(records(run?.evidence?.worktrees)[0]?.verifications)[0]
    assert.equal(ledgerVerification !== undefined && 'stdout' in ledgerVerification, false)
    assert.equal(ledgerVerification !== undefined && 'stderr' in ledgerVerification, false)
    assert.equal(dumpLedger(fixture).includes('+changed'), false)
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 中止された試行は台帳の stop_reason で結果を決め、実行中の bash は止まる', async () => {
  const value = await setup()
  const { fixture, models, systemd } = value
  const attempt = await openAttemptHarness(fixture, { models: models.runtime, systemd: systemd.ops })

  try {
    const repo = await createRepository(fixture, 'repo')
    models.script(completingScript({
      bash: (worktreePath) => {
        return `printf 'changed\\n' >> ${worktreePath}/README.md; sleep 30`
      }
    }))
    const cases = [
      { reason: 'agent_timeout', detail: null, status: 'failed', failureReason: 'agent_timeout' },
      { reason: 'cancelled', detail: null, status: 'failed', failureReason: 'cancelled' },
      { reason: 'restart_limit', detail: null, status: 'blocked', failureReason: 'restart_limit' },
      { reason: 'attempt_error', detail: 'missing_task', status: 'failed', failureReason: 'attempt_error' }
    ] as const

    for (const item of cases) {
      const started = await attempt.startAttempt(taskInput({ title: item.reason }), defaultSettings(fixture, models.model))
      const pattern = `araya-${fixture.hash}-${started.taskKey}-*.scope`
      // bash が README.md に追記し（その後は sleep で動き続ける）、印の付いた process もある状態になるまで待ってから、試行を止める。
      // 印は worktree を作る git にも付くので、印だけを待つと追記の前に止めることがある。そうなると、止める理由が agent_timeout の case で差分が空になる
      await waitUntil(async () => {
        return (await readTextIfExists(path.join(repo, '.worktree', `araya-${started.taskKey}`, 'README.md'))).includes('changed') && (await findMarkedProcesses(pattern)).length > 0
      }, `bash of ${item.reason}`)
      assert.equal(attempt.ledger.beginStop(started.taskKey, item.reason, item.detail), true)
      assert.equal(await attempt.harness.abortTask(started.taskId, ctx), 'marked')
      const done = await attempt.finishAttempt(started)
      const run = attempt.ledger.showTask(done.ledgerTaskId, { events: 0 }).attempts[0]

      assert.equal(done.outcome.status, 'aborted', item.reason)
      assert.equal(run?.status, item.status, item.reason)
      assert.equal(run?.failureReason, item.failureReason, item.reason)
      assert.deepEqual(await findMarkedProcesses(pattern), [], item.reason)
      const worktree = records(run?.evidence?.worktrees)[0]
      assert.equal(worktree?.worktreePath, path.join(repo, '.worktree', `araya-${started.taskKey}`), item.reason)
      assert.equal(worktree?.branch, `araya/${started.taskKey}`, item.reason)

      if (item.reason === 'agent_timeout') {
        // 差分を集め、登録された検証は実行しない
        assert.deepEqual(worktree?.changedFiles, ['README.md'])
        assert.deepEqual(run?.evidence?.agent, { error: 'agent_timeout', model: { ...models.model, thinkingLevel: 'off', source: 'araya-config' } })
        assert.equal(run?.evidence?.bodiesStored, true)
      } else {
        // worktree だけの evidence
        assert.equal(run?.evidence?.bodiesStored, false, item.reason)
        assert.equal(worktree !== undefined && 'changedFiles' in worktree, false, item.reason)
        assert.equal('agent' in (run?.evidence ?? {}), false, item.reason)
      }

      if (item.reason === 'attempt_error') {
        assert.equal(run?.failureDetail, 'missing_task')
      }
    }
  } finally {
    await teardown(value, attempt)
  }
})

test('attempt: 再実行の試行の input には、追加の指示・前回の結果・前回の worktree が課題の本文に入り、途中で止まった試行なら注意の1行が入る', async () => {
  const fixture = await createRunnerFixture()
  const ledger = openTaskLedger(fixture.dataDir)

  try {
    const settings = defaultSettings(fixture, null)
    const worktree = { worktreePath: path.join(fixture.devRoot, 'repo', '.worktree', 'araya-task-1-1-abcdef'), branch: 'araya/task-1-1-abcdef' }
    const cases = [
      { failureReason: 'agent_timeout', agent: { error: 'agent_timeout' }, interrupted: true },
      { failureReason: 'agent_failed', agent: { error: 'model_unavailable', errorMessage: 'no configured Pi model is available' }, interrupted: false }
    ]

    for (const item of cases) {
      const created = ledger.createTask(taskInput({ title: item.failureReason, constraints: ['依存を追加しない'] }))
      const first = ledger.claimNextAttempt(1, settings)

      if (first === null) {
        throw new Error('the first attempt was not claimed')
      }

      ledger.recordResult(first.taskKey, {
        status: 'failed',
        failureReason: item.failureReason,
        failureDetail: null,
        summary: '途中まで進めました',
        decisionQuestion: null,
        model: null,
        evidence: { outcome: 'failed', failureReason: item.failureReason, agent: item.agent, worktrees: [{ ...worktree, repository: 'repo' }] }
      }, { taskKey: first.taskKey, addMs: 0 })
      ledger.retryTask(created.task.id, { note: 'B の API を使ってください', confirmSideEffects: item.interrupted })
      const second = ledger.claimNextAttempt(1, settings)

      if (second === null) {
        throw new Error('the second attempt was not claimed')
      }

      const input = buildAttemptInput(second)

      assert.notEqual(input.taskKey, first.taskKey)
      assert.equal(input.attempt, 2)
      assert.deepEqual(input.previousAttempt, { attempt: 1, worktrees: [worktree] })
      assert.equal(input.body, [
        '目的:',
        'README に1行足し、検証を登録する',
        '',
        '制約:',
        '- 依存を追加しない',
        '',
        '前回の試行（1回目）の結果:',
        `- 結果: failed（${item.failureReason}）`,
        '- 報告: 途中まで進めました',
        '- 前回の worktree（編集しない。必要なら読んでよい）:',
        `  - ${worktree.worktreePath}（branch ${worktree.branch}）`,
        ...(item.interrupted
          ? ['- 注意: 前回の試行は作業の途中で止まりました。外部への変更が済んでいる可能性があります。同じ操作をくり返す前に、前回の worktree と外部の状態を確かめてください。']
          : []),
        '',
        '追加の指示:',
        'B の API を使ってください'
      ].join('\n'))
      ledger.recordResult(second.taskKey, {
        status: 'completed', failureReason: null, failureDetail: null, summary: null, decisionQuestion: null, model: null, evidence: {}
      }, { taskKey: second.taskKey, addMs: 0 })
    }
  } finally {
    ledger.close()
    await removeRunnerFixture(fixture)
  }
})
