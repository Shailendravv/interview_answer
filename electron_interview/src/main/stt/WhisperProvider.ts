import { ChildProcess, spawn } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BaseSTTEngine } from '../../shared/stt/sttProvider'

interface WhisperConfig {
  modelPath: string
  binaryPath: string
  language?: string
  initialPrompt?: string
}

// ~8s of 16kHz mono PCM; whisper degrades on longer chunks, so never transcribe more.
const MAX_CHUNK_BYTES = 256 * 1024

export class WhisperProvider extends BaseSTTEngine {
  readonly name = 'whisper.cpp'

  private process: ChildProcess | null = null
  private buffer: Buffer[] = []
  private pendingBuffer: Buffer[] = []
  private isRunning = false
  private busy = false
  private tempDir: string | null = null
  private lastFlushBytes = 0
  private finalizePending = false

  constructor(private config: WhisperConfig) {
    super()
  }

  async start(): Promise<void> {
    this.buffer = []
    this.pendingBuffer = []
    this.busy = false
    this.finalizePending = false
    this.isRunning = true
    this.tempDir = mkdtempSync(join(tmpdir(), 'whisper-'))
    this.emit('ready')
  }

  stop(): void {
    this.isRunning = false
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
    this.busy = false
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

  cancel(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.busy = false
    this.buffer = []
    this.pendingBuffer = []
    this.finalizePending = false
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
    this.lastFlushBytes = this.buffer.reduce((sum, b) => sum + b.length, 0)

    const all = Buffer.concat(this.buffer)
    this.buffer = []

    if (all.length > MAX_CHUNK_BYTES) {
      // Send only the head of an oversized chunk; the tail stays queued so the
      // next flush/finalize transcribes it (whisper degrades on long audio).
      this.pendingBuffer.unshift(Buffer.from(all.subarray(MAX_CHUNK_BYTES)))
      this.transcribeChunk(Buffer.from(all.subarray(0, MAX_CHUNK_BYTES)), isFinal)
      return
    }

    this.transcribeChunk(all, isFinal)
  }

  private transcribeChunk(pcm16: Buffer, isFinal: boolean): void {
    if (!this.tempDir) return

    const wavPath = join(this.tempDir, `chunk_${Date.now()}.wav`)
    writeFileSync(wavPath, this.pcmToWav(pcm16))
    this.runWhisper(wavPath, isFinal)
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

  private parseTranscript(stdout: string): string {
    // Try JSON output (-oj flag)
    const trimmed = stdout.trim()
    if (trimmed.startsWith('{')) {
      try {
        const result = JSON.parse(trimmed)
        const text = result.text?.trim()
        if (text) return text
      } catch { /* fall through */ }
    }

    // Fallback: take the last non-empty line that isn't a timestamp
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, '').trim()
      if (line && !line.startsWith('[') && !line.startsWith('(') && line.length > 1) {
        return line
      }
    }

    return ''
  }

  private runWhisper(wavPath: string, isFinal: boolean): void {
    const args = [
      '-m', this.config.modelPath,
      '-f', wavPath,
      '-l', this.config.language || 'en',
      '--no-prints',
      '-oj'
    ]
    if (this.config.initialPrompt) {
      args.push('-p', this.config.initialPrompt)
    }
    this.process = spawn(this.config.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    this.process.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    this.process.on('close', (code) => {
      this.process = null

      const shouldFinalize = isFinal || this.finalizePending
      this.finalizePending = false

      if (code === 0 && stdout) {
        const text = this.parseTranscript(stdout)
        if (text) {
          this.emit('transcript', text, shouldFinalize)
        }
      }

      this.busy = false
      this.flushPending(shouldFinalize)
    })

    this.process.on('error', (err) => {
      this.process = null
      this.busy = false
      this.emit('error', err)
    })
  }
}
