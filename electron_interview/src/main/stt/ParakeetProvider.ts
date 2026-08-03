import { BaseSTTEngine } from '../../shared/stt/sttProvider'

interface ParakeetConfig {
  serverUrl: string
  modelName?: string
}

export class ParakeetProvider extends BaseSTTEngine {
  readonly name = 'parakeet'

  private isRunning = false
  private buffer: Buffer[] = []

  constructor(private config: ParakeetConfig) {
    super()
  }

  async start(): Promise<void> {
    this.buffer = []
    this.isRunning = true
    this.emit('ready')
  }

  stop(): void {
    this.isRunning = false
    this.buffer = []
  }

  feedAudioChunk(chunk: Buffer): void {
    if (!this.isRunning) return
    this.buffer.push(chunk)

    const totalBytes = this.buffer.reduce((sum, b) => sum + b.length, 0)
    if (totalBytes >= 16000) {
      this.transcribe(false)
    }
  }

  finalize(): void {
    if (!this.isRunning || this.buffer.length === 0) return
    this.transcribe(true)
  }

  private async transcribe(isFinal: boolean): Promise<void> {
    if (this.buffer.length === 0) return

    const audio = Buffer.concat(this.buffer)
    this.buffer = []

    try {
      const response = await fetch(this.config.serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: audio
      })

      if (!response.ok) {
        throw new Error(`Parakeet server returned ${response.status}`)
      }

      const result = (await response.json()) as { text?: string }
      const text = result.text?.trim() || ''
      if (text) {
        this.emit('transcript', text, isFinal)
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }
}
