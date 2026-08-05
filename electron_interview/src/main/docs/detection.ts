export interface DetectionPattern {
  regex: RegExp
  strong: boolean
}

export interface ProjectDetectionEntry {
  project: string
  patterns: DetectionPattern[]
}

export interface ProjectDetectionResult {
  id: string | null
  hits: number
  confident: boolean
  ambiguous: boolean
}

export const GENERIC_TOKEN_STOPLIST = new Set([
  'platform',
  'project',
  'system',
  'data',
  'database',
  'dashboard',
  'model',
  'app',
  'application',
  'automation',
  'tool',
  'service',
  'api',
  'cloud',
  'sales',
  'finance',
  'financial',
  'management',
  'analytics',
  'integration',
  'stack',
  'full',
  'ai',
  'genai',
  'nlp',
  'machine',
  'learning',
  'web',
  'real',
  'time',
  'client',
  'customer',
  'report',
  'reporting',
  'workflow',
  'feature',
  'case',
  'use',
  'new'
])

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function buildDetectionPatterns(sources: {
  id: string
  title: string
  keywords: string[]
}): DetectionPattern[] {
  const patterns: DetectionPattern[] = []
  const seen = new Set<string>()

  const add = (source: string): void => {
    const normalized = normalizeText(source)
    if (!normalized) return

    const phraseKey = `p:${normalized}`
    if (normalized.includes(' ') && !seen.has(phraseKey)) {
      seen.add(phraseKey)
      patterns.push({ regex: new RegExp(`\\b${escapeRegExp(normalized)}\\b`, 'i'), strong: true })
    }

    for (const word of normalized.split(' ')) {
      const key = word.toLowerCase()
      if (seen.has(key) || word.length < 2 || GENERIC_TOKEN_STOPLIST.has(key)) continue
      seen.add(key)
      // A hyphenated compound ("financial-automation", "multi-llm") is a
      // distinctive project token, not generic speech — treat it as strong.
      patterns.push({ regex: new RegExp(`\\b${escapeRegExp(key)}\\b`, 'i'), strong: word.includes('-') })
    }
  }

  add(sources.id)
  add(sources.title)
  for (const keyword of sources.keywords) {
    add(keyword)
  }

  return patterns
}

export function scoreDetection(
  text: string,
  entries: ProjectDetectionEntry[]
): ProjectDetectionResult {
  const normalized = normalizeText(text)
  if (!normalized) return { id: null, hits: 0, confident: false, ambiguous: false }

  const scored: { id: string; hits: number; strong: boolean }[] = []
  for (const entry of entries) {
    let hits = 0
    let strong = false
    for (const pattern of entry.patterns) {
      if (pattern.regex.test(normalized)) {
        hits++
        if (pattern.strong) strong = true
      }
    }
    if (hits > 0) scored.push({ id: entry.project, hits, strong })
  }

  if (scored.length === 0) return { id: null, hits: 0, confident: false, ambiguous: false }

  const maxHits = Math.max(...scored.map((s) => s.hits))
  const top = scored.filter((s) => s.hits === maxHits)

  if (top.length > 1) {
    return { id: null, hits: maxHits, confident: false, ambiguous: true }
  }

  const winner = top[0]
  const confident = winner.strong || winner.hits >= 2
  return { id: winner.id, hits: winner.hits, confident, ambiguous: false }
}
