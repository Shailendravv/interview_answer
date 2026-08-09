export interface AnswerSanitizerOptions {
  refinedQuery: string
}

const HEADER_MARKER = /^\s*\[(RECENT CONVERSATION HISTORY|CURRENT QUESTION|PROJECT CONTEXT|CONVERSATION HISTORY SUMMARY)/
const HISTORY_HEADER = /^\s*\[RECENT CONVERSATION HISTORY/
const PAST_LINE = /^\s*Past [QA]:/i
const MARKDOWN_HEADING = /^\s*#{1,6}\s/

/**
 * Defense-in-depth filter for streamed LLM answers. If a model (typically a
 * small local one) echoes the prompt's instruction markers, the history
 * block ("Past Q:"/"Past A:" lines), or the current question back into its
 * answer, this strips them before they reach the UI. The primary defense is
 * the multi-turn prompt shape (question as the final user turn); this guards
 * the residual risk on the local Ollama path.
 *
 * Streaming-safe: tokens may arrive on arbitrary boundaries, so lines are
 * buffered and only emitted once complete; a partial line carries over
 * across flushes.
 */
export class AnswerSanitizer {
  private buffer = ''
  private historyRegion = false
  private inThink = false
  private readonly refinedQuery: string

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
      for (const kept of this.processLine(line)) out.push(kept + '\n')
      nl = this.buffer.indexOf('\n')
    }
    return out
  }

  flush(): string[] {
    const remaining = this.buffer
    this.buffer = ''
    if (!remaining) return []
    return this.processLine(remaining)
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
