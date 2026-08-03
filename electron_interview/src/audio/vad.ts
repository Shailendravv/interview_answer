export interface VADConfig {
  sampleRate: number
  frameSize: number
  speechThreshold: number
  silenceThreshold: number
  minSpeechFrames: number
  padFrames: number
  maxSegmentFrames: number
}

export const DEFAULT_VAD_CONFIG: VADConfig = {
  sampleRate: 16000,
  frameSize: 512,
  speechThreshold: 0.02,
  silenceThreshold: 0.01,
  minSpeechFrames: 3,
  padFrames: 10,
  maxSegmentFrames: 250
}

export enum VADState {
  Silence,
  Speech,
  Padding
}

export class VADProcessor {
  private state: VADState = VADState.Silence
  private speechFrames = 0
  private silenceFrames = 0
  private padFrames = 0
  private buffer: Int16Array[] = []
  private speechSegments: Int16Array[] = []

  constructor(private config: VADConfig = DEFAULT_VAD_CONFIG) {}

  processFrame(frame: Int16Array): Int16Array[] {
    const rms = this.calculateRMS(frame)
    const completed: Int16Array[] = []

    switch (this.state) {
      case VADState.Silence:
        if (rms >= this.config.speechThreshold) {
          this.speechFrames++
          if (this.speechFrames >= this.config.minSpeechFrames) {
            this.state = VADState.Speech
            this.buffer = []
            this.padFrames = this.config.padFrames
          }
        } else {
          this.speechFrames = 0
        }
        break

      case VADState.Speech:
        this.buffer.push(frame)
        this.padFrames = this.config.padFrames

        // Hard cap on continuous speech: split long speech into bounded segments
        // so whisper never has to decode an overly long audio chunk.
        if (this.config.maxSegmentFrames > 0 && this.buffer.length >= this.config.maxSegmentFrames) {
          completed.push(...this.flushSegment())
          this.state = VADState.Speech
          this.silenceFrames = 0
          this.padFrames = this.config.padFrames
          break
        }

        if (rms < this.config.silenceThreshold) {
          this.silenceFrames++
          if (this.silenceFrames >= this.config.padFrames) {
            completed.push(...this.flushSegment())
            this.state = VADState.Silence
            this.silenceFrames = 0
          }
        } else {
          this.silenceFrames = 0
        }
        break
    }

    return completed
  }

  private flushSegment(): Int16Array[] {
    const result = this.buffer.length > 0 ? [this.concatBuffers(this.buffer)] : []
    this.buffer = []
    this.speechFrames = 0
    this.padFrames = 0
    return result
  }

  private calculateRMS(frame: Int16Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i]
    }
    return Math.sqrt(sum / frame.length) / 32768
  }

  private concatBuffers(buffers: Int16Array[]): Int16Array {
    const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0)
    const result = new Int16Array(totalLength)
    let offset = 0
    for (const buf of buffers) {
      result.set(buf, offset)
      offset += buf.length
    }
    return result
  }

  reset(): void {
    this.state = VADState.Silence
    this.speechFrames = 0
    this.silenceFrames = 0
    this.buffer = []
  }

  flush(): Int16Array[] {
    const segments = this.flushSegment()
    this.reset()
    return segments
  }
}
