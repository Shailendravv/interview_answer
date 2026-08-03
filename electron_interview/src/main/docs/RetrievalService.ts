import { ProjectDocsService } from './ProjectDocsService'

const RRF_K = 60
const TOP_K = 3

interface RankedResult {
  text: string
  score: number
  rank: number
}

export class RetrievalService {
  constructor(private docsService: ProjectDocsService) {}

  async retrieve(
    query: string,
    projectId: string | null
  ): Promise<{ text: string; score: number }[]> {
    if (!projectId) return []

    const [bm25Results, semanticResults] = await Promise.all([
      this.keywordSearch(projectId, query),
      this.semanticSearch(query, projectId)
    ])

    return this.rrfFusion(bm25Results, semanticResults)
  }

  private async keywordSearch(
    projectId: string,
    query: string
  ): Promise<RankedResult[]> {
    const results = this.docsService.searchByKeyword(projectId, query, TOP_K * 2)
    return results.map((r, i) => ({ ...r, rank: i + 1 }))
  }

  private async semanticSearch(
    query: string,
    projectId: string
  ): Promise<RankedResult[]> {
    const results = await this.docsService.searchSemantic(query, projectId, TOP_K * 2)
    return results.map((r, i) => ({ ...r, rank: i + 1 }))
  }

  private rrfFusion(...lists: RankedResult[][]): { text: string; score: number }[] {
    const scores = new Map<string, { text: string; totalScore: number }>()

    for (const list of lists) {
      for (const item of list) {
        const key = item.text.slice(0, 100)
        const existing = scores.get(key)
        const rrfScore = 1 / (RRF_K + item.rank)

        if (existing) {
          existing.totalScore += rrfScore
        } else {
          scores.set(key, { text: item.text, totalScore: rrfScore })
        }
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, TOP_K)
      .map(({ text, totalScore }) => ({ text, score: totalScore }))
  }
}
