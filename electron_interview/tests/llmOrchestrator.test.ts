import { describe, it, expect } from 'vitest'
import { LlmOrchestrator } from '../src/main/llm/LlmOrchestrator'

const names = (o: LlmOrchestrator): string[] =>
  o.getGenerationChain().getStatus().map((s) => s.name)

describe('LlmOrchestrator generation model selection', () => {
  it('defaults to local Ollama only', () => {
    const o = new LlmOrchestrator({ groq: 'key' })
    expect(o.getGenerationModel()).toBe('ollama')
    expect(names(o)).toEqual(['ollama'])
  })

  it('selecting Groq puts Groq first with Ollama as the fallback', () => {
    const o = new LlmOrchestrator({ groq: 'key' })
    o.setGenerationModel('groq')
    expect(o.getGenerationModel()).toBe('groq')
    expect(names(o)).toEqual(['groq', 'ollama'])
  })

  it('switching back to Ollama drops Groq from the chain', () => {
    const o = new LlmOrchestrator({ groq: 'key' })
    o.setGenerationModel('groq')
    o.setGenerationModel('ollama')
    expect(names(o)).toEqual(['ollama'])
  })

  it('ignores a Groq selection when no Groq key is configured', () => {
    const o = new LlmOrchestrator({})
    o.setGenerationModel('groq')
    expect(o.getGenerationModel()).toBe('ollama')
    expect(names(o)).toEqual(['ollama'])
  })

  it('forwards chain fallback events to listeners, including after a model switch', () => {
    const o = new LlmOrchestrator({ groq: 'key' })
    const seen: string[] = []
    o.onFallback((e) => seen.push(`${e.from}->${e.to}`))

    o.setGenerationModel('groq')
    o.getGenerationChain().emit('fallback', { from: 'groq', to: 'ollama', reason: 'x' })
    expect(seen).toEqual(['groq->ollama'])
  })
})
