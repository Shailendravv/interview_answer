import { existsSync } from 'fs'
import { basename } from 'path'
import { STTEngine } from '../../shared/stt/sttProvider'
import { EventEmitter } from 'events'
import { WhisperProvider } from './WhisperProvider'
import { WhisperServerProvider } from './WhisperServerProvider'
import { DeepgramProvider } from './DeepgramProvider'

export interface SttServiceConfig {
  mode: 'whisper' | 'deepgram'
  deepgramApiKey?: string
  whisperModelPath?: string
  whisperBinaryPath?: string
  whisperServerBinaryPath?: string
  /** GPU (CUDA) build of whisper-server, tried before the CPU one when present. */
  whisperCudaServerBinaryPath?: string
  /** Vulkan build of whisper-server: any GPU with a Vulkan driver (NVIDIA, AMD, Intel). Tried after CUDA. */
  whisperVulkanServerBinaryPath?: string
  whisperServerHost?: string
  whisperServerPort?: number
  whisperInitialPrompt?: string
  /**
   * Decode language passed to whisper ("en" default; "hi", "auto", ...). Only
   * multilingual models can use anything but "en" -- a *.en model forces "en".
   */
  whisperLanguage?: string
  whisperNoSpeechThreshold?: number
  silenceTimeoutMs?: number
  /** Silence required to close a segment, in ms of audio (not frame counts). */
  vadHangoverMs?: number
  /** Audio kept from before the speech onset, so soft lead-ins survive. */
  vadPreRollMs?: number
  vadMaxSegmentMs?: number
  /** How long after end-of-speech a new segment still counts as the same question. */
  continuationGraceMs?: number
}

class NoopSTTEngine extends EventEmitter implements STTEngine {
  readonly name = 'none'
  async start(): Promise<void> {
    const msg = 'No STT engine is available. Configure whisper.cpp or a Deepgram API key.'
    console.warn('[STT] ' + msg)
    this.emit('status', { engine: 'none', error: msg })
    this.emit('error', new Error(msg))
  }
  stop(): void {}
  feedAudioChunk(_chunk: Buffer): void {}
  finalize(): void {}
  cancel(): void {}
}

// A single failed request (a dropped connection, a 500) used to switch the
// session permanently to the next engine -- typically whisper-cli, which
// reloads the model on every segment. Only repeated failures in a short window
// mean the engine is really gone; whisper-server respawns its own process.
const ENGINE_ERROR_WINDOW_MS = 60000
const ENGINE_MAX_ERRORS = 3

export class FallbackSTTEngine extends EventEmitter implements STTEngine {
  readonly name: string
  private engines: STTEngine[] = []
  private currentIndex = 0
  private currentEngine: STTEngine | null = null
  private isActive = false
  private hasAdvanced = false
  private recentErrors: number[] = []
  /** Engines whose events are already forwarded, so a restart cannot duplicate them. */
  private forwarded = new Set<STTEngine>()

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
    this.recentErrors = []
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
    if (this.forwarded.has(engine)) return
    this.forwarded.add(engine)
    engine.on('transcript', (text, isFinal) => {
      if (engine !== this.currentEngine) return
      this.emit('transcript', text, isFinal)
    })
    engine.on('ready', () => {
      if (engine !== this.currentEngine) return
      this.emit('ready')
    })
    engine.on('error', (err) => {
      if (engine !== this.currentEngine || this.hasAdvanced) return
      const now = Date.now()
      this.recentErrors = this.recentErrors.filter((t) => now - t < ENGINE_ERROR_WINDOW_MS)
      this.recentErrors.push(now)
      if (this.recentErrors.length < ENGINE_MAX_ERRORS) {
        console.warn(
          `[STT] Engine "${engine.name}" error: ${err.message} ` +
            `(${this.recentErrors.length}/${ENGINE_MAX_ERRORS} in ${ENGINE_ERROR_WINDOW_MS / 1000}s; staying on it)`
        )
        return
      }
      this.hasAdvanced = true
      console.warn(`[STT] Engine "${engine.name}" error: ${err.message}. Advancing to next...`)
      // Release the abandoned engine (its process, port and temp dir).
      engine.stop()
      this.currentEngine = null
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

/** English-only ggml models (ggml-small.en.bin, ggml-base.en-q5_1.bin, ...). */
function isEnglishOnlyModel(modelPath: string): boolean {
  return /\.en([-_.]|$)/i.test(basename(modelPath).replace(/\.bin$/i, ''))
}

export function resolveSttLanguage(config: SttServiceConfig): string {
  const requested = (config.whisperLanguage || 'en').trim().toLowerCase()
  if (requested !== 'en' && config.whisperModelPath && isEnglishOnlyModel(config.whisperModelPath)) {
    console.warn(
      `[STT] STT_LANGUAGE=${requested} needs a multilingual model, but ` +
        `"${basename(config.whisperModelPath)}" is English-only; using "en".`
    )
    return 'en'
  }
  return requested
}

export function createSttService(config: SttServiceConfig): STTEngine {
  const engines: STTEngine[] = []
  const modelPath = modelAvailable(config)
  const language = resolveSttLanguage(config)

  const serverOptions = {
    host: config.whisperServerHost || '127.0.0.1',
    port: config.whisperServerPort || 8080,
    language,
    initialPrompt: config.whisperInitialPrompt,
    noSpeechThreshold: config.whisperNoSpeechThreshold
  }

  // 0. whisper-server CUDA build (measured ~38x faster than the CPU build on an
  //    RTX 3050). Needs the NVIDIA driver and the CUDA runtime it was built
  //    against; if either is missing it fails to start and the CPU build runs.
  if (modelPath && config.whisperCudaServerBinaryPath && binaryAvailable(config.whisperCudaServerBinaryPath, 'whisper-server-cuda')) {
    engines.push(
      new WhisperServerProvider({
        name: 'whisper-server-cuda',
        modelPath,
        binaryPath: config.whisperCudaServerBinaryPath,
        ...serverOptions,
        selfTest: true
      })
    )
  }

  // 0b. whisper-server Vulkan build: needs only the GPU driver, so it is the
  //     GPU path on machines without the CUDA toolkit, and on AMD/Intel GPUs.
  if (modelPath && config.whisperVulkanServerBinaryPath && binaryAvailable(config.whisperVulkanServerBinaryPath, 'whisper-server-vulkan')) {
    engines.push(
      new WhisperServerProvider({
        name: 'whisper-server-vulkan',
        modelPath,
        binaryPath: config.whisperVulkanServerBinaryPath,
        ...serverOptions,
        selfTest: true,
        preferDiscreteGpu: true
      })
    )
  }

  // 1. whisper-server (persistent HTTP, fastest on CPU)
  if (modelPath && binaryAvailable(config.whisperServerBinaryPath || '', 'whisper-server')) {
    engines.push(
      new WhisperServerProvider({
        modelPath,
        binaryPath: config.whisperServerBinaryPath || '',
        ...serverOptions
      })
    )
  }

  // 2. whisper-cli (batch, fallback if server unavailable)
  if (modelPath && binaryAvailable(config.whisperBinaryPath || '', 'whisper-cli')) {
    engines.push(
      new WhisperProvider({
        modelPath,
        binaryPath: config.whisperBinaryPath || 'whisper-cli',
        language,
        initialPrompt: config.whisperInitialPrompt
      })
    )
  }

  if (config.deepgramApiKey) {
    engines.push(new DeepgramProvider({ apiKey: config.deepgramApiKey }))
  }

  if (engines.length === 0) {
    return new NoopSTTEngine()
  }

  return new FallbackSTTEngine(engines)
}
