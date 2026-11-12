import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const packagePath = fileURLToPath(
  new URL('../package.json', import.meta.resolve('@earendil-works/pi-coding-agent')),
)
const manifest = JSON.parse(await readFile(packagePath, 'utf8'))

if (manifest.piConfig?.name !== 'araya') {
  manifest.piConfig = { ...manifest.piConfig, name: 'araya' }
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
}
