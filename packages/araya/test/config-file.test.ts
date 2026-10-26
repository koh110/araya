import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initializeConfigFromPiSettings, loadConfigFile } from '../src/config-file.ts'

async function makeTempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-config-file-test-')))
}

function escapeRegExp(value: string) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

test('config file: path に何も無ければ設定なしとして扱う', async () => {
  const root = await makeTempDir()

  try {
    assert.deepEqual(await loadConfigFile(path.join(root, 'config.json')), { developmentModel: null })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config file: 空の object と development の無い設定は設定なしと同じ', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')

  try {
    await fs.writeFile(configPath, '{}\n', 'utf8')
    assert.deepEqual(await loadConfigFile(configPath), { developmentModel: null })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config file: development の model と thinkingLevel を読み、model は最初の / で分ける', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')

  try {
    await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openai/gpt-5.5', thinkingLevel: 'high' } }), 'utf8')
    assert.deepEqual(await loadConfigFile(configPath), {
      developmentModel: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'high' }
    })

    await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openrouter/moonshotai/kimi-k2.6' } }), 'utf8')
    assert.deepEqual(await loadConfigFile(configPath), {
      developmentModel: { provider: 'openrouter', id: 'moonshotai/kimi-k2.6', thinkingLevel: null }
    })

    // 200文字ちょうどの model は受け付ける
    const longModel = `p/${'m'.repeat(198)}`
    await fs.writeFile(configPath, JSON.stringify({ development: { model: longModel } }), 'utf8')
    assert.deepEqual(await loadConfigFile(configPath), {
      developmentModel: { provider: 'p', id: 'm'.repeat(198), thinkingLevel: null }
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config file: 7種類の thinkingLevel をすべて受け付ける', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')

  try {
    for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      await fs.writeFile(configPath, JSON.stringify({ development: { model: 'openai/gpt-5.5', thinkingLevel } }), 'utf8')
      assert.deepEqual(await loadConfigFile(configPath), {
        developmentModel: { provider: 'openai', id: 'gpt-5.5', thinkingLevel }
      }, thinkingLevel)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config file: symlink の先が通常の file なら読む', async () => {
  const root = await makeTempDir()
  const target = path.join(root, 'real-config.json')
  const configPath = path.join(root, 'config.json')

  try {
    await fs.writeFile(target, JSON.stringify({ development: { model: 'openai/gpt-5.5' } }), 'utf8')
    await fs.symlink(target, configPath)
    assert.deepEqual(await loadConfigFile(configPath), {
      developmentModel: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null }
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config file: 不正な内容は path と理由を含む message で拒否する', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')
  const cases = [
    { name: 'JSON の誤り', content: '{"development": ', reason: /not valid JSON/u },
    { name: 'array', content: '[]', reason: /top level must be a JSON object/u },
    { name: 'null', content: 'null', reason: /top level must be a JSON object/u },
    { name: 'string', content: '"openai/gpt-5.5"', reason: /top level must be a JSON object/u },
    { name: '知らない top level の key', content: JSON.stringify({ model: 'openai/gpt-5.5' }), reason: /unknown key\(s\): model/u },
    { name: 'development が null', content: JSON.stringify({ development: null }), reason: /development must be an object/u },
    { name: 'development が array', content: JSON.stringify({ development: [] }), reason: /development must be an object/u },
    { name: 'model が無い', content: JSON.stringify({ development: { thinkingLevel: 'high' } }), reason: /development\.model is required/u },
    {
      name: 'fallbackModels は未対応の key',
      content: JSON.stringify({ development: { model: 'openai/gpt-5.5', fallbackModels: [] } }),
      reason: /unknown key\(s\) in development: fallbackModels/u
    },
    { name: 'model が null', content: JSON.stringify({ development: { model: null } }), reason: /development\.model must be/u },
    { name: 'model が数値', content: JSON.stringify({ development: { model: 5 } }), reason: /development\.model must be/u },
    { name: 'model に / が無い', content: JSON.stringify({ development: { model: 'gpt-5.5' } }), reason: /development\.model must be/u },
    { name: 'provider が空', content: JSON.stringify({ development: { model: '/gpt-5.5' } }), reason: /development\.model must be/u },
    { name: 'model id が空', content: JSON.stringify({ development: { model: 'openai/' } }), reason: /development\.model must be/u },
    { name: 'model に空白', content: JSON.stringify({ development: { model: 'openai/gpt 5.5' } }), reason: /development\.model must be/u },
    { name: 'model の前後の空白', content: JSON.stringify({ development: { model: ' openai/gpt-5.5' } }), reason: /development\.model must be/u },
    { name: 'model に制御文字', content: JSON.stringify({ development: { model: 'openai/gpt-5.5\u0007' } }), reason: /development\.model must be/u },
    {
      name: 'model が200文字超',
      content: JSON.stringify({ development: { model: `p/${'m'.repeat(199)}` } }),
      reason: /development\.model must be/u
    },
    {
      name: '不正な thinkingLevel',
      content: JSON.stringify({ development: { model: 'openai/gpt-5.5', thinkingLevel: 'extreme' } }),
      reason: /development\.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, max/u
    },
    {
      name: 'thinkingLevel が null',
      content: JSON.stringify({ development: { model: 'openai/gpt-5.5', thinkingLevel: null } }),
      reason: /development\.thinkingLevel must be one of/u
    }
  ]

  try {
    for (const sample of cases) {
      await fs.writeFile(configPath, sample.content, 'utf8')
      await assert.rejects(loadConfigFile(configPath), (error: unknown) => {
        assert.ok(error instanceof Error, sample.name)
        assert.match(error.message, new RegExp(`^invalid Araya config file ${escapeRegExp(configPath)}: `, 'u'), sample.name)
        assert.match(error.message, sample.reason, sample.name)
        return true
      }, sample.name)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config file: 64 KiB を超える file、UTF-8 でない file、directory、壊れた symlink を拒否する', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')
  const padded = JSON.stringify({ development: { model: 'openai/gpt-5.5' } })
  const cases = [
    {
      name: '64 KiB 超',
      prepare: async () => {
        await fs.writeFile(configPath, `${padded}${' '.repeat(64 * 1024 + 1 - padded.length)}`, 'utf8')
      },
      reason: /exceeds 65536 bytes/u
    },
    {
      name: 'UTF-8 でない',
      prepare: async () => {
        await fs.writeFile(configPath, Buffer.from([0x7b, 0x7d, 0xff]))
      },
      reason: /not valid UTF-8/u
    },
    {
      name: 'directory',
      prepare: async () => {
        await fs.mkdir(configPath)
      },
      reason: /not a regular file/u
    },
    {
      name: '壊れた symlink',
      prepare: async () => {
        await fs.symlink(path.join(root, 'missing.json'), configPath)
      },
      reason: /broken symbolic link/u
    }
  ]

  try {
    // 64 KiB ちょうどは読める
    await fs.writeFile(configPath, `${padded}${' '.repeat(64 * 1024 - padded.length)}`, 'utf8')
    assert.deepEqual(await loadConfigFile(configPath), {
      developmentModel: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null }
    })

    for (const sample of cases) {
      await fs.rm(configPath, { recursive: true, force: true })
      await sample.prepare()
      await assert.rejects(loadConfigFile(configPath), (error: unknown) => {
        assert.ok(error instanceof Error, sample.name)
        assert.match(error.message, new RegExp(`^invalid Araya config file ${escapeRegExp(configPath)}: `, 'u'), sample.name)
        assert.match(error.message, sample.reason, sample.name)
        return true
      }, sample.name)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config bootstrap: Pi の明示的な default model が無ければ config.json を作らない', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')
  const settingsPath = path.join(root, 'settings.json')

  try {
    await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: 'faux' }), 'utf8')

    assert.deepEqual(await initializeConfigFromPiSettings(configPath, settingsPath), {
      status: 'skipped',
      configPath,
      reason: 'pi_default_missing'
    })
    await assert.rejects(fs.access(configPath), { code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config bootstrap: 不正な Pi settings は config.json に反映しない', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')
  const settingsPath = path.join(root, 'settings.json')

  try {
    await fs.writeFile(settingsPath, '{"defaultProvider":', 'utf8')

    assert.deepEqual(await initializeConfigFromPiSettings(configPath, settingsPath), {
      status: 'skipped',
      configPath,
      reason: 'pi_settings_invalid'
    })
    await assert.rejects(fs.access(configPath), { code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config bootstrap: 同時初期化では config.json を一度だけ排他的に作る', async () => {
  const root = await makeTempDir()
  const configPath = path.join(root, 'config.json')
  const settingsPath = path.join(root, 'settings.json')

  try {
    await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: 'faux', defaultModel: 'test-model' }), 'utf8')
    const results = await Promise.all([
      initializeConfigFromPiSettings(configPath, settingsPath),
      initializeConfigFromPiSettings(configPath, settingsPath)
    ])

    assert.deepEqual(results.map((result) => {
      return result.status
    }).sort(), ['created', 'existing'])
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), {
      development: { model: 'faux/test-model' }
    })
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600)
    assert.deepEqual((await fs.readdir(root)).sort(), ['config.json', 'settings.json'])
    assert.deepEqual(await loadConfigFile(configPath), {
      developmentModel: { provider: 'faux', id: 'test-model', thinkingLevel: null }
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
