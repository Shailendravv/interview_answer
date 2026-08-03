import { OllamaProvider } from '../llm/OllamaProvider'
import { DatabaseService } from '../db/DatabaseService'

const CODE_PATTERN = /[{};\/\/\->]/
const MAX_PROMPT_TOKENS = 2500
const TOKENS_PER_CHAR_PROSE = 0.25
const TOKENS_PER_CHAR_CODE = 0.5
const RECENT_PAIRS = 3
const SUMMARY_TOKEN_TARGET = 150

interface QAPair {
  question: string
  answer: string
}

export class ContextService {
  private interviewId: number | null = null
  private recentPairs: QAPair[] = []
  private summaryCache: string | null = null

  constructor(
    private db: DatabaseService,
    private summarizer: OllamaProvider
  ) {}

  async startNewInterview(title = ''): Promise<number> {
    this.interviewId = this.db.createInterview(title)
    this.recentPairs = []
    this.summaryCache = null
    return this.interviewId
  }

  async addInteraction(question: string, answer: string): Promise<void> {
    if (!this.interviewId) return

    this.db.addMessage(this.interviewId, 'user', question, this.estimateTokens(question))
    this.db.addMessage(this.interviewId, 'assistant', answer, this.estimateTokens(answer))

    this.recentPairs.push({ question, answer })
    if (this.recentPairs.length > RECENT_PAIRS) {
      this.recentPairs.shift()
    }

    const totalTokens = this.getTotalTokens()
    if (totalTokens > MAX_PROMPT_TOKENS * 0.8) {
      this.triggerSummarization()
    }
  }

  async buildPrompt(
    query: string,
    retrievedContext: string[]
  ): Promise<{ prompt: string; tokenCount: number }> {
    const summary = this.summaryCache ?? (this.interviewId ? this.db.getSummary(this.interviewId) : null)

    const summaryBlock = summary
      ? `<summary>\n${summary}\n</summary>\n`
      : ''

    const recentBlock = this.recentPairs
      .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
      .join('\n')

    const contextBlock = retrievedContext.length > 0
      ? `<context>\n${retrievedContext.join('\n---\n')}\n</context>\n`
      : ''

    const sections = [
      { priority: 1, text: summaryBlock },
      { priority: 2, text: recentBlock ? `<recent>\n${recentBlock}\n</recent>\n` : '' },
      { priority: 3, text: contextBlock },
      { priority: 4, text: `<question>\n${query}\n</question>` }
    ].filter(s => s.text)

    let tokenCount = 0
    const selected: string[] = []
    for (const section of sections) {
      const tokens = this.estimateTokens(section.text)
      if (tokenCount + tokens > MAX_PROMPT_TOKENS && selected.length > 0) break
      tokenCount += tokens
      selected.push(section.text)
    }

    const prompt = selected.join('\n')
    return { prompt, tokenCount: this.estimateTokens(prompt) }
  }

  private triggerSummarization(): void {
    if (!this.interviewId) return

    const allMessages = this.db.getAllMessages(this.interviewId)
    const olderMessages = allMessages.slice(0, -(RECENT_PAIRS * 2))

    if (olderMessages.length < 4) return

    const textToSummarize = olderMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')

    ;(async () => {
      try {
        const gen = this.summarizer.generate({
          model: 'qwen2.5-coder:1.5b',
          messages: [{ role: 'user', content: `Summarize this interview conversation concisely in ${SUMMARY_TOKEN_TARGET} tokens or less. Focus on topics covered, technical decisions, and key facts mentioned.\n\n${textToSummarize}` }],
          stream: false,
          maxTokens: SUMMARY_TOKEN_TARGET,
          temperature: 0.3
        })
        let fullText = ''
        for await (const token of gen) {
          fullText += token
        }
        if (fullText && this.interviewId) {
          const trimmed = fullText.trim()
          this.summaryCache = trimmed
          this.db.saveSummary(this.interviewId, trimmed)
        }
      } catch { /* background summarization failed */ }
    })()
  }

  private estimateTokens(text: string): number {
    const rate = CODE_PATTERN.test(text) ? TOKENS_PER_CHAR_CODE : TOKENS_PER_CHAR_PROSE
    return Math.ceil(text.length * rate)
  }

  private getTotalTokens(): number {
    if (!this.interviewId) return 0
    const messages = this.db.getAllMessages(this.interviewId)
    return messages.reduce((sum, m) => sum + m.tokenCount, 0)
  }

  getInterviewId(): number | null {
    return this.interviewId
  }
}
