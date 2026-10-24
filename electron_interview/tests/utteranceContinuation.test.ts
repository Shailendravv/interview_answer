import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ipcHandlers = new Map<string, (...args: unknown[]) => void>()
const sent: { channel: string; payload: unknown }[] = []

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, cb: (...args: unknown[]) => void) => {
      ipcHandlers.set(channel, cb)
    }
  },
  BrowserWindow: class {}
}))

vi.mock('worker_threads', () => ({
  Worker: class {
    on(): void {}
    postMessage(): void {}
    terminate(): void {}
  }
}))

const sttEvents = new Map<string, (...args: unknown[]) => void>()

vi.mock('../src/main/stt/SttService', () => ({
  createSttService: () => ({
    name: 'test',
    on: (event: string, cb: (...args: unknown[]) => void) => {
      sttEvents.set(event, cb)
    },
    start: async () => {},
    stop: () => {},
    feedAudioChunk: () => {},
    finalize: () => {},
    cancel: () => {}
  })
}))

import { AudioService } from '../src/main/audio/AudioService'

function makeWindow(): never {
  return {
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }
  } as never
}

/** Drives the private VAD-worker message handler the way the worker would. */
function workerMessage(service: AudioService, msg: unknown): void {
  ;(service as unknown as { handleWorkerMessage: (m: unknown) => void }).handleWorkerMessage(msg)
}

describe('utterance continuation', () => {
  let service: AudioService
  let fired: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    sent.length = 0
    fired = []
    service = new AudioService({ mode: 'whisper' }, false)
    service.setWindow(makeWindow())
    service.setOnFinalTranscript((text) => fired.push(text))
  })

  afterEach(() => {
    vi.useRealTimers()
    service.destroy()
  })

  function emitTranscript(text: string): void {
    sttEvents.get('transcript')?.(text, true)
  }

  it('answers once the speaker has stopped and the grace window closes', () => {
    workerMessage(service, { type: 'speech-start' })
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 100, trailingSilenceMs: 350, reason: 'silence' }
    })

    emitTranscript('What is a closure?')
    vi.advanceTimersByTime(900)

    expect(fired).toEqual(['What is a closure?'])
  })

  it('holds a fragment and merges it when the speaker carries on', () => {
    // Segment 1 closes...
    workerMessage(service, { type: 'speech-start' })
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 100, trailingSilenceMs: 350, reason: 'silence' }
    })
    // ...but the speaker resumes before whisper returns.
    workerMessage(service, { type: 'speech-start' })

    emitTranscript("What's the difference between React and Vue")
    expect(fired).toEqual([]) // held, not answered as a fragment

    // Segment 2 closes. Because a fragment is held, the WHOLE utterance is
    // re-fed to whisper, so what comes back covers both segments and replaces
    // the held text rather than being appended to it.
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 100, trailingSilenceMs: 350, reason: 'silence' }
    })
    emitTranscript("What's the difference between React and Vue in terms of state management")
    vi.advanceTimersByTime(900)

    expect(fired).toEqual([
      "What's the difference between React and Vue in terms of state management"
    ])
  })

  it('releases a held fragment if no continuation transcript ever arrives', () => {
    workerMessage(service, { type: 'speech-start' })
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 100, trailingSilenceMs: 350, reason: 'silence' }
    })
    workerMessage(service, { type: 'speech-start' })

    emitTranscript('What is a closure')
    expect(fired).toEqual([])

    // The follow-on segment is filtered out as non-speech and never
    // transcribes; the question must not be stranded.
    vi.advanceTimersByTime(4001)
    expect(fired).toEqual(['What is a closure'])
    expect(fired).toHaveLength(1)
  })

  it('does not answer a fragment when the pause outlasts the VAD hangover', () => {
    // Replays the real failure from recording_1784429038281.mp3. The third
    // question "What do you understand with Gen AI?" contains a 736ms pause
    // right after its first word, so a 350ms hangover closes a segment there.
    // Whisper returns that fragment ("For what?") ~120ms later -- while the
    // speaker is still silent -- so checking "is speech happening now" is not
    // enough. The grace window is anchored to end-of-speech instead.
    workerMessage(service, { type: 'speech-start' })
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 900, trailingSilenceMs: 350, reason: 'silence' }
    })

    // Whisper decoding that 320ms fragment alone returns "For what?" -- a
    // mis-decode of the single word "What". Answering it would be nonsense.
    vi.advanceTimersByTime(120) // whisper round-trip
    emitTranscript('For what?')
    expect(fired).toEqual([])

    // The speaker resumes 482ms after the segment closed, still inside grace.
    vi.advanceTimersByTime(362)
    workerMessage(service, { type: 'speech-start' })

    // Well past the original grace deadline: still held, because speech resumed.
    vi.advanceTimersByTime(1000)
    expect(fired).toEqual([])

    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 3170, trailingSilenceMs: 350, reason: 'silence' }
    })
    // The joined audio decodes correctly, unlike either fragment alone.
    vi.advanceTimersByTime(200)
    emitTranscript('what do you understand with Gen AI?')
    vi.advanceTimersByTime(1000)

    expect(fired).toEqual(['what do you understand with Gen AI?'])
  })

  it('commits once the grace window closes with no continuation', () => {
    workerMessage(service, { type: 'speech-start' })
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 2340, trailingSilenceMs: 350, reason: 'silence' }
    })

    vi.advanceTimersByTime(120)
    emitTranscript('What is Node.js?')
    expect(fired).toEqual([]) // still inside the grace window

    // 350ms hangover + 120ms whisper already consumed part of the 900ms budget.
    vi.advanceTimersByTime(431)
    expect(fired).toEqual(['What is Node.js?'])
  })

  it('does not keep audio of answered utterances for the rest of the session', () => {
    // Regression: every segment used to be pushed onto a list that nothing
    // read and only a capture restart cleared (~37 KB per second of speech).
    for (let i = 0; i < 20; i++) {
      workerMessage(service, { type: 'speech-start' })
      workerMessage(service, {
        type: 'segment',
        data: new Int16Array(16000).buffer,
        meta: { durationMs: 1000, trailingSilenceMs: 350, reason: 'silence' }
      })
      emitTranscript(`Question number ${i}?`)
      vi.advanceTimersByTime(900)
    }
    expect(fired).toHaveLength(20)

    let retainedBytes = 0
    for (const value of Object.values(service as object)) {
      if (Array.isArray(value)) {
        for (const item of value) if (Buffer.isBuffer(item)) retainedBytes += item.length
      }
    }
    // At most the latest utterance (one 32 KB segment) may still be referenced.
    expect(retainedBytes).toBeLessThanOrEqual(32000)
  })

  it('does not treat a cap split as the speaker stopping', () => {
    workerMessage(service, { type: 'speech-start' })
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 8000, trailingSilenceMs: 0, reason: 'cap' }
    })

    emitTranscript('Tell me about your project')
    vi.advanceTimersByTime(900)
    expect(fired).toEqual([]) // still speaking: hold
  })
})

describe('utterance continuation: onset hint (activity)', () => {
  let service: AudioService
  let fired: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    fired = []
    service = new AudioService({ mode: 'whisper' }, false)
    service.setWindow(makeWindow())
    service.setOnFinalTranscript((text) => fired.push(text))
  })

  afterEach(() => {
    vi.useRealTimers()
    service.destroy()
  })

  const segment = (): void =>
    workerMessage(service, {
      type: 'segment',
      data: new Int16Array(1600).buffer,
      meta: { durationMs: 100, trailingSilenceMs: 350, reason: 'silence' }
    })

  it('holds a pending commit when a resuming speaker is about to be confirmed', () => {
    workerMessage(service, { type: 'speech-start' })
    segment()
    sttEvents.get('transcript')?.('What is the difference between?', true)
    // Commit due ~550ms from now (900ms grace from end-of-speech)...
    vi.advanceTimersByTime(500)
    workerMessage(service, { type: 'activity' }) // first loud frame of part two
    vi.advanceTimersByTime(100) // the original commit time passes
    expect(fired).toEqual([])
    workerMessage(service, { type: 'speech-start' }) // confirmed: a continuation
    expect(fired).toEqual([])
  })

  it('commits after the hold if the hint was only a blip', () => {
    workerMessage(service, { type: 'speech-start' })
    segment()
    sttEvents.get('transcript')?.('What is a closure?', true)
    vi.advanceTimersByTime(500)
    workerMessage(service, { type: 'activity' })
    vi.advanceTimersByTime(299)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(2)
    expect(fired).toEqual(['What is a closure?'])
  })

  it('does not delay a commit when nothing stirs after the question', () => {
    workerMessage(service, { type: 'speech-start' })
    segment()
    sttEvents.get('transcript')?.('What is a closure?', true)
    vi.advanceTimersByTime(900)
    expect(fired).toEqual(['What is a closure?'])
  })

  it('holds when the hint arrived before the transcript did', () => {
    workerMessage(service, { type: 'speech-start' })
    segment()
    vi.advanceTimersByTime(850)
    workerMessage(service, { type: 'activity' }) // speaker resumes before whisper returns
    sttEvents.get('transcript')?.('How would you design?', true)
    vi.advanceTimersByTime(100)
    expect(fired).toEqual([]) // would have committed immediately (grace used up)
    vi.advanceTimersByTime(250)
    expect(fired).toEqual(['How would you design?'])
  })
})
