import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ParakeetProvider } from '../src/main/stt/ParakeetProvider'

const fetchMock = vi.hoisted(() => vi.fn())

function makeProvider(): ParakeetProvider {
  return new ParakeetProvider({ serverUrl: 'http://localhost:5000/transcribe' })
}

const bytes = (n: number): Buffer => Buffer.alloc(n, 0x01)

describe('ParakeetProvider', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello there' }) })
    global.fetch = fetchMock
  })

  it('emits interim transcripts (isFinal=false) at the byte threshold', async () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    await provider.start()

    provider.feedAudioChunk(bytes(16000))

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'hello there', isFinal: false })
  })

  it('does not transcribe below the byte threshold', async () => {
    const provider = makeProvider()
    await provider.start()

    provider.feedAudioChunk(bytes(8000))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('finalize() transcribes buffered audio as final', async () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    await provider.start()

    provider.feedAudioChunk(bytes(8000))
    expect(fetchMock).not.toHaveBeenCalled()

    provider.finalize()

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toEqual({ text: 'hello there', isFinal: true })
  })

  it('finalize() with an empty buffer is a no-op', async () => {
    const provider = makeProvider()
    await provider.start()

    provider.finalize()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores audio chunks before start()', async () => {
    const provider = makeProvider()

    provider.feedAudioChunk(bytes(16000))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
