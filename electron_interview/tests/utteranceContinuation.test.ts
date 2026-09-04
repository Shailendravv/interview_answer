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
