export interface Summary {
  n: number
  min: number
  median: number
  p90: number
  max: number
  mean: number
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function summarize(values: (number | null | undefined)[]): Summary | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const round = (v: number): number => Math.round(v * 10) / 10
  return {
    n: xs.length,
    min: round(sorted[0]),
    median: round(quantile(sorted, 0.5)),
    p90: round(quantile(sorted, 0.9)),
    max: round(sorted[sorted.length - 1]),
    mean: round(xs.reduce((s, v) => s + v, 0) / xs.length)
  }
}

export function rate(hits: number, total: number): string {
  if (total === 0) return 'n/a'
  return `${hits}/${total} (${Math.round((hits / total) * 100)}%)`
}

export function fmt(s: Summary | null, unit = 'ms'): string {
  if (!s) return 'not measured'
  return `median ${s.median}${unit} · p90 ${s.p90}${unit} · min ${s.min} · max ${s.max} (n=${s.n})`
}
