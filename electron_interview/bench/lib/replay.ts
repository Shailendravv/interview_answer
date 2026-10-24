// Feeds PCM into the app's AudioService exactly the way the renderer does:
// `audio:start`, then `audio:chunk` ArrayBuffers at real-time pace. A chunk is
// delivered when it is complete (as a ScriptProcessor callback would be), so
// the capture-buffering delay is modelled, not skipped.
import type { EventEmitter } from 'events'
import { SAMPLE_RATE } from './wav'

/** A 4096-sample ScriptProcessor at 48 kHz yields 1365 samples after resampling to 16 kHz. */
export const RENDERER_CHUNK_SAMPLES = 1365

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)))

export async function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 20): Promise<boolean> {
  const end = performance.now() + timeoutMs
  while (performance.now() < end) {
    if (cond()) return true
    await sleep(pollMs)
  }
  return cond()
}

export interface ReplayTiming {
  /** performance.now() corresponding to sample 0 of the clip ("real" audio time). */
  audioZero: number
  /** Converts a position in the clip (ms) to wall-clock performance.now(). */
  wallAt(clipMs: number): number
}

export async function replayRealtime(
  ipc: EventEmitter,
  pcm: Int16Array,
  chunkSamples = RENDERER_CHUNK_SAMPLES
): Promise<ReplayTiming> {
  const chunkMs = (chunkSamples / SAMPLE_RATE) * 1000
  const audioZero = performance.now()
  const chunks = Math.ceil(pcm.length / chunkSamples)
  for (let i = 0; i < chunks; i++) {
    // Chunk i holds audio [i, i+1) * chunkMs and becomes available at its end.
    await sleep(audioZero + (i + 1) * chunkMs - performance.now())
    const chunk = pcm.slice(i * chunkSamples, (i + 1) * chunkSamples)
    ipc.emit('audio:chunk', {}, chunk.buffer)
  }
  return { audioZero, wallAt: (clipMs) => audioZero + clipMs }
}

export function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE))
}

export function concat(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
