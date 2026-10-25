import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))

// build 済みの package（dist）の module で unit file を作る。npm test は build してから実行するので、dist が無ければ失敗にする
test('build 済み: unit file の ExecStart は dist/bin/task-runner.js の絶対 path で、通常の file', async () => {
  const moduleUrl = pathToFileURL(path.join(DIST_DIR, 'src', 'systemd-units.js')).href
  const script = `
    const { buildRunnerUnitFile, resolveRunnerEntrypoint } = await import(${JSON.stringify(moduleUrl)})
    const entrypoint = await resolveRunnerEntrypoint()
    process.stdout.write(buildRunnerUnitFile({
      dataDir: '/tmp/araya-data',
      nodePath: process.execPath,
      entrypoint,
      systemctlPath: '/usr/bin/systemctl',
      environment: [['PATH', '/usr/bin:/bin']]
    }))
  `
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script])
  const execStart = stdout.split('\n').find((line) => {
    return line.startsWith('ExecStart=')
  })
  const expected = path.join(DIST_DIR, 'bin', 'task-runner.js')

  assert.equal(execStart, `ExecStart=${process.execPath} ${expected} --data-dir /tmp/araya-data`)
  assert.equal(path.isAbsolute(expected), true)
  const stat = await fs.lstat(expected)
  assert.equal(stat.isFile(), true)
})
