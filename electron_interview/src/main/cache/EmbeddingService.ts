export class EmbeddingService {
  constructor(private baseUrl: string) {}

  async embed(text: string): Promise<number[]> {
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
