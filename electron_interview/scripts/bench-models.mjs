// Whisper MODEL bake-off: latency + transcript quality per model on the same
// audio, against one CUDA (or CPU) server binary.
//
//   node scripts/bench-models.mjs [--runs 3] [--audio path.wav]
//
// Compares every ggml-*-en*.bin in whisper.cpp/models (for-tests-* skipped).
// Missing recommended models are listed with download URLs — fetch them with
// curl -L -o <dest> <url> and re-run.
import { spawn } from 'child_process'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { cpus } from 'os'

const ROOT = join(import.meta.dirname, '..', '..')
const WHISPER_DIR = join(ROOT, 'whisper.cpp')
const SERVER =
  process.env.WHISPER_SERVER_BINARY ||
  join(WHISPER_DIR, 'build-cuda', 'bin', 'Release', 'whisper-server.exe')
const AUDIO = process.argv.includes('--audio')
  ? process.argv[process.argv.indexOf('--audio') + 1]
  : join(WHISPER_DIR, 'samples', 'jfk.wav')
const PORT = 18081
const BASE = `http://127.0.0.1:${PORT}`

const args = process.argv.slice(2)
const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3

// Collect audios: comma lists and/or repeated --audio flags.
const audioArgs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--audio') {
    audioArgs.push(...(args[i + 1] || '').split(',').filter(Boolean))
    i++
  }
}
const AUDIOS = (audioArgs.length ? audioArgs : [AUDIO]).map((p) => ({
  path: p,
  label: p.split(/[\\/]/).pop().replace(/\.wav$/i, ''),
  buf: readFileSync(p)
}))

const RECOMMENDED = [
  ['ggml-tiny.en.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin'],
  ['ggml-base.en.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'],
  ['ggml-small.en.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin'],
  ['ggml-medium-en.bin', 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-en.bin']
]

function findModels() {
  const dir = join(WHISPER_DIR, 'models')
  const files = readdirSync(dir)
    .filter((f) => /^ggml-.*\.bin$/.test(f) && !f.startsWith('for-tests'))
    .map((f) => ({ name: f, path: join(dir, f), size: existsSync(join(dir, f)) ? 0 : -1 }))
  return files
}

async function waitForHealth(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function infer(wavBuf) {
  const t0 = performance.now()
  const form = new FormData()
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'chunk.wav')
  form.append('response_format', 'json')
  form.append('prompt', '') // deliberately neutral: measure models, not prompts
  const res = await fetch(`${BASE}/inference`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`inference ${res.status}`)
  const j = await res.json()
  return { ms: performance.now() - t0, text: (j.text || '').replace(/\s+/g, ' ').trim() }
}

const origWav = readFileSync(AUDIOS[0].path) // header probe only

const models = findModels()
if (models.length === 0) throw new Error('no ggml-*.bin models found in whisper.cpp/models')

console.log(`binary: ${SERVER}`)
AUDIOS.forEach((a, i) => console.log(`audio[${i}]: ${a.label} (${(a.buf.length / 32000).toFixed(1)}s)`))
console.log('')
console.log('models found:', models.map((m) => m.name).join(', '))

const missing = RECOMMENDED.filter(([name]) => !models.some((m) => m.name === name))
if (missing.length > 0) {
  console.log('\noptional downloads for wider comparison:')
  for (const [name, url] of missing) console.log(`  curl -L -o whisper.cpp/models/${name} ${url}`)
}
console.log()

for (const model of models) {
  process.stdout.write(`\n=== ${model.name} ===\n`)
  const server = spawn(SERVER, [
    '-m', model.path,
    '-t', String(Math.max(2, Math.floor(cpus().length / 2))),
    '-l', 'en',
    '--host', '127.0.0.1',
    '--port', String(PORT)
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  try {
    if (!(await waitForHealth())) throw new Error('server never became healthy')
    await infer(AUDIOS[0].buf) // warm-up

    for (const audio of AUDIOS) {
      await infer(audio.buf) // per-audio warm-up
      const times = []
      let text = ''
      for (let i = 0; i < runs; i++) {
        const r = await infer(audio.buf)
        times.push(r.ms)
        text = r.text
        process.stdout.write('.')
      }
      const sorted = [...times].sort((a, b) => a - b)
      const median = Math.round(sorted[Math.floor(sorted.length / 2)])
      console.log(` ${audio.label}: median=${median}ms  "${text}"`)
    }
  } catch (err) {
    console.log(` FAILED: ${err.message}`)
  } finally {
    server.kill()
    await new Promise((r) => setTimeout(r, 500)) // release port before next model
  }
}
