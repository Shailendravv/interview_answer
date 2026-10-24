import { describe, it, expect, vi } from 'vitest'
import { ContextService } from '../src/main/context/ContextService'
import type { DatabaseService } from '../src/main/db/DatabaseService'
import type { OllamaProvider } from '../src/main/llm/OllamaProvider'

interface StoredMessage {
  id: number
  role: string
  content: string
  tokenCount: number
}

function makeDb(): DatabaseService {
  const messages: StoredMessage[] = []
  let summary: string | null = null
  let nextId = 1
  return {
    createInterview: vi.fn(() => nextId++),
    addMessage: vi.fn((_id: number, role: string, content: string, tokenCount: number) => {
      messages.push({ id: messages.length, role, content, tokenCount })
    }),
    getSummary: vi.fn(() => summary),
    saveSummary: vi.fn((_id: number, text: string) => {
      summary = text
    }),
    getAllMessages: vi.fn(() => messages)
  } as unknown as DatabaseService
}

function makeSummarizer(): OllamaProvider {
  return {
    generate: vi.fn(async function* () {
      yield 'A concise summary of the interview topics so far.'
    })
  } as unknown as OllamaProvider
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ContextService.buildPrompt', () => {
  it('places the current question as the final user turn and history as alternating turns', async () => {
    const ctx = new ContextService(makeDb(), makeSummarizer())
    await ctx.startNewInterview('test')

    for (let i = 0; i < 3; i++) {
      await ctx.addInteraction(`Question ${i}`, `Answer ${i}`)
    }

    const built = await ctx.buildPrompt('Current question here?', [])

    expect(built.turns[built.turns.length - 1].role).toBe('user')
    expect(built.turns[built.turns.length - 1].content).toContain('Current question here?')
    expect(built.turns[built.turns.length - 1].content).toContain('[CURRENT QUESTION')

    // 3 pairs of history turns + the question turn
    expect(built.turns).toHaveLength(7)
    expect(built.turns.map((t) => t.role)).toEqual([
      'user', 'assistant',
      'user', 'assistant',
      'user', 'assistant',
      'user'
    ])
    expect(built.tokenCount).toBeLessThanOrEqual(2500)
  })

  it('stays within the token budget even with a very long answer', async () => {
    const ctx = new ContextService(makeDb(), makeSummarizer())
    await ctx.startNewInterview('test')

    await ctx.addInteraction('A short question?', 'y'.repeat(5000))

    const built = await ctx.buildPrompt('Next question?', [])
    expect(built.turns[1].content.length).toBeLessThanOrEqual(400 + 1)
    expect(built.tokenCount).toBeLessThanOrEqual(2500)
  })

  it('summarizes older history without dropping the last 3 pairs (summary ∩ pairs = ∅)', async () => {
    const ctx = new ContextService(makeDb(), makeSummarizer())
    await ctx.startNewInterview('test')

    for (let i = 0; i < 5; i++) {
      await ctx.addInteraction(
        `Question ${i}: ` + 'x'.repeat(400),
        `Answer ${i}: ` + 'y'.repeat(1200)
      )
    }

    await flushAsync()
    await flushAsync()

    const built = await ctx.buildPrompt('Current question?', [])

    // Older history is compacted into the summary in systemExtra...
    expect(built.systemExtra).toContain('[CONVERSATION HISTORY SUMMARY')
    expect(built.systemExtra).toContain('summary of the interview')

    // ...while exactly the last 3 pairs remain as concrete alternating turns.
    const historyTurns = built.turns.slice(0, -1)
    expect(historyTurns.map((t) => t.role)).toEqual([
      'user', 'assistant',
      'user', 'assistant',
      'user', 'assistant'
    ])
    expect(historyTurns[0].content).toContain('Question 2:')
    expect(historyTurns[historyTurns.length - 1].content).toContain('Answer 4:')
  })

  it('includes project context blocks in systemExtra', async () => {
    const ctx = new ContextService(makeDb(), makeSummarizer())
    await ctx.startNewInterview('test')
    const built = await ctx.buildPrompt('Tell me about the platform', ['[PROJECT] financial automation block'])
    expect(built.systemExtra).toContain('[PROJECT CONTEXT]')
    expect(built.systemExtra).toContain('financial automation block')
  })
})

describe('ContextService summarization deferral', () => {
  const bigHistory = async (ctx: ContextService): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await ctx.addInteraction(`Question ${i}: ` + 'x'.repeat(400), `Answer ${i}: ` + 'y'.repeat(1200))
    }
  }

  it('postpones summarization while a generation is active, then runs it', async () => {
    vi.useFakeTimers()
    try {
      const summarizer = makeSummarizer()
      const ctx = new ContextService(makeDb(), summarizer)
      await ctx.startNewInterview('test')

      ctx.notifyGenerationStart()
      await bigHistory(ctx)

      // Generation active: no competing local LLM work may start.
      await vi.advanceTimersByTimeAsync(10000)
      expect(summarizer.generate).not.toHaveBeenCalled()

      // After generation ends (+ idle delay), summarization proceeds.
      ctx.notifyGenerationEnd()
      await vi.advanceTimersByTimeAsync(6000)
      expect(summarizer.generate).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out the post-generation idle window even when never notified busy', async () => {
    vi.useFakeTimers()
    try {
      const summarizer = makeSummarizer()
      const ctx = new ContextService(makeDb(), summarizer)
      await ctx.startNewInterview('test')

      ctx.notifyGenerationStart()
      ctx.notifyGenerationEnd() // answer finished just now
      await bigHistory(ctx)

      await vi.advanceTimersByTimeAsync(2000)
      expect(summarizer.generate).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(4000)
      expect(summarizer.generate).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ContextService summarization bounds', () => {
  const pair = async (ctx: ContextService, i: number): Promise<void> => {
    await ctx.addInteraction(`Question ${i}: ` + 'x'.repeat(400), `Answer ${i}: ` + 'y'.repeat(1200))
  }

  it('summarizes once per batch of newly aged messages, not after every answer', async () => {
    const summarizer = makeSummarizer()
    const ctx = new ContextService(makeDb(), summarizer)
    await ctx.startNewInterview('test')

    for (let i = 0; i < 5; i++) await pair(ctx, i)
    await flushAsync()
    const afterFirst = (summarizer.generate as ReturnType<typeof vi.fn>).mock.calls.length
    expect(afterFirst).toBe(1)

    // One more pair ages only 2 messages: not enough to re-summarize.
    await pair(ctx, 5)
    await flushAsync()
    expect((summarizer.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)

    // A second pair makes 4 newly aged messages: summarize again.
    await pair(ctx, 6)
    await flushAsync()
    expect((summarizer.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('feeds only the previous summary plus newly aged messages, capped, with a token limit', async () => {
    const summarizer = makeSummarizer()
    const ctx = new ContextService(makeDb(), summarizer)
    await ctx.startNewInterview('test')
    for (let i = 0; i < 5; i++) await pair(ctx, i)
    await flushAsync()
    await pair(ctx, 5)
    await pair(ctx, 6)
    await flushAsync()

    const calls = (summarizer.generate as ReturnType<typeof vi.fn>).mock.calls
    const second = calls[1][0] as { messages: { content: string }[]; maxTokens: number }
    const prompt = second.messages[0].content
    expect(second.maxTokens).toBe(150)
    expect(prompt).toContain('A concise summary of the interview topics so far.')
    expect(prompt).not.toContain('Question 0:') // already folded into the previous summary
    expect(prompt).toContain('Question 2:')
    expect(prompt.length).toBeLessThan(4000)
  })

  it('cancels an in-flight summary when a new answer starts', async () => {
    let seenSignal: AbortSignal | undefined
    const summarizer = {
      generate: vi.fn(async function* (req: { signal?: AbortSignal }) {
        seenSignal = req.signal
        await new Promise((r) => setTimeout(r, 50))
        if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        yield 'late summary'
      })
    } as unknown as OllamaProvider
    const db = makeDb()
    const ctx = new ContextService(db, summarizer)
    await ctx.startNewInterview('test')
    for (let i = 0; i < 5; i++) await pair(ctx, i)
    await flushAsync()

    ctx.notifyGenerationStart()
    expect(seenSignal?.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(db.saveSummary).not.toHaveBeenCalled()
  })
})
