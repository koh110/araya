import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSystemPrompt,
  buildTaskPrompt,
  CREATE_WORKTREE_TOOL_TEXT,
  describeModelUnavailable,
  getWorktreePattern,
  REGISTER_VERIFICATION_TOOL_TEXT
} from '../src/development/shiki.ts'

const DEV_ROOT = '/home/araya/dev'
const TASK_KEY = 'task-12-1-k3m7qz'

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

test('shiki: 課題の prompt と system prompt に、開発 root・taskKey・worktree の場所と制約が入る', () => {
  const prompt = buildTaskPrompt({
    devRoot: DEV_ROOT,
    taskKey: TASK_KEY,
    title: '入力検証を追加する',
    task: '空の値を拒否する。'
  })
  const systemPrompt = buildSystemPrompt({ devRoot: DEV_ROOT, taskKey: TASK_KEY })

  assert.equal(getWorktreePattern({ taskKey: TASK_KEY }), `<repository>/.worktree/araya-${TASK_KEY}`)

  for (const text of [prompt, systemPrompt]) {
    assert.match(text, new RegExp(escapeRegExp(DEV_ROOT), 'u'))
    assert.match(text, new RegExp(`\\.worktree/araya-${TASK_KEY}`, 'u'))
    assert.match(text, /araya_create_worktree/u)
    assert.match(text, /araya_register_verification/u)
    assert.match(text, /commit/u)
    assert.match(text, /日本語/u)
  }

  assert.match(prompt, new RegExp(`^開発 root: ${escapeRegExp(DEV_ROOT)}$`, 'mu'))
  assert.match(prompt, new RegExp(`^課題の識別子: ${TASK_KEY}$`, 'mu'))
  assert.match(prompt, new RegExp(`^worktree の場所: <repository>/\\.worktree/araya-${TASK_KEY}（araya_create_worktree が作ります）$`, 'mu'))
  assert.match(prompt, /^題名: 入力検証を追加する$/mu)
  assert.match(prompt, /^<task>\n空の値を拒否する。\n<\/task>$/mu)
  assert.match(prompt, /作者が書いた課題/u)
  assert.match(systemPrompt, /main checkout/u)
  assert.match(systemPrompt, new RegExp(`branch araya/${TASK_KEY} で作られます`, 'u'))
  assert.match(systemPrompt, /origin\/main/u)
  assert.match(systemPrompt, /AGENTS\.md/u)
  assert.match(systemPrompt, /push/u)
  assert.match(systemPrompt, /認証情報/u)
  assert.match(systemPrompt, /Araya はあなたの終了後に/u)
})

test('shiki: model が使えないときの message', () => {
  const configured = { provider: 'openai', id: 'gpt-araya-missing' }

  assert.equal(
    describeModelUnavailable({ kind: 'not_in_model_list', configured }),
    'configured model openai/gpt-araya-missing is not in the Pi model list'
  )
  assert.equal(
    describeModelUnavailable({ kind: 'no_authentication', configured }),
    'configured model openai/gpt-araya-missing has no Pi authentication'
  )
  assert.equal(
    describeModelUnavailable({ kind: 'session_model_mismatch', configured, actual: { provider: 'anthropic', id: 'claude-x' } }),
    'Pi session model anthropic/claude-x does not match the configured model openai/gpt-araya-missing'
  )
  assert.equal(
    describeModelUnavailable({ kind: 'session_model_mismatch', configured, actual: undefined }),
    'Pi session model none does not match the configured model openai/gpt-araya-missing'
  )
  assert.equal(describeModelUnavailable({ kind: 'no_model' }), 'no configured Pi model is available')
})

test('shiki: tool の説明の文', () => {
  assert.deepEqual(CREATE_WORKTREE_TOOL_TEXT, {
    name: 'araya_create_worktree',
    label: 'Create task worktree',
    description: '課題用の Git worktree を、指定した repository の .worktree/ 配下に作ります。' +
      'repository を変更する前に、repository ごとに1回呼んでください。返された worktreePath の中だけを編集します。' +
      '同じ repository に再度呼ぶと、作成済みの worktree をそのまま返します。' +
      '.worktree が ignore されていない repository では、.git/info/exclude に /.worktree/ を追記します。',
    parameters: {
      repository: { description: '開発 root からの相対 path で指定する repository（main clone の root）。例: araya' },
      base: { description: 'worktree の起点にする git revision。既定は HEAD。通常は fetch した remote の既定 branch（例: origin/main）を指定する' }
    }
  })
  assert.deepEqual(REGISTER_VERIFICATION_TOOL_TEXT, {
    name: 'araya_register_verification',
    label: 'Register verification command',
    description: 'araya_create_worktree で作った worktree について、最終状態で通るべき検証コマンドを登録します。' +
      '作業の終了前に、変更した worktree ごとに少なくとも1件登録してください。' +
      'Araya は agent の終了後に、登録順に shell を通さず argv として実行し、すべて exit 0 のときだけ課題を完了とします。' +
      '同じ repository・cwd・command の登録は1件として扱います。',
    parameters: {
      repository: { description: 'araya_create_worktree に指定した repository' },
      command: { description: '実行するコマンドの argv。例: ["npm", "test"]。shell の構文は使えない' },
      cwd: { description: 'worktree root からの相対 path の実行 directory。省略時は worktree root' }
    }
  })
})
