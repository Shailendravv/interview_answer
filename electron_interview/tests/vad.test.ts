import { describe, it, expect } from 'vitest'
import { VADProcessor, DEFAULT_VAD_CONFIG } from '../src/audio/vad'

const FRAME_SIZE = 512

function speechFrame(): Int16Array {
  return new Int16Array(FRAME_SIZE).fill(0x7000)
}

function silenceFrame(): Int16Array {
  return new Int16Array(FRAME_SIZE).fill(0)
}

describe('VADProcessor maxSegmentFrames', () => {
  it('splits continuous speech into bounded segments', () => {
    const vad = new VADProcessor({
      ...DEFAULT_VAD_CONFIG,
      minSpeechFrames: 1,
      maxSegmentFrames: 250
    })

    let completed: Int16Array[] = []
    for (let i = 0; i < 600; i++) {
      completed.push(...vad.processFrame(speechFrame()))
    }

    expect(completed.length).toBe(2)
    expect(completed[0].length).toBe(250 * FRAME_SIZE)
    expect(completed[1].length).toBe(250 * FRAME_SIZE)

    // The 99 remaining frames stay buffered until flushed.
    const tail = vad.flush()
    expect(tail).toHaveLength(1)
    expect(tail[0].length).toBe(99 * FRAME_SIZE)
  })

  it('stays in Speech after a cap split and closes via silence', () => {
    const vad = new VADProcessor({
      ...DEFAULT_VAD_CONFIG,
      minSpeechFrames: 1,
      maxSegmentFrames: 250
    })

    let completed: Int16Array[] = []
    for (let i = 0; i < 300; i++) {
      completed.push(...vad.processFrame(speechFrame()))
    }
    expect(completed).toHaveLength(1)
    expect(completed[0].length).toBe(250 * FRAME_SIZE)

    // Silence after the split must still pad and close the new segment.
    for (let i = 0; i < 20; i++) {
      completed.push(...vad.processFrame(silenceFrame()))
    }
    expect(completed).toHaveLength(2)
    expect(completed[1].length).toBe(59 * FRAME_SIZE)
  })

  it('does not split when maxSegmentFrames is zero', () => {
    const vad = new VADProcessor({
      ...DEFAULT_VAD_CONFIG,
      minSpeechFrames: 1,
      maxSegmentFrames: 0
    })

    let completed: Int16Array[] = []
    for (let i = 0; i < 600; i++) {
      completed.push(...vad.processFrame(speechFrame()))
    }
    expect(completed).toHaveLength(0)

    const tail = vad.flush()
    expect(tail).toHaveLength(1)
    expect(tail[0].length).toBe(599 * FRAME_SIZE)
  })
})
