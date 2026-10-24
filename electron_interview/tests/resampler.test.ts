import { describe, it, expect } from 'vitest'
import { StreamingResampler } from '../src/shared/audio/resampler'

const tone = (hz: number, rate: number, seconds: number, amp = 0.5): Float32Array => {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)

/** Feeds `input` in ScriptProcessor-sized blocks, as the renderer does. */
function runChunked(r: StreamingResampler, input: Float32Array, block = 4096): Float32Array {
  const parts: Float32Array[] = []
  for (let i = 0; i < input.length; i += block) parts.push(r.process(input.subarray(i, i + block)))
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** The renderer's previous decimator, kept here to show what it let through. */
function legacyLinear(input: Float32Array, inRate: number, outRate: number, block = 4096): Float32Array {
  const parts: number[] = []
  for (let b = 0; b < input.length; b += block) {
    const chunk = input.subarray(b, b + block)
    const ratio = inRate / outRate
    const len = Math.floor(chunk.length / ratio)
    for (let i = 0; i < len; i++) {
      const pos = i * ratio
      const idx = Math.floor(pos)
      const frac = pos - idx
      parts.push(idx + 1 < chunk.length ? chunk[idx] * (1 - frac) + chunk[idx + 1] * frac : chunk[idx])
    }
  }
  return Float32Array.from(parts)
}

// Skip the filter's start-up transient.
const steady = (x: Float32Array): Float32Array => x.subarray(400, x.length - 400)

describe('StreamingResampler 48 kHz -> 16 kHz', () => {
  it('passes speech-band tones at unity gain', () => {
    for (const hz of [200, 1000, 3000, 6000]) {
      const out = runChunked(new StreamingResampler(48000, 16000), tone(hz, 48000, 1))
      expect(rms(steady(out)) / (0.5 / Math.SQRT2), `${hz} Hz`).toBeGreaterThan(0.98)
      expect(rms(steady(out)) / (0.5 / Math.SQRT2), `${hz} Hz`).toBeLessThan(1.02)
    }
  })

  it('rejects content above 8 kHz instead of folding it into the speech band', () => {
    // 12 kHz folds to 4 kHz and 10 kHz to 6 kHz when decimated without a filter.
    for (const hz of [10000, 12000, 14000]) {
      const input = tone(hz, 48000, 1)
      const fixed = rms(steady(runChunked(new StreamingResampler(48000, 16000), input)))
      const legacy = rms(steady(legacyLinear(input, 48000, 16000)))
      const db = (v: number): number => 20 * Math.log10(v / (0.5 / Math.SQRT2))
      expect(db(fixed), `${hz} Hz`).toBeLessThan(-60)
      expect(db(legacy), `${hz} Hz legacy`).toBeGreaterThan(-12)
    }
  })

  it('keeps DC level', () => {
    const out = runChunked(new StreamingResampler(48000, 16000), new Float32Array(48000).fill(0.25))
    for (const v of steady(out)) expect(v).toBeCloseTo(0.25, 3)
  })

  it('gives the same output however the input is chunked', () => {
    const input = tone(1234, 48000, 0.5)
    const whole = new StreamingResampler(48000, 16000).process(input)
    const chunked = runChunked(new StreamingResampler(48000, 16000), input, 4096)
    const odd = runChunked(new StreamingResampler(48000, 16000), input, 777)
    expect(chunked.length).toBe(whole.length)
    expect(odd.length).toBe(whole.length)
    for (let i = 0; i < whole.length; i++) {
      expect(chunked[i]).toBeCloseTo(whole[i], 6)
      expect(odd[i]).toBeCloseTo(whole[i], 6)
    }
  })

  it('produces one output per three inputs, minus only the filter delay', () => {
    const r = new StreamingResampler(48000, 16000)
    const out = runChunked(r, new Float32Array(48000))
    expect(r.latencyMs).toBeLessThan(2)
    expect(out.length).toBeGreaterThan(16000 - 30)
    expect(out.length).toBeLessThanOrEqual(16000)
  })
})

describe('StreamingResampler other rates', () => {
  it('converts 44.1 kHz with the right pitch and level', () => {
    const out = steady(runChunked(new StreamingResampler(44100, 16000), tone(1000, 44100, 1)))
    expect(rms(out) / (0.5 / Math.SQRT2)).toBeGreaterThan(0.98)
    // Zero crossings: 1 kHz -> ~2000 per second of output.
    let crossings = 0
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++
    expect(crossings / (out.length / 16000)).toBeGreaterThan(1990)
    expect(crossings / (out.length / 16000)).toBeLessThan(2010)
  })
})
