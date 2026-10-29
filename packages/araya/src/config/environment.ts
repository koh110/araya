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

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = path.resolve(
    env.ARAYA_DATA_DIR ?? path.join(os.homedir(), '.araya')
  )

  return {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    devRoot: path.resolve(env.ARAYA_DEV_ROOT || path.join(os.homedir(), 'dev')),
    piAgentDir: env.PI_CODING_AGENT_DIR || undefined,
    inboxDir: path.resolve(env.ARAYA_INBOX_DIR ?? path.join(dataDir, 'inbox')),
    statusFile: path.resolve(env.ARAYA_STATUS_FILE ?? path.join(dataDir, 'status.json')),
    controlPlanePath: path.resolve(env.ARAYA_CONTROL_PLANE_PATH ?? path.join(dataDir, 'araya.sqlite')),
    piDurablePath: path.resolve(env.ARAYA_PI_DURABLE_PATH ?? path.join(dataDir, 'pi-durable.sqlite')),
    intervalMs: numberFromEnv(env.ARAYA_INTERVAL_MS, 15 * 60 * 1000, { minimum: 0 }),
    maxActions: numberFromEnv(env.ARAYA_MAX_ACTIONS, 3, { minimum: 1 }),
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
    env: { ...env }
  }
}
