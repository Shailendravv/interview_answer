export function normalizeTranscript(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/[.!?]+(\s|$)/g, '$1')
}

export function isSimilarTranscript(a: string, b: string): boolean {
  const na = normalizeTranscript(a)
  const nb = normalizeTranscript(b)
  if (na === nb) return true

  const aWords = na.split(/\s+/).filter(Boolean)
  const bWords = nb.split(/\s+/).filter(Boolean)
  if (aWords.length === 0 || bWords.length === 0) return na === nb

  const intersection = aWords.filter((w) => bWords.includes(w)).length
  const union = new Set([...aWords, ...bWords]).size
  return intersection / union >= 0.6
}
