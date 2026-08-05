import { OllamaProvider } from '../llm/OllamaProvider'
import { DatabaseService } from '../db/DatabaseService'

const CODE_PATTERN = /[{};\/\/\->]/
const MAX_PROMPT_TOKENS = 2500
const TOKENS_PER_CHAR_PROSE = 0.25
const TOKENS_PER_CHAR_CODE = 0.5
const RECENT_PAIRS = 3
const SUMMARY_TOKEN_TARGET = 150
const MAX_HISTORY_ANSWER_CHARS = 400

interface QAPair {
  question: string
  answer: string
}

export interface PromptTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface BuiltPrompt {
  systemExtra: string
  turns: PromptTurn[]
  tokenCount: number
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
  ): Promise<BuiltPrompt> {
    const summary = this.summaryCache ?? (this.interviewId ? this.db.getSummary(this.interviewId) : null)

    const summaryBlock = summary
      ? `[CONVERSATION HISTORY SUMMARY - for context only, do NOT repeat or use as the answer]\n${summary}`
      : ''
    const contextBlock = retrievedContext.length > 0
      ? `[PROJECT CONTEXT]\n${retrievedContext.join('\n---\n')}`
      : ''
    const systemExtra = [summaryBlock, contextBlock].filter(Boolean).join('\n')

    // The current question is always the FINAL user turn — the model answers
    // the last turn instead of "continuing" a flattened prompt string, which
    // was the root cause of history/instruction markers leaking into output.
    const questionTurn: PromptTurn = {
      role: 'user',
      content: `[CURRENT QUESTION - answer ONLY this]\n${query}`
    }

    let turns: PromptTurn[] = [questionTurn]
    let tokenCount = this.estimateTokens(questionTurn.content) + this.estimateTokens(systemExtra)

    // Fit recent pairs into the remaining budget as real alternating turns,
    // trimming oldest first. Truncate past answers so a long answer cannot
    // dominate or be echoed back verbatim.
    if (this.recentPairs.length > 0) {
      const pairs = [...this.recentPairs]
      while (pairs.length > 0) {
        const pairsTokens = pairs.reduce(
          (sum, p) =>
            sum +
            this.estimateTokens(p.question) +
            this.estimateTokens(this.truncateAnswer(p.answer)),
          0
        )
        if (tokenCount + pairsTokens <= MAX_PROMPT_TOKENS) {
          const historyTurns: PromptTurn[] = pairs.flatMap((p) => [
            { role: 'user', content: p.question },
            { role: 'assistant', content: this.truncateAnswer(p.answer) }
          ])
          turns = [...historyTurns, questionTurn]
          tokenCount += pairsTokens
          break
        }
        pairs.shift()
      }
    }

    const fullTokenCount =
      this.estimateTokens(systemExtra) +
      turns.reduce((sum, t) => sum + this.estimateTokens(t.content), 0)

    return { systemExtra, turns, tokenCount: fullTokenCount }
  }

  private truncateAnswer(answer: string): string {
    if (answer.length <= MAX_HISTORY_ANSWER_CHARS) return answer
    return `${answer.slice(0, MAX_HISTORY_ANSWER_CHARS)}…`
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
