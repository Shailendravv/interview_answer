import Database from 'better-sqlite3'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { DocChunk, DocChunker } from './DocChunker'
import { EmbeddingService } from '../cache/EmbeddingService'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    source_file TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    chunk_vector BLOB,
    token_count INTEGER DEFAULT 0,
    ingested_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_project ON project_docs(project_id);
  CREATE INDEX IF NOT EXISTS idx_docs_source ON project_docs(source_file);
`

const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS project_docs_fts USING fts5(
    chunk_text, project_id,
    content='project_docs',
    content_rowid='id'
  );
`

export class ProjectDocsService {
  private db: Database.Database
  private chunker = new DocChunker()
  private embeddingService: EmbeddingService

  constructor(ollamaBaseUrl: string) {
    const dbPath = join(app.getPath('userData'), 'interview-docs.db')
    this.db = new Database(dbPath)
    this.db.exec(SCHEMA)
    try { this.db.exec(FTS_SCHEMA) } catch { /* FTS5 may not be available */ }
    this.embeddingService = new EmbeddingService(ollamaBaseUrl)
  }

  private vectorIndex = new Map<string, { text: string; vector: Float64Array }[]>()

  async ingestProject(projectId: string, docsDir: string): Promise<number> {
    const files = this.findMarkdownFiles(docsDir)
    let totalChunks = 0

    const insertStmt = this.db.prepare(
      `INSERT INTO project_docs (project_id, source_file, chunk_index, chunk_text, chunk_vector, token_count, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )

    const insertChunk = this.db.transaction(
      (chunks: { stmt: typeof insertStmt; chunk: DocChunk; vector: Buffer }[]) => {
        for (const { stmt, chunk, vector } of chunks) {
          stmt.run(
            chunk.projectId,
            chunk.sourceFile,
            chunk.chunkIndex,
            chunk.text,
            vector,
            chunk.tokenCount,
            Date.now()
          )
        }
      }
    )

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const chunks = this.chunker.chunkMarkdown(content, projectId, file)

      // Batch embed 8 chunks in parallel
      for (let i = 0; i < chunks.length; i += 8) {
        const batch = chunks.slice(i, i + 8)
        const embeddings = await Promise.all(
          batch.map(chunk => this.embeddingService.embed(chunk.text).catch(() => null))
        )

        const dbBatch = []
        for (let j = 0; j < batch.length; j++) {
          const embedding = embeddings[j]
          if (!embedding) continue
          const f64 = new Float64Array(embedding)
          const vectorBuffer = Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength)
          dbBatch.push({ stmt: insertStmt, chunk: batch[j], vector: vectorBuffer })

          // Update in-memory index
          const existing = this.vectorIndex.get(projectId) || []
          existing.push({ text: batch[j].text, vector: f64 })
          this.vectorIndex.set(projectId, existing)
        }

        if (dbBatch.length > 0) {
          insertChunk(dbBatch)
        }
      }

      totalChunks += chunks.length
    }

    this.syncFts(projectId)
    return totalChunks
  }

  searchByProject(projectId: string, limit = 5): { text: string; score: number }[] {
    const rows = this.db
      .prepare('SELECT id, chunk_text FROM project_docs WHERE project_id = ? LIMIT ?')
      .all(projectId, limit) as { id: number; chunk_text: string }[]

    return rows.map((r) => ({ text: r.chunk_text, score: 1 }))
  }

  searchByKeyword(projectId: string, query: string, limit = 5): { text: string; score: number }[] {
    try {
      const ftsQuery = query.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean).join(' OR ')
      if (!ftsQuery) return []

      const rows = this.db
        .prepare(
          `SELECT chunk_text, rank FROM project_docs_fts
           WHERE project_id = ? AND chunk_text MATCH ?
           ORDER BY rank LIMIT ?`
        )
        .all(projectId, ftsQuery, limit) as { chunk_text: string; rank: number }[]

      return rows.map((r) => ({ text: r.chunk_text, score: 1 / (1 + Math.abs(r.rank)) }))
    } catch {
      return []
    }
  }

  async searchSemantic(
    query: string,
    projectId: string,
    limit = 5
  ): Promise<{ text: string; score: number }[]> {
    const queryEmbedding = await this.embeddingService.embed(query)

    const index = this.vectorIndex.get(projectId)
    if (index && index.length > 0) {
      const scored = index
        .map((entry) => ({
          text: entry.text,
          score: this.embeddingService.cosineSimilarity(queryEmbedding, Array.from(entry.vector))
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      return scored
    }

    // Fallback to DB scan when index not built yet
    const rows = this.db
      .prepare('SELECT id, chunk_text, chunk_vector FROM project_docs WHERE project_id = ?')
      .all(projectId) as { id: number; chunk_text: string; chunk_vector: Buffer | null }[]

    const scored = rows
      .filter((r) => r.chunk_vector)
      .map((r) => {
        const storedVector = new Float64Array(
          r.chunk_vector!.buffer,
          r.chunk_vector!.byteOffset,
          r.chunk_vector!.byteLength / 8
        )
        const score = this.embeddingService.cosineSimilarity(
          queryEmbedding,
          Array.from(storedVector)
        )
        return { text: r.chunk_text, score, id: r.id }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored.map(({ text, score }) => ({ text, score }))
  }

  getProjectCount(projectId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM project_docs WHERE project_id = ?')
      .get(projectId) as { count: number }
    return row.count
  }

  private findMarkdownFiles(dir: string): string[] {
    const files: string[] = []
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          files.push(...this.findMarkdownFiles(fullPath))
        } else if (entry.endsWith('.md')) {
          files.push(fullPath)
        }
      }
    } catch { /* ignore missing dirs */ }
    return files
  }

  private syncFts(_projectId: string): void {
    try {
      this.db.exec("INSERT INTO project_docs_fts(project_docs_fts) VALUES('rebuild')")
    } catch { /* FTS5 not available */ }
  }

  close(): void {
    this.db.close()
  }
}
