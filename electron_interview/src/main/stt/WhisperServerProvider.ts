import { ChildProcess, spawn } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BaseSTTEngine } from '../../shared/stt/sttProvider'

interface ServerConfig {
  modelPath: string
  binaryPath: string
  host?: string
  port?: number
  language?: string
  initialPrompt?: string
  noSpeechThreshold?: number
  inferenceTimeoutMs?: number
}

// ~8s of 16kHz mono PCM; whisper degrades on longer chunks, so never POST more.
const MAX_CHUNK_BYTES = 256 * 1024

export class WhisperServerProvider extends BaseSTTEngine {
  readonly name = 'whisper-server'

  private process: ChildProcess | null = null
  private buffer: Buffer[] = []
  private pendingBuffer: Buffer[] = []
  private isRunning = false
  private busy = false
  private tempDir: string | null = null
  private port = 8080
  private host = '127.0.0.1'

  private noSpeechThreshold: number
  private inferenceTimeoutMs: number
  private finalizePending = false
  private stopping = false
  private healthController: AbortController | null = null
  private abortController: AbortController | null = null
  private startPromise: Promise<void> | null = null

  constructor(private config: ServerConfig) {
    super()
    this.host = config.host || '127.0.0.1'
    this.port = config.port || 8080
    this.noSpeechThreshold = config.noSpeechThreshold ?? 0.6
    this.inferenceTimeoutMs = config.inferenceTimeoutMs ?? 60000
  }

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    this.stopping = false

    if (await this.isHealthy()) {
      this.isRunning = true
      if (!this.tempDir) this.tempDir = mkdtempSync(join(tmpdir(), 'whisper-server-'))
      this.emit('ready')
      this.emit('status', { engine: this.name, error: null })
      return
    }

    this.buffer = []
    this.pendingBuffer = []
    this.busy = false
    this.finalizePending = false
    this.isRunning = true
    this.tempDir = mkdtempSync(join(tmpdir(), 'whisper-server-'))

    try {
      await this.spawnServer(3)
      this.emit('ready')
      this.emit('status', { engine: this.name, error: null })
    } catch (err) {
      this.isRunning = false
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return false
      const body = await res.json() as { status?: string }
      return body.status === 'ok'
    } catch {
      return false
    }
  }

  private async spawnServer(retryCount: number, retryDelay = 0): Promise<void> {
    if (retryDelay > 0) {
      await new Promise(r => setTimeout(r, retryDelay))
    }
    if (this.stopping) return

    const args = [
      '-m', this.config.modelPath,
      '-l', this.config.language || 'en',
      '--host', this.host,
      '--port', String(this.port)
    ]

    const proc = spawn(this.config.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.process = proc

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log('[whisper-server]', line)
    })

    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log('[whisper-server]', line)
    })

    proc.on('error', (err) => {
      console.error('[whisper-server] spawn error:', err.message)
    })

    const serverReady = new Promise<void>((resolve, reject) => {
      proc.once('exit', (code) => {
        console.warn(`[whisper-server] exited with code ${code}`)
        this.process = null

        if (this.stopping) {
          reject(new Error('whisper-server stopped'))
          return
        }

        if (retryCount > 0) {
          console.log(`[whisper-server] respawning (${retryCount} retries left)...`)
          this.emit('status', { engine: this.name, error: 'reconnecting' })
          this.spawnServer(retryCount - 1, 2000).then(resolve, reject)
        } else {
          reject(new Error('whisper-server exited and gave up retrying'))
        }
      })

      const controller = new AbortController()
      this.healthController = controller
      this.waitForHealth(30000, controller.signal)
        .then(() => {
          if (!this.stopping) {
            controller.abort()
            resolve()
          } else {
            reject(new Error('whisper-server stopped'))
          }
        })
        .catch((err) => {
          // Health failed for THIS process — kill it so it can't linger on the port.
          proc.kill()
          this.process = null
          reject(err instanceof Error ? err : new Error(String(err)))
        })
    })

    await serverReady
  }

  private async waitForHealth(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const start = Date.now()
    let lastErr = ''

    while (Date.now() - start < timeoutMs && !signal.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) {
          const body = await res.json() as { status?: string }
          if (body.status === 'ok') {
            console.log(`[whisper-server] Ready at ${this.baseUrl}`)
            return
          }
        }
      } catch {
        // server not ready yet
      }

      if (!lastErr) {
        lastErr = 'whisper-server did not become ready'
      }

      await new Promise(r => setTimeout(r, 200))
    }

    throw new Error(`whisper-server health check failed: ${lastErr}`)
  }

  cancel(): void {
    this.abortController?.abort()
    this.abortController = null
    this.busy = false
    this.buffer = []
    this.pendingBuffer = []
    this.finalizePending = false
  }

  stop(): void {
    this.isRunning = false
    this.busy = false
    this.stopping = true
    this.abortController?.abort()
    this.abortController = null
    this.healthController?.abort()
    this.healthController = null

    if (this.process) {
      this.process.kill()
      this.process = null
    }

    if (this.tempDir) {
      try {
        const fs = require('fs')
        fs.rmSync(this.tempDir, { recursive: true, force: true })
      } catch { /* ignore cleanup errors */ }
      this.tempDir = null
    }

    this.buffer = []
    this.pendingBuffer = []
    this.finalizePending = false
  }

  feedAudioChunk(chunk: Buffer): void {
    if (!this.isRunning) return

    if (this.busy) {
      this.pendingBuffer.push(chunk)
      return
    }

    this.buffer.push(chunk)
    this.flushIfReady()
  }

  finalize(): void {
    if (!this.isRunning) return
    this.finalizePending = true
    if (this.busy) return

    if (this.pendingBuffer.length > 0) {
      this.buffer.push(...this.pendingBuffer)
      this.pendingBuffer = []
    }
    if (this.buffer.length === 0) {
      this.finalizePending = false
      return
    }
    this.transcribeAccumulated(true)
  }

  private flushIfReady(): void {
    const totalBytes = this.buffer.reduce((sum, b) => sum + b.length, 0)
    if (totalBytes < 16000) return

    this.transcribeAccumulated()
  }

  private transcribeAccumulated(isFinal = false): void {
    if (!this.tempDir || this.buffer.length === 0) return

    this.busy = true

    const all = Buffer.concat(this.buffer)
    this.buffer = []

    if (all.length > MAX_CHUNK_BYTES) {
      // Send only the head of an oversized chunk; the tail stays queued so the
      // next flush/finalize transcribes it (whisper degrades on long audio).
      this.pendingBuffer.unshift(Buffer.from(all.subarray(MAX_CHUNK_BYTES)))
      this.transcribe(Buffer.from(all.subarray(0, MAX_CHUNK_BYTES)), isFinal)
      return
    }

    this.transcribe(all, isFinal)
  }

  private flushPending(isFinal = false): void {
    if (this.pendingBuffer.length === 0) return

    const totalBytes = this.pendingBuffer.reduce((sum, b) => sum + b.length, 0)
    if (totalBytes < 8000) {
      this.buffer.push(...this.pendingBuffer)
      this.pendingBuffer = []
      if (isFinal) {
        this.transcribeAccumulated(true)
      }
      return
    }

    this.buffer.push(...this.pendingBuffer)
    this.pendingBuffer = []
    this.transcribeAccumulated(isFinal)
  }

  private async transcribe(pcm16: Buffer, isFinal: boolean): Promise<void> {
    const wav = this.pcmToWav(pcm16)
    const controller = new AbortController()
    this.abortController = controller
    const timer = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      this.inferenceTimeoutMs
    )

    try {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
      form.append('response_format', 'verbose_json')
      if (this.config.initialPrompt) {
        form.append('prompt', this.config.initialPrompt)
      }

      const res = await fetch(`${this.baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: controller.signal
      })

      if (!res.ok) {
        throw new Error(`whisper-server returned ${res.status}`)
      }

      const result = await res.json() as {
        text?: string
        segments?: { text: string; no_speech_prob?: number }[]
      }
      const segments = result.segments || []
      const kept: string[] = []
      for (const seg of segments) {
        const nsp = seg.no_speech_prob ?? 0
        const segText = seg.text?.trim() || ''
        if (nsp > this.noSpeechThreshold) {
          console.log(`[whisper] dropped non-speech (nsp=${nsp.toFixed(3)}): "${segText}"`)
          continue
        }
        if (segText) kept.push(segText)
      }
      if (kept.length > 0) {
        const shouldFinalize = isFinal || this.finalizePending
        this.finalizePending = false
        const text = kept.join(' ').trim()
        console.log(`[whisper] text="${text}" (${segments.length} segs, ${kept.length} kept)`)
        this.emit('transcript', text, shouldFinalize)
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // Timeouts are logged; explicit cancels are silent (engine state already reset).
        if (err instanceof Error && err.name === 'TimeoutError') {
          console.warn(`[whisper-server] /inference timed out after ${this.inferenceTimeoutMs}ms; dropping segment`)
        }
      } else {
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      clearTimeout(timer)
      // A cancelled/stale transcribe must not clobber a newer session's busy state.
      if (this.abortController === controller) {
        this.abortController = null
        this.busy = false
        this.flushPending(isFinal || this.finalizePending)
      }
    }
  }

  private pcmToWav(pcm: Buffer): Buffer {
    const sampleRate = 16000
    const bitsPerSample = 16
    const channels = 1
    const dataSize = pcm.length
    const headerSize = 44
    const totalSize = headerSize + dataSize

    const wav = Buffer.alloc(totalSize)
    let offset = 0

    wav.write('RIFF', offset); offset += 4
    wav.writeUInt32LE(totalSize - 8, offset); offset += 4
    wav.write('WAVE', offset); offset += 4
    wav.write('fmt ', offset); offset += 4
    wav.writeUInt32LE(16, offset); offset += 4
    wav.writeUInt16LE(1, offset); offset += 2
    wav.writeUInt16LE(channels, offset); offset += 2
    wav.writeUInt32LE(sampleRate, offset); offset += 4
    wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, offset); offset += 4
    wav.writeUInt16LE(channels * bitsPerSample / 8, offset); offset += 2
    wav.writeUInt16LE(bitsPerSample, offset); offset += 2
    wav.write('data', offset); offset += 4
    wav.writeUInt32LE(dataSize, offset); offset += 4
    pcm.copy(wav, offset)

    return wav
  }
}
