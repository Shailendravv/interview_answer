import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { VADProcessor, DEFAULT_VAD_CONFIG, VADSegment } from '../src/audio/vad'

const RATE = 16000
const FRAME_MS = (DEFAULT_VAD_CONFIG.analysisFrameSamples / RATE) * 1000 // 32ms

// Chunk sizes the main process actually receives. audioCapture.ts uses a
// 4096-sample ScriptProcessor and resamples to 16kHz only when the device rate
// differs, so the chunk length depends on the sound card:
//   48000Hz -> 4096/3      = 1365 samples (85.3ms)
//   44100Hz -> 4096/2.756  = 1486 samples (92.9ms)
//   16000Hz -> no resample = 4096 samples (256ms)
// 512 is included as a small-buffer control. Every timing assertion must hold
// for all of them: the original bug was that the test fed 512 and so shared the
// implementation's wrong assumption about frame size.
const CHUNK_SIZES = [1365, 1486, 4096, 512]

const SPEECH_AMP = 0x7000 // rms ~0.875, well above speechThreshold 0.02
const QUIET_AMP = 500 // rms ~0.0153: above silenceThreshold, below speechThreshold
const SILENT_AMP = 0

function samplesFor(ms: number): number {
  return Math.round((ms / 1000) * RATE)
}

function durMs(seg: VADSegment): number {
  return (seg.data.length / RATE) * 1000
}

function newCarry(): { buf: number[] } {
  return { buf: [] }
}

/** Feeds `ms` of constant-amplitude audio as chunks of exactly `chunkSamples`. */
function feed(
  vad: VADProcessor,
  ms: number,
  amp: number,
  chunkSamples: number,
  carry: { buf: number[] }
): VADSegment[] {
  const out: VADSegment[] = []
  for (let i = 0; i < samplesFor(ms); i++) carry.buf.push(amp)
  while (carry.buf.length >= chunkSamples) {
    const chunk = Int16Array.from(carry.buf.splice(0, chunkSamples))
    out.push(...vad.processChunk(chunk))
  }
  return out
}

describe.each(CHUNK_SIZES)('VADProcessor @ %i-sample chunks', (chunkSamples) => {
  const chunkMs = (chunkSamples / RATE) * 1000
  // A segment can only be emitted on a chunk boundary, and decisions land on
  // 32ms analysis frames, so every duration carries this much slack.
  const slack = chunkMs + FRAME_MS

  it('closes a segment after hangoverMs of silence, not after N chunks', () => {
    const vad = new VADProcessor()
    const carry = newCarry()

    expect(feed(vad, 1000, SPEECH_AMP, chunkSamples, carry)).toHaveLength(0)

    // Well short of the hangover: nothing may close yet.
    expect(feed(vad, 250, SILENT_AMP, chunkSamples, carry)).toHaveLength(0)

    // Past the hangover (plus granularity slack): exactly one segment.
    const closed = feed(vad, DEFAULT_VAD_CONFIG.hangoverMs + slack, SILENT_AMP, chunkSamples, carry)
    expect(closed).toHaveLength(1)
    expect(closed[0].reason).toBe('silence')
    expect(closed[0].trailingSilenceMs).toBe(DEFAULT_VAD_CONFIG.hangoverMs)
  })

  it('emits a segment covering pre-roll + speech + hangover', () => {
    const vad = new VADProcessor()
    const carry = newCarry()

    feed(vad, 1000, SPEECH_AMP, chunkSamples, carry)
    const closed = feed(vad, DEFAULT_VAD_CONFIG.hangoverMs + slack, SILENT_AMP, chunkSamples, carry)

    expect(closed).toHaveLength(1)
    const expected = 1000 + DEFAULT_VAD_CONFIG.hangoverMs
    expect(durMs(closed[0])).toBeGreaterThanOrEqual(expected - slack)
    // Pre-roll adds up to preRollMs of leading audio on top.
    expect(durMs(closed[0])).toBeLessThanOrEqual(
      expected + DEFAULT_VAD_CONFIG.preRollMs + 2 * slack
    )
  })

  it('retains the speech onset instead of discarding it', () => {
    // The old implementation cleared its buffer on the Silence->Speech
    // transition, so the frames that proved it was speech were thrown away and
    // whisper never saw the start of the word.
    const vad = new VADProcessor()
    const carry = newCarry()
    const SENTINEL = 0x7001

    feed(vad, 96, SENTINEL, chunkSamples, carry)
    feed(vad, 900, SPEECH_AMP, chunkSamples, carry)
    const closed = feed(vad, DEFAULT_VAD_CONFIG.hangoverMs + slack, SILENT_AMP, chunkSamples, carry)

    expect(closed).toHaveLength(1)
    expect(closed[0].data).toContain(SENTINEL)
  })

  it('retains sub-threshold pre-roll audio before the onset', () => {
    // Soft lead-ins ("What is...") start below speechThreshold. Without a
    // pre-roll buffer that audio is gone before the VAD decides it is speech.
    const vad = new VADProcessor()
    const carry = newCarry()

    feed(vad, 200, QUIET_AMP, chunkSamples, carry)
    feed(vad, 800, SPEECH_AMP, chunkSamples, carry)
    const closed = feed(vad, DEFAULT_VAD_CONFIG.hangoverMs + slack, SILENT_AMP, chunkSamples, carry)

    expect(closed).toHaveLength(1)
    expect(closed[0].data).toContain(QUIET_AMP)
  })

  it('caps long speech at maxSegmentMs and stays in Speech across the split', () => {
    const vad = new VADProcessor()
    const carry = newCarry()

    const segments = feed(vad, 20000, SPEECH_AMP, chunkSamples, carry)

    expect(segments.length).toBeGreaterThanOrEqual(2)
    for (const seg of segments) {
      expect(seg.reason).toBe('cap')
      expect(seg.trailingSilenceMs).toBe(0)
      expect(durMs(seg)).toBeLessThanOrEqual(DEFAULT_VAD_CONFIG.maxSegmentMs + slack)
    }

    // Silence after a split still closes the remainder.
    const tail = feed(vad, DEFAULT_VAD_CONFIG.hangoverMs + slack, SILENT_AMP, chunkSamples, carry)
    expect(tail).toHaveLength(1)
    expect(tail[0].reason).toBe('silence')
  })

  it('never emits a segment large enough to be split by whisper', () => {
    // WhisperServerProvider splits anything over MAX_CHUNK_BYTES (256KB =
    // 131072 samples = 8.192s) into serialized head/tail round-trips. Two
    // constants in two files have to agree; this asserts they do.
    const MAX_CHUNK_SAMPLES = (256 * 1024) / 2
    const vad = new VADProcessor()
    const carry = newCarry()

    const segments = feed(vad, 30000, SPEECH_AMP, chunkSamples, carry)
    expect(segments.length).toBeGreaterThan(0)
    for (const seg of segments) {
      expect(seg.data.length).toBeLessThanOrEqual(MAX_CHUNK_SAMPLES)
    }
  })

  it('does not split when maxSegmentMs is zero', () => {
    const vad = new VADProcessor({ maxSegmentMs: 0 })
    const carry = newCarry()

    expect(feed(vad, 20000, SPEECH_AMP, chunkSamples, carry)).toHaveLength(0)

    const tail = vad.flush()
    expect(tail).toHaveLength(1)
    expect(tail[0].reason).toBe('flush')
    expect(tail[0].trailingSilenceMs).toBe(0)
  })

  it('conserves samples across re-framing', () => {
    // Chunk sizes are not multiples of the 512-sample analysis frame, so the
    // re-blocking carry is where samples would silently go missing. A carry bug
    // loses audio in proportion to the number of chunks, so the gap here must
    // stay bounded by a single incomplete frame no matter how much is fed.
    const vad = new VADProcessor({ maxSegmentMs: 0 })
    const carry = newCarry()

    const speechMs = 2000
    const segments = feed(vad, speechMs, SPEECH_AMP, chunkSamples, carry)
    const tail = vad.flush()

    const emitted = [...segments, ...tail].reduce((n, s) => n + s.data.length, 0)
    const fed = samplesFor(speechMs) - carry.buf.length

    // Pre-roll retains the onset, so everything fed is either emitted or still
    // sitting in an incomplete analysis frame. Nothing is invented either.
    expect(emitted).toBeGreaterThan(0)
    expect(emitted).toBeLessThanOrEqual(fed)
    expect(fed - emitted).toBeLessThan(DEFAULT_VAD_CONFIG.analysisFrameSamples)
  })
})

describe('VADProcessor configuration', () => {
  it('produces chunk-size-invariant segmentation', () => {
    // The regression test for the whole bug class: identical audio must
    // segment identically no matter how the capture layer chops it up.
    const results = CHUNK_SIZES.map((chunkSamples) => {
      const vad = new VADProcessor()
      const carry = newCarry()
      feed(vad, 1200, SPEECH_AMP, chunkSamples, carry)
      const closed = feed(vad, 800, SILENT_AMP, chunkSamples, carry)
      return { chunkSamples, count: closed.length, ms: closed.map(durMs) }
    })

    const baseline = results[0]
    for (const r of results) {
      expect(r.count).toBe(baseline.count)
      const chunkMs = (r.chunkSamples / RATE) * 1000
      const baseMs = (baseline.chunkSamples / RATE) * 1000
      expect(Math.abs(r.ms[0] - baseline.ms[0])).toBeLessThanOrEqual(
        chunkMs + baseMs + 2 * FRAME_MS
      )
    }
  })

  it('clamps maxSegmentMs so a segment can never exceed whisper MAX_CHUNK_BYTES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const vad = new VADProcessor({ maxSegmentMs: 12000 })
    expect(vad.getConfig().maxSegmentMs).toBeLessThanOrEqual(8100)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('signals speech onset once per utterance, before the transcript exists', () => {
    // Drives the cloud-provider preconnect: the socket is warmed while the
    // speaker is still talking rather than on the critical path.
    const vad = new VADProcessor()
    const onSpeechStart = vi.fn()
    vad.setOnSpeechStart(onSpeechStart)
    const carry = newCarry()

    feed(vad, 800, SPEECH_AMP, 1365, carry)
    expect(onSpeechStart).toHaveBeenCalledTimes(1)

    // Still the same utterance: no second signal.
    feed(vad, 800, SPEECH_AMP, 1365, carry)
    expect(onSpeechStart).toHaveBeenCalledTimes(1)

    // Close it, then speak again: a new utterance signals again.
    feed(vad, 800, SILENT_AMP, 1365, carry)
    feed(vad, 800, SPEECH_AMP, 1365, carry)
    expect(onSpeechStart).toHaveBeenCalledTimes(2)
  })

  it('reset clears pending audio, counters and pre-roll', () => {
    const vad = new VADProcessor()
    const carry = newCarry()

    feed(vad, 1000, SPEECH_AMP, 1365, carry)
    vad.reset()

    expect(vad.flush()).toHaveLength(0)
    // A fresh utterance must not inherit the previous one's audio.
    const c2 = newCarry()
    feed(vad, 500, SPEECH_AMP, 1365, c2)
    const closed = feed(vad, 800, SILENT_AMP, 1365, c2)
    expect(closed).toHaveLength(1)
    expect(durMs(closed[0])).toBeLessThan(1200)
  })
})

describe('VADProcessor on real interview audio', () => {
  // Envelope extracted from a real 15.84s recording of three spoken questions:
  // "What is Node JS? / What is AI agent? / What do you understand with Gen AI?"
  // The VAD is purely energy-based, so replaying the RMS envelope reproduces
  // its real segmentation decisions exactly.
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/real-speech-envelope.json', import.meta.url), 'utf-8')
  ) as { frameSamples: number; rms: number[] }

  /** Rebuilds a PCM stream whose per-frame RMS matches the recording. */
  function realAudio(): Int16Array {
    const pcm = new Int16Array(fixture.rms.length * fixture.frameSamples)
    fixture.rms.forEach((amp, f) => {
      pcm.fill(amp, f * fixture.frameSamples, (f + 1) * fixture.frameSamples)
    })
    return pcm
  }

  function segment(chunkSamples: number, cfg = {}): VADSegment[] {
    const vad = new VADProcessor(cfg)
    const pcm = realAudio()
    const out: VADSegment[] = []
    for (let i = 0; i < pcm.length; i += chunkSamples) {
      out.push(...vad.processChunk(pcm.subarray(i, Math.min(i + chunkSamples, pcm.length))))
    }
    out.push(...vad.flush())
    return out
  }

  it('segments real speech identically at every capture chunk size', () => {
    // The bug this whole change fixes: at 48kHz the capture layer sends 1365
    // samples per chunk, at 16kHz-native it sends 4096. Those must not produce
    // different segmentation.
    const at48k = segment(1365).map((s) => s.data.length)
    const at44k = segment(1486).map((s) => s.data.length)
    const at16k = segment(4096).map((s) => s.data.length)

    expect(at48k).toEqual(at16k)
    expect(at44k).toEqual(at16k)
    expect(at48k.length).toBeGreaterThan(0)
  })

  it('keeps a 736ms mid-question pause from being a false end-of-speech only above ~800ms', () => {
    // Measured on this recording: pauses WITHIN a question reach 736ms, while
    // gaps BETWEEN questions never fall below 1792ms. So the VAD alone cannot
    // separate them at a low hangover -- which is why AudioService adds a
    // continuation grace window on top rather than just raising hangoverMs.
    const aggressive = segment(1365, { hangoverMs: 350 })
    const conservative = segment(1365, { hangoverMs: 900 })

    expect(aggressive.length).toBe(4) // splits the third question in two
    expect(conservative.length).toBe(3) // one segment per spoken question
  })

  it('retains the leading audio a soft question onset starts with', () => {
    // Without pre-roll the recording transcribes as "What is mode JS?"; with it
    // whisper resolves "What is Node.js?".
    const withPreRoll = segment(1365)[0]
    const withoutPreRoll = segment(1365, { preRollMs: 0 })[0]

    expect(withPreRoll.data.length).toBeGreaterThan(withoutPreRoll.data.length)
  })
})
