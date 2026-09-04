import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipcChannels'
import { latencyTracer } from '../telemetry/LatencyTracer'

const FLUSH_INTERVAL_MS = 50
// Characters, not array entries. The sanitizer used to hand this whole lines,
// so a 10-entry threshold meant 10 lines and the size trigger never fired --
// every flush waited out the timer, including the first one.
const BATCH_CHARS = 80

// Buffers answer tokens for the active generation only. Tokens from a stale
// (cancelled) generation are dropped so a superseded answer can never bleed
// into the next question's display.
export class TokenBatcher {
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeGeneration = 0
  private firstFlushGenId = 0

  constructor(private window: BrowserWindow | null = null) {}

  setWindow(win: BrowserWindow | null): void {
    this.window = win
  }

  setActive(genId: number): void {
    this.activeGeneration = genId
    this.clear()
  }

  isActive(genId: number): boolean {
    return genId === this.activeGeneration
  }

  push(token: string, genId: number): void {
    if (genId !== this.activeGeneration) return
    this.buffer.push(token)
    // The first payload of a generation goes out immediately: that flush is
    // the first visible word, and making it wait for the timer put up to 50ms
    // in front of every answer.
    if (this.firstFlushGenId !== genId || this.bufferedChars() >= BATCH_CHARS) {
      this.flush(genId)
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flush(genId)
      }, FLUSH_INTERVAL_MS)
    }
  }

  flush(genId: number): void {
    if (genId !== this.activeGeneration) return
    if (this.buffer.length === 0 || !this.window) return
    const batch = this.buffer.join('')
    this.buffer = []
    this.window.webContents.send(IPC.ANSWER_TOKEN, batch)
    if (this.firstFlushGenId !== genId) {
      this.firstFlushGenId = genId
      latencyTracer.mark(genId, 'T7')
    }
  }

  private bufferedChars(): number {
    let n = 0
    for (const token of this.buffer) n += token.length
    return n
  }

  clear(): void {
    this.buffer = []
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
