import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WhisperProvider } from '../src/main/stt/WhisperProvider'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn()
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

function makeProvider(): WhisperProvider {
  return new WhisperProvider({ modelPath: '/models/ggml-small.en.bin', binaryPath: 'whisper-cli' })
}

const bytes = (n: number): Buffer => Buffer.alloc(n, 0x01)

describe('WhisperProvider', () => {
  beforeEach(() => {
    mocks.spawn.mockReset()
    mocks.spawn.mockImplementation(() => new FakeProcess())
  })

  it('emits interim transcripts (isFinal=false) at the byte threshold', () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    void provider.start()

    provider.feedAudioChunk(bytes(16000))

    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    const proc = mocks.spawn.mock.results[0].value as FakeProcess
    proc.stdout.emit('data', Buffer.from('{"text":"What is Node.js?"}'))
    proc.emit('close', 0)

    expect(events).toEqual([{ text: 'What is Node.js?', isFinal: false }])
  })

  it('does not transcribe below the byte threshold', () => {
    const provider = makeProvider()
    void provider.start()

    provider.feedAudioChunk(bytes(8000))

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('finalize() transcribes buffered audio as final', () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    void provider.start()

    provider.feedAudioChunk(bytes(8000))
    expect(mocks.spawn).not.toHaveBeenCalled()

    provider.finalize()

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const proc = mocks.spawn.mock.results[0].value as FakeProcess
    proc.stdout.emit('data', Buffer.from('{"text":"hello"}'))
    proc.emit('close', 0)

    expect(events).toEqual([{ text: 'hello', isFinal: true }])
  })

  it('finalize() with nothing buffered is a no-op', () => {
    const provider = makeProvider()
    provider.on('transcript', () => {})
    void provider.start()

    provider.finalize()

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('finalize() while a transcribe is in flight makes it final and flushes pending', () => {
    const provider = makeProvider()
    const events: { text: string; isFinal: boolean }[] = []
    provider.on('transcript', (text, isFinal) => events.push({ text, isFinal }))
    void provider.start()

    provider.feedAudioChunk(bytes(16000))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    provider.feedAudioChunk(bytes(4000))
    provider.finalize()

    const proc = mocks.spawn.mock.results[0].value as FakeProcess
    proc.stdout.emit('data', Buffer.from('{"text":"first"}'))
    proc.emit('close', 0)

    expect(events[0]).toEqual({ text: 'first', isFinal: true })
    expect(mocks.spawn).toHaveBeenCalledTimes(2)

    const proc2 = mocks.spawn.mock.results[1].value as FakeProcess
    proc2.stdout.emit('data', Buffer.from('{"text":"second"}'))
    proc2.emit('close', 0)

    expect(events[1]).toEqual({ text: 'second', isFinal: true })
  })

  it('ignores audio chunks before start()', () => {
    const provider = makeProvider()

    provider.feedAudioChunk(bytes(16000))

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('cancel() kills the running process and clears the queue so a later chunk transcribes', () => {
    const provider = makeProvider()
    provider.on('transcript', () => {})
    void provider.start()

    provider.feedAudioChunk(bytes(16000))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const proc = mocks.spawn.mock.results[0].value as FakeProcess

    provider.feedAudioChunk(bytes(8000))
    provider.cancel()

    expect(proc.killed).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    provider.feedAudioChunk(bytes(16000))
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })

  it('passes the initial prompt via -p when configured', () => {
    const provider = new WhisperProvider({
      modelPath: '/models/ggml-small.en.bin',
      binaryPath: 'whisper-cli',
      initialPrompt: 'Interview Q&A. Keywords: Node.js'
    })
    provider.on('transcript', () => {})
    void provider.start()

    provider.feedAudioChunk(bytes(16000))

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const args = mocks.spawn.mock.calls[0][1] as string[]
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('Interview Q&A. Keywords: Node.js')
  })
})
