// Launches the evaluation suites under Electron's bundled Node.
//
// better-sqlite3 is rebuilt for Electron's ABI (postinstall), so the app's real
// DatabaseService cannot load under plain Node. ELECTRON_RUN_AS_NODE=1 runs the
// Electron binary as a plain Node runtime with the matching ABI, which lets the
// harness exercise production modules instead of fakes.
//
// Usage: node bench/run.mjs [suite...] [--runs=5] [--engine=cpu|cuda|vulkan] [--verbose]
//   suite: routing | answers | stt | e2e   (default: all)
// Flags are passed to the suites as EVAL_* environment variables.
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SUITES = new Set(['routing', 'answers', 'stt', 'e2e', 'fallback'])
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const files = []

for (const arg of process.argv.slice(2)) {
  const flag = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
  if (flag) {
    const name = 'EVAL_' + flag[1].toUpperCase().replace(/-/g, '_')
    env[name] = flag[2] ?? '1'
  } else if (SUITES.has(arg)) {
    files.push(`bench/${arg}.eval.ts`)
  } else {
    console.error(`Unknown argument "${arg}". Suites: ${[...SUITES].join(', ')}`)
    process.exit(2)
  }
}

const result = spawnSync(
  electronBinary,
  [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '-c', 'vitest.eval.config.ts', ...files],
  { stdio: 'inherit', env, cwd: root }
)
process.exit(result.status ?? 1)
