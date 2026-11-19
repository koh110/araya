import os from 'node:os'
import path from 'node:path'

import type { ConfigModel } from './model.ts'

// 設定ファイルの値は agent session の開始時に loadConfigFile で読んで置き換える。読まない経路（test など）では model を指定しない
const NO_AGENT_MODEL: ConfigModel | null = null

// SDK は process.env を実行時と import 時の両方で読む。最初の import 前に Araya 用の環境変数を設定する。
let piEnvironmentActive = false
let piSdkModule: Promise<typeof import('@earendil-works/pi-coding-agent')> | undefined

export async function withPiEnvironment<T>(agentDir: string, start: () => Promise<T>) {
  if (piEnvironmentActive) {
    throw new Error('Pi environment is already active in this process')
  }

  piEnvironmentActive = true
  const previous = {
    ARAYA_CODING_AGENT_DIR: process.env.ARAYA_CODING_AGENT_DIR,
    ARAYA_CODING_AGENT_SESSION_DIR: process.env.ARAYA_CODING_AGENT_SESSION_DIR,
    PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
  }

  try {
    process.env.ARAYA_CODING_AGENT_DIR = agentDir
    delete process.env.ARAYA_CODING_AGENT_SESSION_DIR
    delete process.env.PI_PACKAGE_DIR
    return await start()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    piEnvironmentActive = false
  }
}

export function loadPiSdk(agentDir: string) {
  if (piSdkModule !== undefined) {
    return piSdkModule
  }

  const loading = withPiEnvironment(agentDir, async () => {
    return import('@earendil-works/pi-coding-agent')
  })
  piSdkModule = loading
  void loading.catch(() => {
    if (piSdkModule === loading) {
      piSdkModule = undefined
    }
  })

  return loading
}

export function withoutDiscordEnvironment(env: NodeJS.ProcessEnv) {
  const filtered: Record<string, string> = {}

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('ARAYA_DISCORD_') && value !== undefined) {
      filtered[name] = value
    }
  }

  return filtered
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(env.ARAYA_DATA_DIR || path.join(env.HOME || os.homedir(), '.araya'))

  return {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    devRoot: path.resolve(env.ARAYA_DEV_ROOT || path.join(os.homedir(), 'dev')),
    piAgentDir: path.join(dataDir, 'pi'),
    agentModel: NO_AGENT_MODEL,
    // Discord bot の unit file に書く環境変数の選別・秘密の値の置き換えが使う
    env: {
      ...env,
      ARAYA_CODING_AGENT_DIR: path.join(dataDir, 'pi'),
      ARAYA_CODING_AGENT_SESSION_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
      PI_CODING_AGENT_SESSION_DIR: undefined,
      PI_PACKAGE_DIR: undefined,
    },
  }
}
