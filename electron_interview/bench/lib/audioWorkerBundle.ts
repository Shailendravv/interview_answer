// AudioService spawns `join(__dirname, 'audioWorker.js')`, which only exists in
// the electron-vite build output. The suites mock worker_threads.Worker so the
// app's real worker source (src/audio/audioWorker.ts) is bundled fresh and run
// in a real worker thread -- same code, same threading, no stale build.
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appRoot } from './electronStub'

let bundled: string | null = null

export function bundledAudioWorkerPath(): string {
  if (bundled) return bundled
  const outfile = join(mkdtempSync(join(tmpdir(), 'eval-worker-')), 'audioWorker.cjs')
  buildSync({
    entryPoints: [join(appRoot, 'src', 'audio', 'audioWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
  bundled = outfile
  return outfile
}
