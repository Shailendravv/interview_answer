// Builds bench/audio/synthetic/: TTS utterances (Windows OneCore voices via
// tts.ps1, converted to 16 kHz mono PCM16 with ffmpeg) composed into clips
// whose speech boundaries are known exactly, plus manifest.json.
//
//   node bench/scripts/make-synthetic-audio.mjs
//
// Requires Windows (OneCore voices) and ffmpeg on PATH.
import { spawnSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const benchDir = join(here, '..')
const outDir = join(benchDir, 'audio', 'synthetic')
const uttDir = join(outDir, 'utterances')
const spec = JSON.parse(readFileSync(join(benchDir, 'fixtures', 'synthetic-utterances.json'), 'utf8'))
const RATE = 16000
const LEAD_MS = 1000
const TAIL_MS = 6000
const MARGIN_MS = 30

mkdirSync(uttDir, { recursive: true })

// ---- 1. render utterances -------------------------------------------------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const jobs = new Map()
function need(text, voice) {
  const key = `${slug(voice)}__${slug(text).slice(0, 60)}`
  if (!jobs.has(key)) jobs.set(key, { text, voice, raw: join(uttDir, `${key}.raw.wav`), wav: join(uttDir, `${key}.wav`) })
  return jobs.get(key)
}
for (const v of spec.voices) for (const q of spec.questions) need(q.text, v.name)
for (const p of spec.paused) for (const part of p.parts) need(part, spec.pausedVoice)

const todo = [...jobs.values()].filter((j) => !existsSync(j.wav))
if (todo.length) {
  const jobFile = join(uttDir, 'jobs.json')
  writeFileSync(jobFile, JSON.stringify(todo.map((j) => ({ text: j.text, voice: j.voice, out: j.raw }))))
  const ps = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'tts.ps1'), '-JobFile', jobFile], { encoding: 'utf8' })
  if (ps.status !== 0) {
    console.error(ps.stdout, ps.stderr)
    process.exit(1)
  }
  for (const j of todo) {
    const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', j.raw, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', j.wav])
    if (ff.error || ff.status !== 0) {
      console.error(`ffmpeg failed for ${j.raw}: ${ff.error?.message ?? ff.stderr}`)
      process.exit(1)
    }
  }
}

// ---- 2. PCM helpers -------------------------------------------------------
function readPcm(path) {
  const buf = readFileSync(path)
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'data') {
      const data = buf.subarray(pos + 8, pos + 8 + size)
      const out = new Int16Array(data.length / 2)
      for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2)
      return out
    }
    pos += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}

function writePcm(path, s) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + s.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(s.length * 2, 40)
  const b = Buffer.alloc(s.length * 2)
  for (let i = 0; i < s.length; i++) b.writeInt16LE(s[i], i * 2)
  writeFileSync(path, Buffer.concat([h, b]))
}

const ms = (n) => Math.round((n / 1000) * RATE)
const silence = (n) => new Int16Array(ms(n))

/** Trims TTS lead/trail silence to the energetic region (+ a small margin). */
function trimmed(job) {
  const pcm = readPcm(job.wav)
  const win = ms(10)
  const loud = (i) => {
    let sum = 0
    for (let k = i; k < Math.min(pcm.length, i + win); k++) sum += pcm[k] * pcm[k]
    return Math.sqrt(sum / win) / 32768 > 0.005
  }
  let start = 0
  while (start < pcm.length && !loud(start)) start += win
  let end = pcm.length - win
  while (end > start && !loud(end)) end -= win
  end += win
  return pcm.slice(Math.max(0, start - ms(MARGIN_MS)), Math.min(pcm.length, end + ms(MARGIN_MS)))
}

function noise(dbfs, n) {
  const amp = Math.pow(10, dbfs / 20) * Math.sqrt(3) * 32767
  const out = new Int16Array(ms(n))
  let x = 0x9e3779b9
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    out[i] = Math.round(((x >>> 0) / 0xffffffff * 2 - 1) * amp)
  }
  return out
}

/** Concatenates parts, returning the clip and each speech part's [startMs, endMs]. */
function compose(parts) {
  const total = parts.reduce((s, p) => s + p.pcm.length, 0)
  const out = new Int16Array(total)
  const spans = []
  let off = 0
  for (const p of parts) {
    out.set(p.pcm, off)
    if (p.speech) spans.push([Math.round((off / RATE) * 1000), Math.round(((off + p.pcm.length) / RATE) * 1000)])
    off += p.pcm.length
  }
  return { pcm: out, spans }
}

// ---- 3. compose clips + manifest ------------------------------------------
const items = []
const base = { language: 'en', referenceScript: 'latin', condition: 'clean-tts', verified: true }

for (const v of spec.voices) {
  for (const q of spec.questions) {
    const { pcm, spans } = compose([
      { pcm: silence(LEAD_MS) },
      { pcm: trimmed(need(q.text, v.name)), speech: true },
      { pcm: silence(TAIL_MS) }
    ])
    const file = `single-${q.id}-${v.speaker}.wav`
    writePcm(join(outDir, file), pcm)
    items.push({ ...base, id: `single-${q.id}-${v.speaker}`, file, scenario: 'single', speaker: v.speaker, accent: v.accent,
      questions: [{ reference: q.text, startMs: spans[0][0], endMs: spans[0][1], terms: q.terms }] })
  }
}

const pausedVoice = spec.voices.find((v) => v.name === spec.pausedVoice)
for (const p of spec.paused) {
  for (const pause of spec.pausesMs) {
    const { pcm, spans } = compose([
      { pcm: silence(LEAD_MS) },
      { pcm: trimmed(need(p.parts[0], spec.pausedVoice)), speech: true },
      { pcm: silence(pause) },
      { pcm: trimmed(need(p.parts[1], spec.pausedVoice)), speech: true },
      { pcm: silence(TAIL_MS) }
    ])
    const file = `paused-${p.id}-${pause}ms.wav`
    writePcm(join(outDir, file), pcm)
    items.push({ ...base, id: `paused-${p.id}-${pause}ms`, file, scenario: 'paused', pauseMs: pause, speaker: pausedVoice.speaker,
      accent: pausedVoice.accent, questions: [{ reference: p.parts.join(' '), startMs: spans[0][0], endMs: spans[1][1], terms: p.terms }] })
  }
}

for (const s of spec.sequences) {
  const voice = spec.voices.find((v) => v.name === s.voice)
  const parts = [{ pcm: silence(LEAD_MS) }]
  const qs = s.questionIds.map((id) => spec.questions.find((q) => q.id === id))
  qs.forEach((q, i) => {
    if (i > 0) parts.push({ pcm: silence(s.gapMs) })
    parts.push({ pcm: trimmed(need(q.text, s.voice)), speech: true })
  })
  parts.push({ pcm: silence(TAIL_MS) })
  const { pcm, spans } = compose(parts)
  const file = `sequence-${s.id}.wav`
  writePcm(join(outDir, file), pcm)
  items.push({ ...base, id: `sequence-${s.id}`, file, scenario: 'sequence', gapMs: s.gapMs, speaker: voice.speaker, accent: voice.accent,
    questions: qs.map((q, i) => ({ reference: q.text, startMs: spans[i][0], endMs: spans[i][1], terms: q.terms })) })
}

for (const n of spec.nonSpeech) {
  const pcm = n.kind === 'white-noise' ? noise(n.dbfs, n.ms) : silence(n.ms)
  const file = `nonspeech-${n.id}.wav`
  writePcm(join(outDir, file), pcm)
  items.push({ ...base, id: `nonspeech-${n.id}`, file, scenario: 'non-speech', speaker: 'none', accent: 'none',
    condition: n.kind === 'white-noise' ? `white-noise ${n.dbfs} dBFS` : 'digital silence', questions: [] })
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
  version: 1,
  source: 'synthetic-tts',
  representative: false,
  notes: spec.notes,
  items
}, null, 2))
console.log(`wrote ${items.length} clips + manifest to ${outDir}`)
