import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface QAPair {
  id: string
  question: string
  answer: string
  timestamp: number
}

export class HistoryService {
  private sessionFile: string | null = null
  private pairs: QAPair[] = []

  private getSessionsDir(): string {
    const dir = join(app.getPath('userData'), 'sessions')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  startSession(): string {
    const now = new Date()
    const ts =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0')
    const fileName = `history_${ts}.json`
    this.sessionFile = join(this.getSessionsDir(), fileName)
    this.pairs = []
    this.flush()
    console.log(`[history] Session started: ${this.sessionFile}`)
    return this.sessionFile
  }

  append(qa: QAPair): void {
    this.pairs.push(qa)
    this.flush()
  }

  load(): QAPair[] {
    return [...this.pairs]
  }

  isEmpty(): boolean {
    return this.pairs.length === 0
  }

  private flush(): void {
    if (!this.sessionFile) return
    try {
      writeFileSync(this.sessionFile, JSON.stringify(this.pairs, null, 2), 'utf-8')
    } catch (err) {
      console.error('[history] Failed to write session file:', err)
    }
  }
}
