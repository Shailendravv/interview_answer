import { DatabaseService } from '../db/DatabaseService'

const CODE_PATTERN = /[{};\/\/\->]/
const MAX_PROMPT_TOKENS = 2500
const TOKENS_PER_CHAR_PROSE = 0.25
const TOKENS_PER_CHAR_CODE = 0.5
const RECENT_PAIRS = 3
const MAX_HISTORY_ANSWER_CHARS = 400
// Older history is summarised as the list of questions already asked, built
// here instead of by the local model. The 1.5B summariser returned chat
// replies ("Great! I'm ready to help with your questions."), a lone "```", or
// verbatim copies of past answers cut off at its 150-token cap -- each of the
// last six stored summaries. Injected into the system prompt, such a summary
// was echoed back as the answer ("Sure, here's the updated summary...").
const EARLIER_QUESTIONS = 8
const EARLIER_QUESTION_CHARS = 120

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
  /** Questions that aged out of the recent window, oldest first. */
  private earlierQuestions: string[] = []

  constructor(private db: DatabaseService) {}

  async startNewInterview(title = ''): Promise<number> {
    this.interviewId = this.db.createInterview(title)
    this.recentPairs = []
    this.earlierQuestions = []
    return this.interviewId
  }

  async addInteraction(question: string, answer: string): Promise<void> {
    if (!this.interviewId) return

    this.db.addMessage(this.interviewId, 'user', question, this.estimateTokens(question))
    this.db.addMessage(this.interviewId, 'assistant', answer, this.estimateTokens(answer))

    this.recentPairs.push({ question, answer })
    if (this.recentPairs.length > RECENT_PAIRS) {
      const q = this.recentPairs.shift()!.question.trim()
      this.earlierQuestions.push(q.length > EARLIER_QUESTION_CHARS ? `${q.slice(0, EARLIER_QUESTION_CHARS)}…` : q)
      if (this.earlierQuestions.length > EARLIER_QUESTIONS) this.earlierQuestions.shift()
    }
  }

  async buildPrompt(
    query: string,
    retrievedContext: string[]
  ): Promise<BuiltPrompt> {
    const summaryBlock = this.earlierQuestions.length > 0
      ? '[CONVERSATION HISTORY SUMMARY - for context only, do NOT repeat or use as the answer]\n' +
        `Earlier questions, already answered: ${this.earlierQuestions.join(' | ')}`
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

  private estimateTokens(text: string): number {
    const rate = CODE_PATTERN.test(text) ? TOKENS_PER_CHAR_CODE : TOKENS_PER_CHAR_PROSE
    return Math.ceil(text.length * rate)
  }

  getInterviewId(): number | null {
    return this.interviewId
  }
}
