import { rm } from 'node:fs/promises'

// tsc は消した source の出力を削除しないため、build の前に出力先を空にして package に残らないようにする
await rm(new URL('../packages/araya/dist', import.meta.url), { recursive: true, force: true })
