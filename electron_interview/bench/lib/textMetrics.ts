// Transcript accuracy metrics. Script-agnostic: Devanagari combining marks
// (\p{M}) are kept as part of words, so Hindi references score correctly.

const DEVANAGARI = /[ऀ-ॿ]/
const LATIN = /[A-Za-z]/

export function normalizeForWer(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,000 -> 1000
    .replace(/['’`]/g, '') // react's -> reacts (both sides alike)
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
}

export function tokens(text: string): string[] {
  const n = normalizeForWer(text)
  return n ? n.split(' ') : []
}

export interface EditCounts {
  substitutions: number
  deletions: number
  insertions: number
  refLength: number
}

export function editCounts<T>(ref: T[], hyp: T[]): EditCounts {
  const m = ref.length
  const n = hyp.length
  // dp[i][j] = [cost, S, D, I]
  let prev: [number, number, number, number][] = Array.from({ length: n + 1 }, (_, j) => [j, 0, 0, j])
  for (let i = 1; i <= m; i++) {
    const cur: [number, number, number, number][] = [[i, 0, i, 0]]
    for (let j = 1; j <= n; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        cur[j] = prev[j - 1]
        continue
      }
      const sub = prev[j - 1]
      const del = prev[j]
      const ins = cur[j - 1]
      const best = Math.min(sub[0], del[0], ins[0])
      if (best === sub[0]) cur[j] = [sub[0] + 1, sub[1] + 1, sub[2], sub[3]]
      else if (best === del[0]) cur[j] = [del[0] + 1, del[1], del[2] + 1, del[3]]
      else cur[j] = [ins[0] + 1, ins[1], ins[2], ins[3] + 1]
    }
    prev = cur
  }
  const [, s, d, ins] = prev[n]
  return { substitutions: s, deletions: d, insertions: ins, refLength: m }
}

export interface AccuracyResult {
  wer: number | null
  cer: number | null
  counts: EditCounts
  /** Reference and hypothesis are in different scripts; WER is not meaningful. */
  scriptMismatch: boolean
}

export function accuracy(reference: string, hypothesis: string): AccuracyResult {
  const ref = tokens(reference)
  const hyp = tokens(hypothesis)
  const counts = editCounts(ref, hyp)
  const refChars = [...normalizeForWer(reference).replace(/ /g, '')]
  const hypChars = [...normalizeForWer(hypothesis).replace(/ /g, '')]
  const charCounts = editCounts(refChars, hypChars)
  const refDeva = DEVANAGARI.test(reference)
  const hypDeva = DEVANAGARI.test(hypothesis)
  const scriptMismatch =
    hypothesis.trim().length > 0 &&
    ((refDeva && !hypDeva && !LATIN.test(reference)) || (!refDeva && hypDeva))
  const errs = (c: EditCounts): number => c.substitutions + c.deletions + c.insertions
  return {
    wer: ref.length ? errs(counts) / ref.length : null,
    cer: refChars.length ? errs(charCounts) / refChars.length : null,
    counts,
    scriptMismatch
  }
}

/** Fraction of domain terms whose normalized tokens appear consecutively in the hypothesis. */
export function termRecall(terms: string[], hypothesis: string): { found: string[]; missed: string[] } {
  const hyp = tokens(hypothesis)
  const found: string[] = []
  const missed: string[] = []
  for (const term of terms) {
    const t = tokens(term)
    let hit = false
    for (let i = 0; t.length > 0 && i + t.length <= hyp.length; i++) {
      if (t.every((tok, k) => hyp[i + k] === tok)) {
        hit = true
        break
      }
    }
    ;(hit ? found : missed).push(term)
  }
  return { found, missed }
}

/**
 * Whether the reference's opening word survives near the start of the
 * hypothesis -- the "What is …" lead-in whisper is known to drop. A changed
 * article ("a" -> "the") later in the phrase is a WER matter, not a lost lead-in.
 */
export function leadInKept(reference: string, hypothesis: string): boolean | null {
  const ref = tokens(reference)
  if (ref.length < 2) return null
  return tokens(hypothesis).slice(0, 2).includes(ref[0])
}

const FUNCTION_WORDS = new Set(
  ('what is are the a an of in on for to and or how do does did you your would could can be was were ' +
    'between difference explain tell me about it this that with when why which there')
    .split(' ')
)

/** Tokens minus function words; falls back to all tokens for very short text. */
export function contentTokens(text: string): string[] {
  const all = tokens(text)
  const content = all.filter((t) => !FUNCTION_WORDS.has(t))
  return content.length >= 1 ? content : all
}

/** Fraction of `ref` tokens (as a multiset) present in `hyp`. */
function coverage(ref: string[], hyp: string[]): number {
  if (ref.length === 0) return 0
  const pool = new Map<string, number>()
  for (const t of hyp) pool.set(t, (pool.get(t) ?? 0) + 1)
  let hit = 0
  for (const t of ref) {
    const n = pool.get(t) ?? 0
    if (n > 0) {
      hit++
      pool.set(t, n - 1)
    }
  }
  return hit / ref.length
}

/**
 * assigned[q]: commits whose best-matching question is q (a fragment of q
 * still counts, so a premature split shows as 2+ commits on one question).
 * covering[q]: commits containing at least half of q's words.
 */
export function matchCommits(references: string[], commits: string[]) {
  // Assignment compares all words and keeps the best match, so a content-free
  // fragment ("What is the difference between") still lands on its question.
  // Coverage uses content words only: questions share openers ("what is the
  // …"), which would otherwise make unrelated questions "cover" each other.
  const refsAll = references.map(tokens)
  const refsContent = references.map(contentTokens)
  const assigned: number[][] = references.map(() => [])
  const covering: number[][] = references.map(() => [])
  commits.forEach((commit, ci) => {
    const all = tokens(commit)
    const content = contentTokens(commit)
    // Share of the commit's words that belong to each question.
    const own = refsAll.map((r) => coverage(all, r))
    const best = own.indexOf(Math.max(...own))
    if (best >= 0 && own[best] >= 0.3) assigned[best].push(ci)
    refsContent.forEach((r, qi) => { if (coverage(r, content) >= 0.5) covering[qi].push(ci) })
  })
  return {
    assigned,
    covering,
    coversOthers: (ci: number, qi: number): boolean => covering.some((cs, other) => other !== qi && cs.includes(ci))
  }
}
