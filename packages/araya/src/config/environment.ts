import os from 'node:os'
import path from 'node:path'

import type { DevelopmentModel } from './model.ts'

// 設定ファイルの値は CLI が loadConfigFile で読んで置き換える。読まない経路（test など）では model を指定しない
const NO_DEVELOPMENT_MODEL: DevelopmentModel | null = null

function numberFromEnv(
  value: string | undefined,
  fallback: number,
  options: { minimum?: number; maximum?: number } = {}
) {
  if (value === undefined || value === '') {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const bounded = Math.max(options.minimum ?? 0, Math.floor(parsed))

  return Math.min(options.maximum ?? Number.MAX_SAFE_INTEGER, bounded)
}

// SDK は process.env を実行時と import 時の両方で読む。import 時の保存先を固定するので、最初の import を Araya の環境内で行う。
let piEnvironmentActive = false
let piSdkModule: Promise<typeof import('@earendil-works/pi-coding-agent')> | undefined

export async function withPiEnvironment<T>(agentDir: string, start: () => Promise<T>) {
  if (piEnvironmentActive) {
    throw new Error('Pi environment is already active in this process')
  }

  piEnvironmentActive = true
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR
  }

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir
    delete process.env.PI_CODING_AGENT_SESSION_DIR
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

  const loading = withPiEnvironment(agentDir, async () => import('@earendil-works/pi-coding-agent'))
  piSdkModule = loading
  void loading.catch(() => {
    if (piSdkModule === loading) {
      piSdkModule = undefined
    }
  })

  return loading
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(
    env.ARAYA_DATA_DIR || path.join(env.HOME || os.homedir(), '.araya')
  )

  return {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    devRoot: path.resolve(env.ARAYA_DEV_ROOT || path.join(os.homedir(), 'dev')),
    piAgentDir: path.join(dataDir, 'pi'),
    developmentTimeoutMs: numberFromEnv(env.ARAYA_DEVELOPMENT_TIMEOUT_MS, 20 * 60 * 1000, {
      minimum: 1000,
      maximum: 60 * 60 * 1000
    }),
    verificationTimeoutMs: numberFromEnv(env.ARAYA_VERIFICATION_TIMEOUT_MS, 5 * 60 * 1000, {
      minimum: 1000,
      maximum: 60 * 60 * 1000
    }),
    developmentModel: NO_DEVELOPMENT_MODEL,
    // araya task・araya runner の command が使う環境変数（unit file に書く変数の選別、秘密の値の置き換え）
    env: { ...env, PI_CODING_AGENT_DIR: path.join(dataDir, 'pi'), PI_CODING_AGENT_SESSION_DIR: undefined }
  }
}
