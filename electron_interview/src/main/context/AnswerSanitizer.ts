export interface AnswerSanitizerOptions {
  refinedQuery: string
}

const HEADER_MARKER = /^\s*\[(RECENT CONVERSATION HISTORY|CURRENT QUESTION|PROJECT CONTEXT|CONVERSATION HISTORY SUMMARY)/
const HISTORY_HEADER = /^\s*\[RECENT CONVERSATION HISTORY/
const PAST_LINE = /^\s*Past [QA]:/i
const MARKDOWN_HEADING = /^\s*#{1,6}\s/

// The literal openings the drop-rules above key on. A partial line that is
// still a prefix of one of these could yet become a dropped line, so it must
// not be streamed out early.
const HEADER_OPENINGS = [
  '[RECENT CONVERSATION HISTORY',
  '[CURRENT QUESTION',
  '[PROJECT CONTEXT',
  '[CONVERSATION HISTORY SUMMARY'
]
const PAST_OPENINGS = ['Past Q:', 'Past A:']
const THINK_OPEN = '<think>'

/** True when either string is a prefix of the other (case-insensitive). */
function overlapsPrefix(partial: string, opening: string): boolean {
  const a = partial.toLowerCase()
  const b = opening.toLowerCase()
  return a.startsWith(b) || b.startsWith(a)
}

/** Length of the trailing run of `text` that could be the start of `sentinel`. */
function danglingSentinelLen(text: string, sentinel: string): number {
  const max = Math.min(text.length, sentinel.length - 1)
  for (let n = max; n > 0; n--) {
    if (text.slice(text.length - n).toLowerCase() === sentinel.slice(0, n).toLowerCase()) {
      return n
    }
  }
  return 0
}

/**
 * Defense-in-depth filter for streamed LLM answers. If a model (typically a
 * small local one) echoes the prompt's instruction markers, the history
 * block ("Past Q:"/"Past A:" lines), or the current question back into its
 * answer, this strips them before they reach the UI. The primary defense is
 * the multi-turn prompt shape (question as the final user turn); this guards
 * the residual risk on the local Ollama path.
 *
 * Streaming-safe, and streams *within* a line. Every drop-rule keys on the
 * start of a line, so once enough of a line has arrived to rule them all out,
 * the rest of that line can be emitted as it arrives instead of being held
 * back until the newline. Holding whole lines was an unbounded stall on the
 * first-visible-word path: a model that opens with a long bullet paid the
 * entire bullet before anything reached the screen.
 */
export class AnswerSanitizer {
  private buffer = ''
  private historyRegion = false
  private inThink = false
  private readonly refinedQuery: string
  /** Characters of the current (incomplete) line already emitted. */
  private emittedOnLine = 0

  constructor(options: AnswerSanitizerOptions) {
    this.refinedQuery = (options?.refinedQuery ?? '').trim().toLowerCase()
  }

  push(token: string): string[] {
    this.buffer += token
    const out: string[] = []

    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      const kept = this.processLine(line)
      if (kept.length > 0) {
        // Only the not-yet-emitted tail of this line is new.
        const remainder = kept[0].slice(this.emittedOnLine)
        out.push(remainder + '\n')
      } else if (this.emittedOnLine > 0) {
        // Defensive: a prefix was already streamed, so the line cannot be
        // retracted. Close it rather than corrupting the output.
        out.push('\n')
      }
      this.emittedOnLine = 0
      nl = this.buffer.indexOf('\n')
    }

    const safe = this.safePrefixLen(this.buffer)
    if (safe > this.emittedOnLine) {
      out.push(this.buffer.slice(this.emittedOnLine, safe))
      this.emittedOnLine = safe
    }

    return out
  }

  flush(): string[] {
    const remaining = this.buffer
    const alreadyEmitted = this.emittedOnLine
    this.buffer = ''
    this.emittedOnLine = 0
    if (!remaining) return []
    const kept = this.processLine(remaining)
    if (kept.length === 0) return []
    const remainder = kept[0].slice(alreadyEmitted)
    return remainder ? [remainder] : []
  }

  /**
   * How much of an incomplete line can be emitted without risking a character
   * that a later drop-rule would have removed. Returns 0 while the line's fate
   * is still undecided.
   */
  private safePrefixLen(line: string): number {
    if (this.inThink) return 0

    // A <think> opening mid-line truncates the line there; text before it is
    // safe, text after it is not.
    const openIdx = line.search(/<think>/i)
    let limit = openIdx === -1 ? line.length : openIdx
    if (openIdx === -1) {
      // Never emit a trailing run that could still grow into "<think>".
      limit -= danglingSentinelLen(line, THINK_OPEN)
    }
    if (limit <= 0) return 0

    if (this.emittedOnLine > 0) return limit // fate already settled for this line

    return this.couldStillDrop(line.slice(0, limit)) ? 0 : limit
  }

  /** Whether a partial line could still match one of the drop-rules. */
  private couldStillDrop(partial: string): boolean {
    const ltrim = partial.replace(/^\s*/, '')
    if (!ltrim) return true

    // A markdown heading is kept unconditionally by processLine.
    if (MARKDOWN_HEADING.test(partial)) return false

    if (HEADER_OPENINGS.some((h) => overlapsPrefix(ltrim, h))) return true

    if (this.historyRegion && PAST_OPENINGS.some((p) => overlapsPrefix(ltrim, p))) {
      return true
    }

    // Could this line still turn out to be a verbatim reprint of the question?
    if (this.refinedQuery) {
      const norm = partial.trim().toLowerCase().replace(/[.!?]+$/g, '')
      if (this.refinedQuery.startsWith(norm)) return true
    }

    return false
  }

  // Reasoning models emit a <think>…</think> block before the answer. It spans
  // arbitrary token boundaries, so track open/close state across calls and drop
  // everything inside (mirrors the local historyRegion handling).
  private stripThink(line: string): string {
    let out = line
    let cleaned = out.replace(/<think>[\s\S]*?<\/think>/gi, '')
    while (cleaned !== out) {
      out = cleaned
      cleaned = out.replace(/<think>[\s\S]*?<\/think>/gi, '')
    }

    if (!this.inThink) {
      const openIdx = out.search(/<think>/i)
      if (openIdx !== -1) {
        this.inThink = true
        out = out.slice(0, openIdx)
      }
    }

    if (this.inThink) {
      const closeIdx = out.search(/<\/think>/i)
      if (closeIdx !== -1) {
        this.inThink = false
        out = out.slice(closeIdx + '</think>'.length)
      } else {
        out = ''
      }
    }

    return out
  }

  private processLine(line: string): string[] {
    const stripped = this.stripThink(line)
    if (!stripped) return []
    line = stripped

    if (this.historyRegion) {
      if (PAST_LINE.test(line)) return []
      if (!line.trim()) return []
      // Exit the drop-region on the first non-history line, then re-evaluate.
      this.historyRegion = false
    }

    if (HEADER_MARKER.test(line)) {
      if (HISTORY_HEADER.test(line)) this.historyRegion = true
      return []
    }

    // Drop a line that merely reprints the current question.
    const trimmed = line.trim()
    if (trimmed && MARKDOWN_HEADING.test(line)) {
      return [line]
    }
    if (
      this.refinedQuery &&
      trimmed &&
      trimmed.toLowerCase().replace(/[.!?]+$/g, '') === this.refinedQuery
    ) {
      return []
    }

    return [line]
  }
}
