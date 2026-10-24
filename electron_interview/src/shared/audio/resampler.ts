/**
 * Streaming sample-rate converter for the capture path (typically 48 kHz
 * loopback -> 16 kHz for whisper).
 *
 * The renderer used to decimate by linear interpolation with no low-pass
 * filter, restarting at every ScriptProcessor block. Everything between 8 and
 * 24 kHz then folded back into the speech band: on a real recording that
 * content sat ~24 dB below the speech (fricatives: "Node.js", "Gen AI"), and
 * the live transcripts degraded ("What is more, yes?", "Chennai AI").
 *
 * This is a Kaiser-windowed sinc interpolator (~80 dB stopband) evaluated at
 * each output instant, with its input history carried across calls, so the
 * output does not depend on how the input was chunked.
 */

const STOPBAND_DB = 80
// Fractions of the lower of the two rates: -6 dB point at 0.47 (7.5 kHz for a
// 16 kHz output), transition band 0.1 wide (6.7-8.3 kHz). Aliases of the
// 8-8.3 kHz remainder fold into 7.7-8 kHz only, where they are attenuated.
const CUTOFF = 0.47
const TRANSITION = 0.1
/** Kernel table points per input sample; linear interpolation between them. */
const TABLE_OVERSAMPLE = 128

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

export class StreamingResampler {
  /** Input samples per output sample. */
  private readonly step: number
  /** Kernel half-width in input samples. */
  private readonly half: number
  private readonly table: Float32Array
  /** Pending input; buf[0] is absolute input sample `bufStart`. */
  private buf: Float32Array
  private bufStart: number
  /** Output samples emitted so far; output n sits at input time n * step. */
  private produced = 0

  constructor(
    readonly inRate: number,
    readonly outRate: number
  ) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error(`invalid rates ${inRate} -> ${outRate}`)
    this.step = inRate / outRate
    const base = Math.min(inRate, outRate)
    const fc = (CUTOFF * base) / inRate // cycles per input sample
    const dw = (2 * Math.PI * TRANSITION * base) / inRate // rad per input sample
    const beta = 0.1102 * (STOPBAND_DB - 8.7)
    const taps = Math.ceil((STOPBAND_DB - 7.95) / (2.285 * dw)) + 1
    this.half = Math.max(2, Math.ceil(taps / 2))

    const n = this.half * TABLE_OVERSAMPLE + 2
    this.table = new Float32Array(n)
    const i0beta = besselI0(beta)
    for (let j = 0; j < n; j++) {
      const x = j / TABLE_OVERSAMPLE
      const r = x / this.half
      if (r >= 1) continue
      const arg = 2 * fc * x
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)
      this.table[j] = 2 * fc * sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0beta)
    }

    // Zero history before the first sample.
    this.buf = new Float32Array(this.half)
    this.bufStart = -this.half
  }

  /** Delay the filter adds, in ms (output lags input by half the kernel). */
  get latencyMs(): number {
    return (this.half / this.inRate) * 1000
  }

  private kernel(tau: number): number {
    const pos = Math.abs(tau) * TABLE_OVERSAMPLE
    const i = Math.floor(pos)
    if (i >= this.table.length - 1) return 0
    const frac = pos - i
    return this.table[i] * (1 - frac) + this.table[i + 1] * frac
  }

  process(input: Float32Array): Float32Array {
    const merged = new Float32Array(this.buf.length + input.length)
    merged.set(this.buf, 0)
    merged.set(input, this.buf.length)
    const end = this.bufStart + merged.length // exclusive absolute index

    const out: number[] = []
    for (;;) {
      const t = this.produced * this.step
      const centre = Math.floor(t)
      if (centre + this.half >= end) break
      let acc = 0
      for (let k = centre - this.half + 1; k <= centre + this.half; k++) {
        acc += merged[k - this.bufStart] * this.kernel(t - k)
      }
      out.push(acc)
      this.produced++
    }

    // Keep only the history the next output still needs.
    const keepFrom = Math.max(0, Math.floor(this.produced * this.step) - this.half + 1 - this.bufStart)
    this.buf = merged.slice(keepFrom)
    this.bufStart += keepFrom
    return Float32Array.from(out)
  }
}
