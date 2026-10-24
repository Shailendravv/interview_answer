import { describe, it, expect, vi } from 'vitest'
import { ContextService } from '../src/main/context/ContextService'
import type { DatabaseService } from '../src/main/db/DatabaseService'

interface StoredMessage {
  id: number
  role: string
  content: string
  tokenCount: number
}

function makeDb(): DatabaseService {
  const messages: StoredMessage[] = []
  let nextId = 1
  return {
    createInterview: vi.fn(() => nextId++),
    addMessage: vi.fn((_id: number, role: string, content: string, tokenCount: number) => {
      messages.push({ id: messages.length, role, content, tokenCount })
    }),
    getSummary: vi.fn(() => null),
    saveSummary: vi.fn(),
    getAllMessages: vi.fn(() => messages)
  } as unknown as DatabaseService
}

describe('ContextService.buildPrompt', () => {
  it('places the current question as the final user turn and history as alternating turns', async () => {
    const ctx = new ContextService(makeDb())
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

  it('keeps past answers whole, never cut with an ellipsis the model would imitate', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('test')
    const answer = '## Answer\n' + 'Node.js runs JavaScript on the server. '.repeat(30)
    await ctx.addInteraction('What is Node.js?', answer)

    const built = await ctx.buildPrompt('What is an AI agent?', [])
    expect(built.turns[1].content).toBe(answer)
    expect(built.turns[1].content.endsWith('…')).toBe(false)
  })

  it('stays within the token budget by dropping the oldest pairs that do not fit', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('test')

    await ctx.addInteraction('An old question?', 'y'.repeat(12000))
    await ctx.addInteraction('A recent question?', 'Short answer.')

    const built = await ctx.buildPrompt('Next question?', [])
    expect(built.turns.map((t) => t.content)).toEqual([
      'A recent question?',
      'Short answer.',
      expect.stringContaining('Next question?')
    ])
    expect(built.tokenCount).toBeLessThanOrEqual(2500)
  })

  it('lists older questions in the summary without dropping the last 3 pairs (summary ∩ pairs = ∅)', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('test')

    for (let i = 0; i < 5; i++) {
      await ctx.addInteraction(
        `Question ${i}: ` + 'x'.repeat(400),
        `Answer ${i}: ` + 'y'.repeat(1200)
      )
    }

    const built = await ctx.buildPrompt('Current question?', [])

    // Older history is compacted into the summary in systemExtra: the
    // questions only, never the answers (which the model would echo back).
    expect(built.systemExtra).toContain('[CONVERSATION HISTORY SUMMARY')
    expect(built.systemExtra).toContain('Earlier questions, already answered: Question 0:')
    expect(built.systemExtra).toContain('| Question 1:')
    expect(built.systemExtra).not.toContain('Answer 0')
    expect(built.systemExtra).not.toContain('Question 2:')

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

  it('has no summary until a question ages out of the recent window', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('test')
    for (let i = 0; i < 3; i++) await ctx.addInteraction(`Question ${i}`, `Answer ${i}`)
    expect((await ctx.buildPrompt('Next?', [])).systemExtra).toBe('')
  })

  it('keeps the 8 most recent earlier questions, each capped at 120 characters', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('test')
    for (let i = 0; i < 14; i++) await ctx.addInteraction(`Q${i} ` + 'z'.repeat(300), `A${i}`)
    const { systemExtra } = await ctx.buildPrompt('Next?', [])
    const listed = systemExtra.split('already answered: ')[1].split(' | ')
    expect(listed).toHaveLength(8)
    expect(listed[0].startsWith('Q3 ')).toBe(true)
    expect(listed.at(-1)!.startsWith('Q10 ')).toBe(true)
    expect(listed.every((q) => q.length <= 121)).toBe(true)
  })

  it('starts a new interview with no earlier questions', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('first')
    for (let i = 0; i < 5; i++) await ctx.addInteraction(`Question ${i}`, `Answer ${i}`)
    await ctx.startNewInterview('second')
    const built = await ctx.buildPrompt('Next?', [])
    expect(built.systemExtra).toBe('')
    expect(built.turns).toHaveLength(1)
  })

  it('includes project context blocks in systemExtra', async () => {
    const ctx = new ContextService(makeDb())
    await ctx.startNewInterview('test')
    const built = await ctx.buildPrompt('Tell me about the platform', ['[PROJECT] financial automation block'])
    expect(built.systemExtra).toContain('[PROJECT CONTEXT]')
    expect(built.systemExtra).toContain('financial automation block')
  })
})
