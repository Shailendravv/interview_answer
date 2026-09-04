const CACHE_MAX_ENTRIES = 200

export class EmbeddingService {
  // Embeddings are deterministic for a given (model, text) pair, so exact-text
  // hits (repeat/re-asked questions) can skip the network round trip entirely.
  // Map preserves insertion order, which we use for simple LRU-ish eviction.
  private cache = new Map<string, number[]>()

  constructor(private baseUrl: string) {}

  async embed(text: string): Promise<number[]> {
    const key = text.trim().toLowerCase()
    const cached = this.cache.get(key)
    if (cached) {
      // Refresh recency by moving the entry to the end.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }

    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
      signal: AbortSignal.timeout(30000)
    })

    if (!res.ok) {
      throw new Error(`Embedding failed: ${res.status}`)
    }

    const data = (await res.json()) as { embedding: number[] }

    this.cache.set(key, data.embedding)
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) this.cache.delete(oldestKey)
    }

    return data.embedding
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0

    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }
}
