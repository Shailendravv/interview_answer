import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WhisperServerProvider } from '../src/main/stt/WhisperServerProvider'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  fetch: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: mocks.spawn
}))

class FakeStdout extends EventEmitter {}

class FakeProcess extends EventEmitter {
  stdout = new FakeStdout()
  stderr = new FakeStdout()
  killed = false
  kill(): void {
    this.killed = true
  }
}

function makeProvider(): WhisperServerProvider {
  return new WhisperServerProvider({
    modelPath: '/models/ggml-small.en.bin',
    binaryPath: 'whisper-server',
    host: '127.0.0.1',
    port: 8080
  })
}

const bytes = (n: number): Buffer => Buffer.alloc(n, 0x01)

const okJson = (data: unknown) => ({ ok: true, json: async () => data })

describe('WhisperServerProvider', () => {
  beforeEach(() => {
    mocks.spawn.mockReset()
    mocks.spawn.mockImplementation(() => new FakeProcess())
    mocks.fetch.mockReset()
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/health')) {
        // Health only reports ok once whisper-server has actually been spawned,
        // so the first start() goes through the spawn path and later starts reuse it.
        if (mocks.spawn.mock.calls.length > 0) return okJson({ status: 'ok' })
        return { ok: false, status: 503, json: async () => ({}) }
      }
      return okJson({
        text: 'Node.js is a runtime',
        segments: [{ text: 'Node.js is a runtime', no_speech_prob: 0.02 }]
      })
    })
    global.fetch = mocks.fetch
  })

  it('emits interim transcripts (isFinal=false) at the byte threshold', async () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    await provider.start()

    provider.feedAudioChunk(bytes(16000))

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'Node.js is a runtime', isFinal: false })
  })

  it('finalize() transcribes buffered audio as final', async () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    await provider.start()

    provider.feedAudioChunk(bytes(8000))
    provider.finalize()

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'Node.js is a runtime', isFinal: true })
  })

  it('finalize() while a transcribe is in flight makes the in-flight result final', async () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    await provider.start()

    provider.feedAudioChunk(bytes(16000))
    provider.finalize()

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'Node.js is a runtime', isFinal: true })
  })

  it('ignores audio chunks before start()', async () => {
    const provider = makeProvider()

    provider.feedAudioChunk(bytes(16000))

    expect(mocks.spawn).toHaveBeenCalledTimes(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(0)
  })

  it('start() spawns only once and is idempotent while healthy', async () => {
    const provider = makeProvider()

    await provider.start()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    await provider.start()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('stop() then start() reuses a still-healthy server instead of respawning', async () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    await provider.start()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    provider.stop()
    await provider.start()

    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    provider.feedAudioChunk(bytes(16000))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'Node.js is a runtime', isFinal: false })
  })

  it('transcribe timeout resets busy and the pipeline recovers', async () => {
    const provider = new WhisperServerProvider({
      modelPath: '/models/ggml-small.en.bin',
      binaryPath: 'whisper-server',
      host: '127.0.0.1',
      port: 8080,
      inferenceTimeoutMs: 50
    })
    const events: { text: string; isFinal: boolean }[] = []
    const errors: Error[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    provider.on('error', (err) => errors.push(err))
    await provider.start()

    let inferenceCalls = 0
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return okJson({ status: 'ok' })
      if (url.includes('/inference')) {
        inferenceCalls++
        if (inferenceCalls === 1) {
          // First inference never returns; only settles when the timeout aborts it.
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('timed out', 'TimeoutError'))
            )
          })
        }
      }
      return okJson({
        text: 'recovered',
        segments: [{ text: 'recovered', no_speech_prob: 0.01 }]
      })
    })

    provider.feedAudioChunk(bytes(16000))

    await new Promise((r) => setTimeout(r, 150))

    // Timed-out request produced no transcript and did not surface as an engine error.
    expect(events).toHaveLength(0)
    expect(errors).toHaveLength(0)

    // Pipeline is unblocked: a new segment transcribes normally and finalizes.
    provider.feedAudioChunk(bytes(16000))
    provider.finalize()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'recovered', isFinal: true })
  })

  it('appends the prompt form field when initialPrompt is configured', async () => {
    const provider = new WhisperServerProvider({
      modelPath: '/models/ggml-small.en.bin',
      binaryPath: 'whisper-server',
      host: '127.0.0.1',
      port: 8080,
      initialPrompt: 'Interview Q&A. Keywords: Node.js'
    })
    provider.on('transcript', () => {})
    await provider.start()

    let promptValue: string | null = null
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return okJson({ status: 'ok' })
      if (url.includes('/inference')) {
        const form = init?.body as FormData
        promptValue = form.get('prompt') as string | null
        return okJson({
          text: 'x',
          segments: [{ text: 'x', no_speech_prob: 0.01 }]
        })
      }
      return okJson({})
    })

    provider.feedAudioChunk(bytes(16000))
    await vi.waitFor(() => expect(promptValue).not.toBeNull())
    expect(promptValue).toBe('Interview Q&A. Keywords: Node.js')
  })

  it('cancel() aborts an in-flight inference, clears the deadlock, and recovers', async () => {
    const provider = makeProvider()
    const errors: Error[] = []
    provider.on('error', (err) => errors.push(err))
    await provider.start()

    let inferenceAborted = false
    let inferenceCalls = 0
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return okJson({ status: 'ok' })
      if (url.includes('/inference')) {
        inferenceCalls++
        if (inferenceCalls === 1) {
          // Only the first request hangs until explicitly aborted (the deadlock case).
          await new Promise<void>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              inferenceAborted = true
              reject(new DOMException('aborted', 'AbortError'))
            })
          })
        }
      }
      return okJson({
        text: 'x',
        segments: [{ text: 'x', no_speech_prob: 0.01 }]
      })
    })

    provider.feedAudioChunk(bytes(16000))
    await vi.waitFor(() => {
      const inferenceCalls = mocks.fetch.mock.calls.filter((c) => String(c[0]).includes('/inference'))
      expect(inferenceCalls.length).toBe(1)
    })

    provider.cancel()

    await new Promise((r) => setTimeout(r, 50))
    expect(inferenceAborted).toBe(true)
    expect(errors).toHaveLength(0)

    // Pipeline is unblocked: a new segment transcribes and finalizes normally.
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    provider.feedAudioChunk(bytes(16000))
    provider.finalize()

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'x', isFinal: true })
  })

  it('caps the POST body size and drains the remainder', async () => {
    const provider = makeProvider()
    const sizes: number[] = []
    provider.on('transcript', () => {})
    await provider.start()

    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return okJson({ status: 'ok' })
      if (url.includes('/inference')) {
        const form = init?.body as FormData
        const blob = form.get('file') as Blob
        sizes.push(blob.size - 44)
        return okJson({
          text: 'x',
          segments: [{ text: 'x', no_speech_prob: 0.01 }]
        })
      }
      return okJson({})
    })

    provider.feedAudioChunk(bytes(300 * 1024))
    provider.finalize()

    await vi.waitFor(() => expect(sizes.length).toBe(2))
    expect(sizes.every((s) => s <= 256 * 1024)).toBe(true)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(300 * 1024)
  })
})
