import { describe, it, expect } from 'vitest'
import { ProviderChain, FallbackEvent } from '../src/main/llm/ProviderChain'
import { LlmProvider, GenerationRequest, GenerationResponse } from '../src/main/llm/LlmProvider'

type Script = { tokens?: string[]; failAfter?: number; error?: Error }

/** Provider that streams `tokens`, optionally throwing after `failAfter` of them. */
class FakeProvider extends LlmProvider {
  calls = 0
  constructor(readonly name: string, private script: Script) {
    super()
  }
  async *generate(req: GenerationRequest): AsyncGenerator<string, GenerationResponse, void> {
    this.calls++
    const tokens = this.script.tokens ?? []
    let text = ''
    for (let i = 0; i < tokens.length; i++) {
      if (this.script.error && this.script.failAfter === i) throw this.script.error
      text += tokens[i]
      yield tokens[i]
    }
    if (this.script.error && (this.script.failAfter ?? 0) >= tokens.length) throw this.script.error
    return { text, provider: this.name, model: req.model }
  }
  async healthCheck(): Promise<boolean> {
    return true
  }
}

const req: GenerationRequest = { model: 'general', messages: [{ role: 'user', content: 'hi' }], stream: true }

async function collect(chain: ProviderChain, r: GenerationRequest = req): Promise<string> {
  let out = ''
  for await (const token of chain.generate(r)) out += token
  return out
}

function chainOf(...providers: FakeProvider[]): { chain: ProviderChain; events: FallbackEvent[] } {
  const chain = new ProviderChain()
  for (const p of providers) chain.addProvider(p, 3, 1000, 1000)
  const events: FallbackEvent[] = []
  chain.on('fallback', (e: FallbackEvent) => events.push(e))
  return { chain, events }
}

describe('ProviderChain sequential fallback', () => {
  it('uses the primary when it succeeds and never touches the fallback', async () => {
    const groq = new FakeProvider('groq', { tokens: ['a', 'b'] })
    const ollama = new FakeProvider('ollama', { tokens: ['x'] })
    const { chain, events } = chainOf(groq, ollama)

    expect(await collect(chain)).toBe('ab')
    expect(ollama.calls).toBe(0)
    expect(events).toEqual([])
  })

  it('falls back to the next provider when the primary fails before its first token', async () => {
    const groq = new FakeProvider('groq', { error: new Error('groq returned 503: overloaded'), failAfter: 0 })
    const ollama = new FakeProvider('ollama', { tokens: ['local', ' answer'] })
    const { chain, events } = chainOf(groq, ollama)

    expect(await collect(chain)).toBe('local answer')
    expect(groq.calls).toBe(1)
    expect(ollama.calls).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ from: 'groq', to: 'ollama' })
    expect(events[0].reason).toContain('503')
  })

  it('does not splice providers when the primary fails mid-stream', async () => {
    const groq = new FakeProvider('groq', { tokens: ['par', 'tial'], failAfter: 1, error: new Error('stream stalled') })
    const ollama = new FakeProvider('ollama', { tokens: ['x'] })
    const { chain, events } = chainOf(groq, ollama)

    let out = ''
    await expect(async () => {
      for await (const token of chain.generate(req)) out += token
    }).rejects.toThrow('stream stalled')
    expect(out).toBe('par')
    expect(ollama.calls).toBe(0)
    expect(events).toEqual([])
  })

  it('rethrows aborts without falling back', async () => {
    const abort = new DOMException('aborted', 'AbortError')
    const groq = new FakeProvider('groq', { error: abort as unknown as Error, failAfter: 0 })
    const ollama = new FakeProvider('ollama', { tokens: ['x'] })
    const { chain } = chainOf(groq, ollama)

    await expect(collect(chain)).rejects.toMatchObject({ name: 'AbortError' })
    expect(ollama.calls).toBe(0)
  })

  it('throws the last error when every provider fails', async () => {
    const groq = new FakeProvider('groq', { error: new Error('groq down'), failAfter: 0 })
    const ollama = new FakeProvider('ollama', { error: new Error('ollama down'), failAfter: 0 })
    const { chain } = chainOf(groq, ollama)

    await expect(collect(chain)).rejects.toThrow('ollama down')
  })

  it('skips a primary whose circuit is open and goes straight to the fallback', async () => {
    const groq = new FakeProvider('groq', { error: new Error('groq down'), failAfter: 0 })
    const ollama = new FakeProvider('ollama', { tokens: ['ok'] })
    const { chain, events } = chainOf(groq, ollama)

    // maxFailures = 3 opens groq's circuit.
    for (let i = 0; i < 3; i++) expect(await collect(chain)).toBe('ok')
    expect(groq.calls).toBe(3)

    expect(await collect(chain)).toBe('ok')
    expect(groq.calls).toBe(3) // not retried while the circuit is open
    expect(events).toHaveLength(3) // no fallback event when the primary is skipped
    expect(chain.getStatus()).toEqual([
      { name: 'groq', circuitState: 'open' },
      { name: 'ollama', circuitState: 'closed' }
    ])
  })

  it('behaves like a single provider when only Ollama is configured', async () => {
    const ollama = new FakeProvider('ollama', { error: new Error('ollama down'), failAfter: 0 })
    const { chain, events } = chainOf(ollama)

    await expect(collect(chain)).rejects.toThrow('ollama down')
    expect(events).toEqual([])
  })
})
