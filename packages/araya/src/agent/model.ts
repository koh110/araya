import fs from 'node:fs/promises'
import path from 'node:path'

import { clampThinkingLevel, type ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { loadPiSdk } from '../config/environment.ts'
import { formatModel, type ConfigModel, type ThinkingLevel } from '../config/model.ts'

// thinking level が設定ファイルにも Pi の設定にも無いときの値。Pi の既定（core/defaults.js の DEFAULT_THINKING_LEVEL）に合わせる
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

export type ModelLookup = Pick<
  ModelRuntime,
  'getModel' | 'hasConfiguredAuth' | 'getAvailableSnapshot'
>

// Pi の設定（SettingsManager）のうち、model の既定を決めるもの
export type PiModelSettings = {
  getDefaultProvider(): string | undefined
  getDefaultModel(): string | undefined
  getDefaultThinkingLevel(): ThinkingLevel | undefined
  getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined
}

// session が使う model。source は、設定ファイル（config.json）と Pi の既定のどちらから決めたか
// clampThinkingLevel の返り値なので Pi 側の ThinkingLevel（'off' は Pi の値に写像済み）
export type AgentModel = {
  provider: string
  id: string
  thinkingLevel: PiThinkingLevel
  source: 'araya-config' | 'pi-settings'
}

export type AgentModelResolution =
  | { ok: true; model: AgentModel }
  | { ok: false; message: string }

// 設定ファイルの model、無ければ Pi の既定 model を使う。使えない model から別の model へは切り替えない
export function resolveAgentModel(
  models: ModelLookup,
  configured: ConfigModel | null,
  piSettings: PiModelSettings,
): AgentModelResolution {
  const provider = configured === null ? piSettings.getDefaultProvider() : configured.provider
  const id = configured === null ? piSettings.getDefaultModel() : configured.id

  if (provider === undefined || id === undefined) {
    return { ok: false, message: 'model が設定されていません。araya pi で /login と /model を実行してください' }
  }

  const found = models.getModel(provider, id)

  if (found === undefined) {
    return { ok: false, message: `${formatModel({ provider, id })} は Pi の model 一覧にありません` }
  }

  const usable =
    models.hasConfiguredAuth(provider) ||
    models.getAvailableSnapshot().some((candidate) => {
      return candidate.provider === provider && candidate.id === id
    })

  if (!usable) {
    return { ok: false, message: `${formatModel({ provider, id })} の認証がありません。araya pi で /login を実行してください` }
  }

  // Pi の agent 設定に 'off' は無い。設定が 'off' のときは最小の thinking に写像する
  const requestedRaw =
    configured?.thinkingLevel ??
    piSettings.getModelThinkingLevel(provider, id) ??
    piSettings.getDefaultThinkingLevel() ??
    DEFAULT_THINKING_LEVEL
  const requested = requestedRaw === 'off' ? 'minimal' : requestedRaw
  const clamped = clampThinkingLevel(found, requested)

  return {
    ok: true,
    model: {
      provider,
      id,
      thinkingLevel: clamped === 'off' ? 'minimal' : clamped,
      source: configured === null ? 'pi-settings' : 'araya-config',
    },
  }
}

// Pi の認証（auth.json）と model 一覧（models.json）を読む ModelRuntime。model 一覧の取得で network は使わない
export async function createModelRuntime(input: { agentDir: string; storeDir: string }) {
  const { ModelRuntime } = await loadPiSdk(input.agentDir)
  await fs.mkdir(input.storeDir, { recursive: true, mode: 0o700 })
  const runtime = await ModelRuntime.create({
    authPath: path.join(input.agentDir, 'auth.json'),
    modelsPath: path.join(input.agentDir, 'models.json'),
    modelsStorePath: path.join(input.storeDir, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  await runtime.refresh({ allowNetwork: false })

  return runtime
}

// Pi の settings.json（agentDir）を読む。project の設定は使わない
export async function createPiModelSettings(input: { agentDir: string; settingsDir: string }) {
  const { SettingsManager } = await loadPiSdk(input.agentDir)
  await fs.mkdir(input.settingsDir, { recursive: true, mode: 0o700 })

  return SettingsManager.create(input.settingsDir, input.agentDir, { projectTrusted: false })
}
