import { parseArgs } from 'node:util'

export function parseCliArguments(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
        default: false
      }
    },
    allowPositionals: true
  })

  return { help: values.help, positionals }
}
