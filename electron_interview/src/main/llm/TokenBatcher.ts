import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipcChannels'

const FLUSH_INTERVAL_MS = 50
const BATCH_SIZE = 10

// Buffers answer tokens for the active generation only. Tokens from a stale
// (cancelled) generation are dropped so a superseded answer can never bleed
// into the next question's display.
export class TokenBatcher {
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeGeneration = 0

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
    if (this.buffer.length >= BATCH_SIZE) {
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
  }

  clear(): void {
    this.buffer = []
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}
