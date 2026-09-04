export interface VADConfig {
  sampleRate: number
  /**
   * Internal analysis granularity. This is NOT the transport chunk size: the
   * capture layer sends whatever a 4096-sample ScriptProcessor produces
   * (85ms @48kHz, 93ms @44.1kHz, 256ms @16kHz-native), and processChunk
   * re-blocks that stream into fixed frames of this size. Every decision below
   * is therefore made on a real 32ms grid regardless of the sound card.
   */
  analysisFrameSamples: number
  speechThreshold: number
  silenceThreshold: number
  /** Sustained speech required to open a segment. */
  minSpeechMs: number
  /** Audio kept from before the onset, so soft lead-ins are not clipped. */
  preRollMs: number
  /** Silence required to close a segment. Also the trailing pad whisper sees. */
  hangoverMs: number
  /** Hard cap on one segment; 0 disables splitting. */
  maxSegmentMs: number
}

/**
 * A segment longer than whisper's MAX_CHUNK_BYTES (256KB = 8.192s) gets split
 * into serialized head/tail round-trips, which costs more latency than the cap
 * saves. Leave room for pre-roll and one analysis frame on top of the cap.
 */
const MAX_SAFE_SEGMENT_MS = 8100

export const DEFAULT_VAD_CONFIG: VADConfig = {
  sampleRate: 16000,
  analysisFrameSamples: 512,
  speechThreshold: 0.02,
  silenceThreshold: 0.01,
  minSpeechMs: 96,
  preRollMs: 300,
  hangoverMs: 350,
  maxSegmentMs: 8000
}

export type VADSegmentReason = 'silence' | 'cap' | 'flush'

export interface VADSegment {
  data: Int16Array
  durationMs: number
  /**
   * Silence already included at the end of `data`. The orchestrator's T0
   * (end-of-speech) is `now - trailingSilenceMs`, measured rather than guessed:
   * a cap split or a flush has no trailing silence at all.
   */
  trailingSilenceMs: number
  reason: VADSegmentReason
}

export enum VADState {
  Silence,
  Speech
}

export class VADProcessor {
  private config: VADConfig
  private state: VADState = VADState.Silence
  private speechMs = 0
  private silenceMs = 0
  private bufferedMs = 0
  private buffer: Int16Array[] = []
  /** Ring of recent frames while in Silence, so the onset survives. */
  private preRoll: Int16Array[] = []
  /** Samples left over from the last chunk, awaiting a full analysis frame. */
  private carry: Int16Array = new Int16Array(0)
  private onSpeechStart: (() => void) | null = null

  constructor(config: Partial<VADConfig> = {}) {
    this.config = this.normalize({ ...DEFAULT_VAD_CONFIG, ...config })
  }

  setConfig(partial: Partial<VADConfig>): void {
    this.config = this.normalize({ ...this.config, ...partial })
    this.reset()
  }

  /**
   * Fires when speech opens a segment -- well before the transcript exists.
   * Used to warm the cloud provider's TLS connection while the speaker is
   * still talking, so the handshake is not paid on the critical path.
   */
  setOnSpeechStart(cb: (() => void) | null): void {
    this.onSpeechStart = cb
  }

  getConfig(): VADConfig {
    return { ...this.config }
  }

  private normalize(config: VADConfig): VADConfig {
    if (config.maxSegmentMs > MAX_SAFE_SEGMENT_MS) {
      console.warn(
        `[vad] maxSegmentMs=${config.maxSegmentMs} exceeds the ${MAX_SAFE_SEGMENT_MS}ms ` +
          `whisper chunk limit; clamping. Longer segments would be split into ` +
          `serialized inference calls, costing more latency than the cap saves.`
      )
      return { ...config, maxSegmentMs: MAX_SAFE_SEGMENT_MS }
    }
    return config
  }

  private get frameMs(): number {
    return (this.config.analysisFrameSamples / this.config.sampleRate) * 1000
  }

  private get preRollFrames(): number {
    return Math.ceil(this.config.preRollMs / this.frameMs)
  }

  /**
   * Accepts a chunk of any length and re-blocks it into analysis frames. The
   * remainder is carried to the next call, so no sample is dropped or counted
   * twice at a chunk boundary.
   */
  processChunk(chunk: Int16Array): VADSegment[] {
    const frameSize = this.config.analysisFrameSamples
    const completed: VADSegment[] = []

    let pending: Int16Array
    if (this.carry.length === 0) {
      pending = chunk
    } else {
      pending = new Int16Array(this.carry.length + chunk.length)
      pending.set(this.carry, 0)
      pending.set(chunk, this.carry.length)
    }

    let offset = 0
    while (pending.length - offset >= frameSize) {
      completed.push(...this.processFrame(pending.subarray(offset, offset + frameSize)))
      offset += frameSize
    }

    this.carry = pending.slice(offset)
    return completed
  }

  private processFrame(frame: Int16Array): VADSegment[] {
    const rms = this.calculateRMS(frame)
    const completed: VADSegment[] = []

    if (this.state === VADState.Silence) {
      this.pushPreRoll(frame)

      if (rms >= this.config.speechThreshold) {
        this.speechMs += this.frameMs
        if (this.speechMs >= this.config.minSpeechMs) {
          // Seed the segment with the pre-roll so the onset -- and the frames
          // that proved this was speech -- are kept rather than discarded.
          this.state = VADState.Speech
          this.buffer = this.preRoll
          this.bufferedMs = this.buffer.length * this.frameMs
          this.preRoll = []
          this.silenceMs = 0
          this.onSpeechStart?.()
        }
      } else {
        this.speechMs = 0
      }

      return completed
    }

    this.buffer.push(frame)
    this.bufferedMs += this.frameMs

    if (this.config.maxSegmentMs > 0 && this.bufferedMs >= this.config.maxSegmentMs) {
      completed.push(this.flushSegment('cap', 0))
      this.silenceMs = 0
      return completed
    }

    if (rms < this.config.silenceThreshold) {
      this.silenceMs += this.frameMs
      if (this.silenceMs >= this.config.hangoverMs) {
        // The hangover silence is already inside `buffer` (the frame was pushed
        // above), which is also the trailing pad whisper wants.
        completed.push(this.flushSegment('silence', this.config.hangoverMs))
        this.state = VADState.Silence
        this.silenceMs = 0
        this.speechMs = 0
      }
    } else {
      this.silenceMs = 0
    }

    return completed
  }

  private pushPreRoll(frame: Int16Array): void {
    if (this.config.preRollMs <= 0) return
    this.preRoll.push(frame)
    while (this.preRoll.length > this.preRollFrames) {
      this.preRoll.shift()
    }
  }

  private flushSegment(reason: VADSegmentReason, trailingSilenceMs: number): VADSegment {
    const data = this.concatBuffers(this.buffer)
    this.buffer = []
    this.bufferedMs = 0
    return {
      data,
      durationMs: (data.length / this.config.sampleRate) * 1000,
      trailingSilenceMs,
      reason
    }
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
    this.speechMs = 0
    this.silenceMs = 0
    this.bufferedMs = 0
    this.buffer = []
    this.preRoll = []
    this.carry = new Int16Array(0)
  }

  flush(): VADSegment[] {
    const segments = this.buffer.length > 0 ? [this.flushSegment('flush', 0)] : []
    this.reset()
    return segments
  }
}
