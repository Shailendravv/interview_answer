import { EventEmitter } from 'events'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { FallbackSTTEngine, createSttService, resolveSttLanguage } from '../src/main/stt/SttService'
import type { STTEngine } from '../src/shared/stt/sttProvider'

class FakeEngine extends EventEmitter implements STTEngine {
  started = 0
  stopped = 0
  constructor(readonly name: string, private failStart = false) {
    super()
  }
  async start(): Promise<void> {
    this.started++
    if (this.failStart) throw new Error(`${this.name} cannot start`)
  }
  stop(): void {
    this.stopped++
  }
  feedAudioChunk(): void {}
  finalize(): void {}
  cancel(): void {}
}

describe('FallbackSTTEngine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('falls through to the next engine when one cannot start (CUDA missing -> CPU)', async () => {
    const cuda = new FakeEngine('whisper-server-cuda', true)
    const cpu = new FakeEngine('whisper-server')
    const chain = new FallbackSTTEngine([cuda, cpu])
    const texts: string[] = []
    chain.on('transcript', (t: string) => texts.push(t))
    await chain.start()

    expect(chain.currentEngineName).toBe('whisper-server')
    cpu.emit('transcript', 'hello', true)
    expect(texts).toEqual(['hello'])
  })

  it('stays on the engine after a single transient error', async () => {
    const server = new FakeEngine('whisper-server')
    const cli = new FakeEngine('whisper-cli')
    const chain = new FallbackSTTEngine([server, cli])
    await chain.start()

    server.emit('error', new Error('ECONNRESET'))
    server.emit('error', new Error('whisper-server returned 500'))

    expect(chain.currentEngineName).toBe('whisper-server')
    expect(cli.started).toBe(0)
  })

  it('advances after repeated errors and stops the abandoned engine', async () => {
    const server = new FakeEngine('whisper-server')
    const cli = new FakeEngine('whisper-cli')
    const chain = new FallbackSTTEngine([server, cli])
    const texts: string[] = []
    chain.on('transcript', (t: string) => texts.push(t))
    await chain.start()

    for (let i = 0; i < 3; i++) server.emit('error', new Error('down'))
    await vi.waitFor(() => expect(chain.currentEngineName).toBe('whisper-cli'))

    expect(server.stopped).toBe(1)
    // A late result from the abandoned engine must not leak through.
    server.emit('transcript', 'stale', true)
    cli.emit('transcript', 'fresh', true)
    expect(texts).toEqual(['fresh'])
  })

  it('forgets old errors outside the window', async () => {
    vi.useFakeTimers()
    const server = new FakeEngine('whisper-server')
    const chain = new FallbackSTTEngine([server, new FakeEngine('whisper-cli')])
    await chain.start()

    server.emit('error', new Error('a'))
    server.emit('error', new Error('b'))
    vi.advanceTimersByTime(61000)
    server.emit('error', new Error('c'))

    expect(chain.currentEngineName).toBe('whisper-server')
  })

  it('does not duplicate transcripts when started again', async () => {
    const server = new FakeEngine('whisper-server')
    const chain = new FallbackSTTEngine([server])
    const texts: string[] = []
    chain.on('transcript', (t: string) => texts.push(t))
    await chain.start()
    await chain.start()

    server.emit('transcript', 'once', true)
    expect(texts).toEqual(['once'])
  })
})

describe('createSttService engine order', () => {
  it('puts the CUDA server first, then the CPU server, then the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-order-'))
    const file = (name: string): string => {
      const p = join(dir, name)
      writeFileSync(p, '')
      return p
    }
    const engine = createSttService({
      mode: 'whisper',
      whisperModelPath: file('model.bin'),
      whisperCudaServerBinaryPath: file('cuda-server.exe'),
      whisperServerBinaryPath: file('server.exe'),
      whisperBinaryPath: file('cli.exe')
    })
    expect(engine.name).toBe('whisper-server-cuda → whisper-server → whisper.cpp')
  })

  it('tries Vulkan after CUDA and before the CPU server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-order-'))
    const file = (name: string): string => {
      const p = join(dir, name)
      writeFileSync(p, '')
      return p
    }
    const engine = createSttService({
      mode: 'whisper',
      whisperModelPath: file('model.bin'),
      whisperCudaServerBinaryPath: file('cuda-server.exe'),
      whisperVulkanServerBinaryPath: file('vulkan-server.exe'),
      whisperServerBinaryPath: file('server.exe')
    })
    expect(engine.name).toBe('whisper-server-cuda → whisper-server-vulkan → whisper-server')
  })

  it('omits the CUDA engine when no CUDA binary is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-order-'))
    const model = join(dir, 'model.bin')
    const server = join(dir, 'server.exe')
    writeFileSync(model, '')
    writeFileSync(server, '')
    const engine = createSttService({ mode: 'whisper', whisperModelPath: model, whisperServerBinaryPath: server })
    expect(engine.name).toBe('whisper-server')
  })
})

describe('resolveSttLanguage', () => {
  it('defaults to English', () => {
    expect(resolveSttLanguage({ mode: 'whisper', whisperModelPath: '/m/ggml-large-v3-turbo.bin' })).toBe('en')
  })

  it('passes a non-English language through for a multilingual model', () => {
    expect(resolveSttLanguage({ mode: 'whisper', whisperModelPath: '/m/ggml-large-v3-turbo.bin', whisperLanguage: 'hi' })).toBe('hi')
    expect(resolveSttLanguage({ mode: 'whisper', whisperModelPath: '/m/ggml-small.bin', whisperLanguage: 'Auto' })).toBe('auto')
  })

  it('forces English for English-only models', () => {
    for (const model of ['/m/ggml-small.en.bin', '/m/ggml-base.en-q5_1.bin', 'C:\m\ggml-medium.en.bin']) {
      expect(resolveSttLanguage({ mode: 'whisper', whisperModelPath: model, whisperLanguage: 'hi' })).toBe('en')
    }
  })
})
