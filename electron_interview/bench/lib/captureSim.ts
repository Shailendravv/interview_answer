// Simulates the renderer's capture path (48 kHz Web Audio blocks -> 16 kHz
// PCM16) so the bench can measure what whisper hears live. Without this the
// bench fed ffmpeg-converted 16 kHz audio straight to the main process and
// never saw the renderer's resampler.
//
// EVAL_CAPTURE=legacy  the original linear decimator (per-block, no filter)
// EVAL_CAPTURE=sinc    src/shared/audio/resampler.ts (the current renderer)
import { spawnSync } from 'child_process'
import { StreamingResampler } from '../../src/shared/audio/resampler'

export type CaptureMode = 'legacy' | 'sinc'
export const CAPTURE_RATE = 48000
const BLOCK = 4096 // ScriptProcessor buffer size in audioCapture.ts

export function captureMode(): CaptureMode | null {
  const m = process.env.EVAL_CAPTURE
  return m === 'legacy' || m === 'sinc' ? m : null
}

/** The decimator audioCapture.ts used before the resampler (verbatim logic). */
function legacyBlock(input: Float32Array, captureRate: number, targetRate: number): Float32Array {
  const ratio = captureRate / targetRate
  const outputLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outputLen)
  for (let i = 0; i < outputLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    out[i] = idx + 1 < input.length ? input[idx] * (1 - frac) + input[idx + 1] * frac : input[idx]
  }
  return out
}

/** Same clipping/scaling as encodePcm16 in audioCapture.ts. */
function encodePcm16(x: Float32Array): Int16Array {
  const pcm = new Int16Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm
}

/** Loads `path` as 48 kHz mono float (ffmpeg downmix = Web Audio's 0.5·(L+R)). */
function load48kFloat(path: string): Float32Array {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(CAPTURE_RATE), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30
  })
  if (res.error || res.status !== 0) {
    throw new Error(`ffmpeg could not decode "${path}": ${res.error?.message ?? res.stderr?.toString().trim()}`)
  }
  const buf = res.stdout as Buffer
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** 16 kHz PCM16 as the renderer would deliver it for this clip. */
export function simulateCapture(path: string, mode: CaptureMode, targetRate = 16000): Int16Array {
  const input = load48kFloat(path)
  const resampler = mode === 'sinc' ? new StreamingResampler(CAPTURE_RATE, targetRate) : null
  const parts: Int16Array[] = []
  for (let i = 0; i < input.length; i += BLOCK) {
    const block = input.subarray(i, i + BLOCK)
    parts.push(encodePcm16(resampler ? resampler.process(block) : legacyBlock(block, CAPTURE_RATE, targetRate)))
  }
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
