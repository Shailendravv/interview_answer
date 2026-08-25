// Whisper-server inference latency benchmark.
// Spawns whisper-server.exe (same binary/model the app uses), waits for
// health, then POSTs WAV slices (2s / 5s / full ~11s jfk.wav) N times each.
// Usage: node scripts/bench-whisper.mjs [--runs 5]
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(import.meta.dirname, '..', '..')
const SERVER = process.env.WHISPER_SERVER_BINARY || join(ROOT, 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-server.exe')
const MODEL = process.env.WHISPER_MODEL_PATH || join(ROOT, 'whisper.cpp', 'models', 'ggml-small.en.bin')
const WAV = join(ROOT, 'whisper.cpp', 'samples', 'jfk.wav')
const PORT = 18080
const BASE = `http://127.0.0.1:${PORT}`

const args = process.argv.slice(2)
const runsArg = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 5

// --- WAV slicing (16-bit PCM): extract data chunk, wrap in a canonical
// 44-byte header (the original may contain extra chunks before data) ---
function sliceWav(buf, seconds) {
  let pos = 12
  let dataOff = -1
  let dataSize = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'data') { dataOff = pos + 8; dataSize = size; break }
    pos += 8 + size + (size % 2)
  }
  if (dataOff < 0) throw new Error('no data chunk')
  const sampleRate = buf.readUInt32LE(24)
  const channels = buf.readUInt16LE(22)
  const bitsPerSample = buf.readUInt16LE(34)
  const byteRate = sampleRate * channels * bitsPerSample / 8
  const blockAlign = channels * bitsPerSample / 8
  const keepBytes = Math.min(dataSize - (dataSize % blockAlign || 1), Math.floor(byteRate * seconds))
  const out = Buffer.alloc(44 + keepBytes)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + keepBytes, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(byteRate, 28)
  out.writeUInt16LE(blockAlign, 32)
  out.writeUInt16LE(bitsPerSample, 34)
  out.write('data', 36)
  out.writeUInt32LE(keepBytes, 40)
  buf.copy(out, 44, dataOff, dataOff + keepBytes)
  return out
}

async function waitForHealth(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function infer(wavBuf) {
  const t0 = performance.now()
  const form = new FormData()
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'chunk.wav')
  form.append('response_format', 'json')
  const res = await fetch(`${BASE}/inference`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`inference ${res.status}: ${(await res.text()).slice(0, 300)}`)
  await res.json()
  return performance.now() - t0
}

// --- main ---
const orig = readFileSync(WAV)
const slices = {
  wav_2s: sliceWav(orig, 2),
  wav_5s: sliceWav(orig, 5),
  wav_full_11s: orig
}

console.log(`server: ${SERVER}\nmodel:  ${MODEL}`)
const server = spawn(SERVER, ['-m', MODEL, '-l', 'en', '--host', '127.0.0.1', '--port', String(PORT)], { stdio: ['ignore', 'ignore', 'ignore'] })

try {
  if (!(await waitForHealth())) throw new Error('whisper-server did not become healthy')
  console.log('server ready (model warm)\n')

  for (const [name, buf] of Object.entries(slices)) {
    await infer(buf) // warm-up (first request includes any lazy inits)
    const times = []
    for (let i = 0; i < runsArg; i++) {
      times.push(await infer(buf))
      process.stdout.write('.')
    }
    const sorted = [...times].sort((a, b) => a - b)
    const med = sorted[Math.floor(sorted.length / 2)]
    const min = Math.round(sorted[0])
    const max = Math.round(sorted[sorted.length - 1])
    console.log(` ${name}: median=${Math.round(med)}ms min=${min}ms max=${max}ms n=${times.length}`)
  }
} finally {
  server.kill()
}
