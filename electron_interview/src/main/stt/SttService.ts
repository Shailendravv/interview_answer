import { existsSync } from 'fs'
import { STTEngine } from '../../shared/stt/sttProvider'
import { EventEmitter } from 'events'
import { WhisperProvider } from './WhisperProvider'
import { WhisperServerProvider } from './WhisperServerProvider'
import { ParakeetProvider } from './ParakeetProvider'
import { DeepgramProvider } from './DeepgramProvider'

export interface SttServiceConfig {
  mode: 'whisper' | 'parakeet' | 'deepgram'
  deepgramApiKey?: string
  parakeetServerUrl?: string
  whisperModelPath?: string
  whisperBinaryPath?: string
  whisperServerBinaryPath?: string
  whisperServerHost?: string
  whisperServerPort?: number
  whisperInitialPrompt?: string
  whisperNoSpeechThreshold?: number
  silenceTimeoutMs?: number
  vadPadFrames?: number
  vadMaxSegmentMs?: number
}

class NoopSTTEngine extends EventEmitter implements STTEngine {
  readonly name = 'none'
  async start(): Promise<void> {
    const msg = 'No STT engine is available. Configure whisper.cpp, a Deepgram API key, or a Parakeet server.'
    console.warn('[STT] ' + msg)
    this.emit('status', { engine: 'none', error: msg })
    this.emit('error', new Error(msg))
  }
  stop(): void {}
  feedAudioChunk(_chunk: Buffer): void {}
  finalize(): void {}
  cancel(): void {}
}

class FallbackSTTEngine extends EventEmitter implements STTEngine {
  readonly name: string
  private engines: STTEngine[] = []
  private currentIndex = 0
  private currentEngine: STTEngine | null = null
  private isActive = false
  private hasAdvanced = false

  get currentEngineName(): string {
    return this.currentEngine?.name ?? 'none'
  }

  constructor(engines: STTEngine[]) {
    super()
    this.engines = engines
    this.name = engines.map(e => e.name).join(' → ') || 'none'
  }

  async start(): Promise<void> {
    this.isActive = true
    await this.tryStartEngine()
  }

  private async tryStartEngine(): Promise<void> {
    this.hasAdvanced = false
    while (this.currentIndex < this.engines.length) {
      const engine = this.engines[this.currentIndex]
      try {
        await engine.start()
        this.currentEngine = engine
        this.forwardChildEvents(engine)
        const msg = `STT engine: ${engine.name}`
        console.log('[STT] ' + msg)
        this.emit('status', { engine: engine.name, error: null })
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[STT] Engine "${engine.name}" failed to start: ${msg}`)
        this.currentIndex++
      }
    }
    const msg = 'No STT engine is available.'
    console.warn('[STT] ' + msg)
    this.emit('status', { engine: 'none', error: msg })
    this.emit('error', new Error(msg))
  }

  private forwardChildEvents(engine: STTEngine): void {
    engine.on('transcript', (text, isFinal) => {
      this.emit('transcript', text, isFinal)
    })
    engine.on('ready', () => {
      this.emit('ready')
    })
    engine.on('error', (err) => {
      if (this.hasAdvanced) return
      this.hasAdvanced = true
      console.warn(`[STT] Engine "${engine.name}" error: ${err.message}. Advancing to next...`)
      this.currentIndex++
      this.tryStartEngine()
    })
  }

  stop(): void {
    this.isActive = false
    this.currentEngine?.stop()
    this.currentEngine = null
  }

  feedAudioChunk(chunk: Buffer): void {
    if (!this.isActive || !this.currentEngine) return
    this.currentEngine.feedAudioChunk(chunk)
  }

  finalize(): void {
    this.currentEngine?.finalize()
  }

  cancel(): void {
    this.currentEngine?.cancel()
  }

  removeAllListeners(event?: string): this {
    super.removeAllListeners(event)
    for (const engine of this.engines) {
      engine.removeAllListeners(event)
    }
    return this
  }
}

function modelAvailable(config: SttServiceConfig): string | null {
  const modelPath = config.whisperModelPath || ''
  if (!modelPath || !existsSync(modelPath)) {
    console.warn(`[STT] Whisper model not found at "${modelPath}" — skipping whisper`)
    return null
  }
  return modelPath
}

function binaryAvailable(binaryPath: string, name: string): boolean {
  if (!binaryPath) return false
  const hasSep = binaryPath.includes('/') || binaryPath.includes('\\')
  if (hasSep && !existsSync(binaryPath)) {
    console.warn(`[STT] Binary not found at "${binaryPath}" — skipping ${name}`)
    return false
  }
  return true
}

export function createSttService(config: SttServiceConfig): STTEngine {
  const engines: STTEngine[] = []
  const modelPath = modelAvailable(config)

  // 1. whisper-server (persistent HTTP, fastest)
  if (modelPath && binaryAvailable(config.whisperServerBinaryPath || '', 'whisper-server')) {
    engines.push(
      new WhisperServerProvider({
        modelPath,
        binaryPath: config.whisperServerBinaryPath || '',
        host: config.whisperServerHost || '127.0.0.1',
        port: config.whisperServerPort || 8080,
        language: 'en',
        initialPrompt: config.whisperInitialPrompt,
        noSpeechThreshold: config.whisperNoSpeechThreshold
      })
    )
  }

  // 2. whisper-cli (batch, fallback if server unavailable)
  if (modelPath && binaryAvailable(config.whisperBinaryPath || '', 'whisper-cli')) {
    engines.push(
      new WhisperProvider({
        modelPath,
        binaryPath: config.whisperBinaryPath || 'whisper-cli',
        language: 'en',
        initialPrompt: config.whisperInitialPrompt
      })
    )
  }

  if (config.deepgramApiKey) {
    engines.push(new DeepgramProvider({ apiKey: config.deepgramApiKey }))
  }

  if (config.parakeetServerUrl) {
    engines.push(new ParakeetProvider({ serverUrl: config.parakeetServerUrl }))
  }

  if (engines.length === 0) {
    return new NoopSTTEngine()
  }

  return new FallbackSTTEngine(engines)
}
