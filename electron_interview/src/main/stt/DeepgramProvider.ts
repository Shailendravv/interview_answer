import WebSocket from 'ws'
import { BaseSTTEngine } from '../../shared/stt/sttProvider'

interface DeepgramConfig {
  apiKey: string
  language?: string
  model?: string
  interimResults?: boolean
}

interface DeepgramMessage {
  type: string
  channel?: {
    alternatives?: { transcript: string; confidence?: number }[]
  }
  is_final?: boolean
}

export class DeepgramProvider extends BaseSTTEngine {
  readonly name = 'deepgram'

  private ws: WebSocket | null = null
  private isRunning = false

  constructor(private config: DeepgramConfig) {
    super()
  }

  async start(): Promise<void> {
    this.isRunning = true

    const params = new URLSearchParams({
      language: this.config.language || 'en',
      model: this.config.model || 'nova-2',
      interim_results: String(this.config.interimResults ?? true),
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1'
    })

    const url = `wss://api.deepgram.com/v1/listen?${params}`

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.config.apiKey}` }
    })

    this.ws.on('open', () => {
      this.emit('ready')
    })

    this.ws.on('message', (data) => {
      try {
        const msg: DeepgramMessage = JSON.parse(data.toString())
        this.handleMessage(msg)
      } catch { /* ignore parse errors */ }
    })

    this.ws.on('error', (err) => {
      this.emit('error', err)
    })

    this.ws.on('close', () => {
      this.ws = null
    })
  }

  stop(): void {
    this.isRunning = false
    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      this.ws.close()
      this.ws = null
    }
  }

  feedAudioChunk(chunk: Buffer): void {
    if (!this.isRunning || !this.ws || this.ws.readyState !== 1) return // OPEN = 1
    this.ws.send(chunk)
  }

  finalize(): void {
    // Streaming engine emits real is_final flags; nothing to flush locally.
  }

  private handleMessage(msg: DeepgramMessage): void {
    if (msg.type === 'Results' && msg.channel?.alternatives?.length) {
      const text = msg.channel.alternatives[0].transcript
      if (text) {
        this.emit('transcript', text, msg.is_final ?? true)
      }
    }
  }
}
