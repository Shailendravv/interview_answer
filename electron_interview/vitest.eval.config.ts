import { defineConfig } from 'vitest/config'

// Evaluation harness (bench/), kept separate from `npm test`: these suites talk
// to real Ollama / whisper-server processes and take minutes, not milliseconds.
// Run through bench/run.mjs so they execute under Electron's Node ABI.
export default defineConfig({
  test: {
    include: ['bench/**/*.eval.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
