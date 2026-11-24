import { configDefaults, defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['packages/araya/src/**/*.test.ts', 'packages/araya/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**'],
    maxWorkers: 8,
    // node:test からの移行で既定 timeout が短くならないようにし、20 秒 polling に余裕を確保する。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
