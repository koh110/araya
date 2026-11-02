import assert from 'node:assert/strict'
import test from 'node:test'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'

import { loadConfig, withoutDiscordEnvironment } from '../src/config/environment.ts'
import { createDevelopmentExecutionEnv } from '../src/infrastructure/development-execution-env.ts'

test('development subprocess environment excludes Discord settings from base and extra env', async () => {
  const config = loadConfig({
    HOME: '/home/test',
    ARAYA_DISCORD_BOT_TOKEN: 'synthetic-config-value',
    ARAYA_DISCORD_SYNTHETIC_TEST_VALUE: 'synthetic-base-value',
    ARAYA_TASK_SETTING: 'keep-me',
  })
  const developmentEnvironment = withoutDiscordEnvironment(config.env)

  assert.equal(developmentEnvironment.ARAYA_DISCORD_BOT_TOKEN, undefined)
  assert.equal(developmentEnvironment.ARAYA_TASK_SETTING, 'keep-me')

  const environment = createDevelopmentExecutionEnv({
    cwd: process.cwd(),
    shellEnv: config.env,
  })
  const output: string[] = []
  const result = await environment.exec(
    [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify({discordKeys:Object.keys(process.env).filter((key)=>key.startsWith("ARAYA_DISCORD_")),taskSetting:process.env.ARAYA_TASK_SETTING,extraSetting:process.env.ARAYA_TASK_EXTRA_SETTING}))',
    ],
    {
      env: {
        ARAYA_DISCORD_SYNTHETIC_EXTRA_VALUE: 'synthetic-extra-value',
        ARAYA_TASK_EXTRA_SETTING: 'keep-extra',
      },
      onOutput: (text) => {
        output.push(text)
      },
    },
    BACKGROUND_CONTEXT,
  )

  if (!result.ok) {
    assert.fail(result.error.message)
  }

  assert.deepEqual(JSON.parse(output.join('')), {
    discordKeys: [],
    taskSetting: 'keep-me',
    extraSetting: 'keep-extra',
  })
})
