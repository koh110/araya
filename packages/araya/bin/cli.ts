#!/usr/bin/env node
import { exitCodeOf, runCli } from '../src/cli.ts'

runCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = exitCodeOf(error)
})
