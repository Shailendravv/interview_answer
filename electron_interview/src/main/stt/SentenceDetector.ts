const ENDPOINT_PATTERNS = /[.!?]\s*$/

export class SentenceDetector {
  private lastChunkTime = 0
  private pendingText = ''
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private onSentenceComplete: ((text: string) => void) | null = null

  constructor(private silenceTimeoutMs = 750) {}

  setOnComplete(cb: (text: string) => void): void {
    this.onSentenceComplete = cb
  }

  feedChunk(text: string, isFinal: boolean): boolean {
    this.lastChunkTime = Date.now()
    this.pendingText = text
    this.clearSilenceTimer()

    if (isFinal || this.hasEndingPunctuation(text)) {
      this.emitComplete(text)
      this.pendingText = ''
      return true
    }

    this.silenceTimer = setTimeout(() => {
      if (this.pendingText) {
        this.emitComplete(this.pendingText)
        this.pendingText = ''
      }
    }, this.silenceTimeoutMs)

    return false
  }

  flush(): string | null {
    this.clearSilenceTimer()
    if (this.pendingText) {
      const text = this.pendingText
      this.pendingText = ''
      return text
    }
    return null
  }

  private hasEndingPunctuation(text: string): boolean {
    return ENDPOINT_PATTERNS.test(text)
  }

  private emitComplete(text: string): void {
    this.onSentenceComplete?.(text)
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  reset(): void {
    this.clearSilenceTimer()
    this.pendingText = ''
    this.lastChunkTime = 0
  }
}
