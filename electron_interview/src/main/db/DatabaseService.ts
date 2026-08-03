import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS interviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    title TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    token_count INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (interview_id) REFERENCES interviews(id)
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    last_updated INTEGER NOT NULL,
    FOREIGN KEY (interview_id) REFERENCES interviews(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_interview ON messages(interview_id);
  CREATE INDEX IF NOT EXISTS idx_summaries_interview ON summaries(interview_id);
`

export class DatabaseService {
  private db: Database.Database

  constructor() {
    const dbPath = join(app.getPath('userData'), 'interview-state.db')
    this.db = new Database(dbPath)
    this.db.exec(SCHEMA)
  }

  createInterview(title = ''): number {
    const result = this.db
      .prepare('INSERT INTO interviews (created_at, title) VALUES (?, ?)')
      .run(Date.now(), title)
    return result.lastInsertRowid as number
  }

  addMessage(interviewId: number, role: string, content: string, tokenCount = 0): number {
    const result = this.db
      .prepare(
        'INSERT INTO messages (interview_id, role, content, token_count, timestamp) VALUES (?, ?, ?, ?, ?)'
      )
      .run(interviewId, role, content, tokenCount, Date.now())
    return result.lastInsertRowid as number
  }

  getRecentMessages(interviewId: number, limit = 6): { role: string; content: string }[] {
    const rows = this.db
      .prepare(
        'SELECT role, content FROM messages WHERE interview_id = ? ORDER BY timestamp DESC LIMIT ?'
      )
      .all(interviewId, limit) as { role: string; content: string }[]
    return rows.reverse()
  }

  getAllMessages(interviewId: number): { role: string; content: string; tokenCount: number }[] {
    return this.db
      .prepare(
        'SELECT role, content, token_count as tokenCount FROM messages WHERE interview_id = ? ORDER BY timestamp'
      )
      .all(interviewId) as { role: string; content: string; tokenCount: number }[]
  }

  saveSummary(interviewId: number, summaryText: string): void {
    const existing = this.db
      .prepare('SELECT id FROM summaries WHERE interview_id = ?')
      .get(interviewId) as { id: number } | undefined

    if (existing) {
      this.db
        .prepare('UPDATE summaries SET summary_text = ?, last_updated = ? WHERE interview_id = ?')
        .run(summaryText, Date.now(), interviewId)
    } else {
      this.db
        .prepare('INSERT INTO summaries (interview_id, summary_text, last_updated) VALUES (?, ?, ?)')
        .run(interviewId, summaryText, Date.now())
    }
  }

  getSummary(interviewId: number): string | null {
    const row = this.db
      .prepare('SELECT summary_text FROM summaries WHERE interview_id = ?')
      .get(interviewId) as { summary_text: string } | undefined
    return row?.summary_text || null
  }

  close(): void {
    this.db.close()
  }
}
