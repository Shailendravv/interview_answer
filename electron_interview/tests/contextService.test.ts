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
