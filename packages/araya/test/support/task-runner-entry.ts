import path from 'node:path'
import { parseArgs } from 'node:util'

import { collectSecretValues } from '../../src/redaction.ts'
import type { AttemptFaults } from '../../src/task-attempt.ts'
import { createRunnerLog, installRunnerProcessHandlers, runTaskRunner, type RunnerFaults } from '../../src/task-runner.ts'
import { createFakeSystemd } from './fake-systemd.ts'
import { createFauxModels } from './faux-shiki.ts'
import { isProcessFault, processStep, recordFilePath } from './runner-process.ts'

// process をまたぐ test 用の runner の entrypoint（test の directory に置き、build と package には含めない）。
// 既定では unit の確認を飛ばし、偽物の systemd（記録は --work-dir の file に追記する）と faux の model で runTaskRunner を呼ぶ。
// --verify-unit を付けると、本物の runner と同じく unit を確かめ、本物の systemd の操作を使う（本物の systemd の test。
// systemd-run --user の transient unit の中で起動する）。model はどちらも faux。
// --fault を付けると、決まった時点で自分を SIGKILL する（落ちたときの再現）。--restart-limit は pi-durable の restartLimit
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'data-dir': { type: 'string' },
    'work-dir': { type: 'string' },
    fault: { type: 'string' },
    'verify-unit': { type: 'boolean' },
    'restart-limit': { type: 'string' }
  },
  strict: true
})
const dataDirArg = values['data-dir']
const workDirArg = values['work-dir']
const fault = values.fault
const verifyUnit = values['verify-unit'] === true
const restartLimit = values['restart-limit'] === undefined ? undefined : Number(values['restart-limit'])
const agentDir = process.env.PI_CODING_AGENT_DIR

if (dataDirArg === undefined || workDirArg === undefined || agentDir === undefined) {
  console.error('--data-dir、--work-dir と PI_CODING_AGENT_DIR が必要です')
  process.exit(2)
}

if (fault !== undefined && !isProcessFault(fault)) {
  console.error(`未知の --fault です: ${fault}`)
  process.exit(2)
}

if (restartLimit !== undefined && (!Number.isSafeInteger(restartLimit) || restartLimit < 1)) {
  console.error(`--restart-limit は 1 以上の整数です: ${values['restart-limit'] ?? ''}`)
  process.exit(2)
}

const dataDir = path.resolve(dataDirArg)
const workDir = path.resolve(workDirArg)
const controller = new AbortController()
installRunnerProcessHandlers(controller, createRunnerLog(dataDir, collectSecretValues(process.env)))

const models = await createFauxModels({ agentDir, dataDir })
models.script((view) => {
  return processStep(view, workDir)
})
// 本物の systemd を使うときは偽物を作らない（偽物の記録の file も書かない）
const fakeSystemd = verifyUnit ? null : createFakeSystemd({ recordFile: recordFilePath(workDir) })

// SIGKILL で落ちる。signal が届くまで先へ進まない
function killSelf() {
  process.kill(process.pid, 'SIGKILL')

  return new Promise<void>(() => {})
}

function faultsOf(name: string | undefined) {
  switch (name) {
    case 'kill_after_claim':
      return { afterClaimCommit: killSelf } satisfies RunnerFaults
    case 'kill_after_evidence_file':
      return { afterEvidenceFile: killSelf } satisfies AttemptFaults
    case 'kill_before_agent_commit':
      return {
        beforePhaseCommit: (phase: string) => {
          return phase === 'agent' ? killSelf() : undefined
        }
      } satisfies AttemptFaults
    default:
      return {}
  }
}

const code = await runTaskRunner({
  dataDir,
  env: process.env,
  platform: process.platform,
  stopSignal: controller.signal,
  verifyUnit,
  createModels: async () => {
    return models.runtime
  },
  ...(fakeSystemd === null ? {} : {
    createSystemdOps: async () => {
      return fakeSystemd.ops
    }
  }),
  ...(restartLimit === undefined ? {} : { restartLimit }),
  pollMs: 50,
  faults: faultsOf(fault)
})
process.exit(code)
