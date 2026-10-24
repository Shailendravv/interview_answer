import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProviderChain, FallbackEvent } from '../src/main/llm/ProviderChain'
import { LlmProvider, GenerationRequest, GenerationResponse } from '../src/main/llm/LlmProvider'
import { CircuitBreaker } from '../src/main/llm/CircuitBreaker'
import { RateLimitError, parseRetryAfter } from '../src/main/llm/errors'
import { GroqProvider } from '../src/main/llm/cloud/GroqProvider'

class ScriptedProvider extends LlmProvider {
  calls = 0
  constructor(readonly name: string, private next: () => string | Error) {
    super()
  }
  async *generate(req: GenerationRequest): AsyncGenerator<string, GenerationResponse, void> {
    this.calls++
    const out = this.next()
    if (out instanceof Error) throw out
    yield out
    return { text: out, provider: this.name, model: req.model }
  }
  async healthCheck(): Promise<boolean> {
    return true
  }
}

const req: GenerationRequest = { model: 'general', messages: [{ role: 'user', content: 'hi' }], stream: true }

async function collect(chain: ProviderChain): Promise<string> {
  let out = ''
  for await (const token of chain.generate(req)) out += token
  return out
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('parseRetryAfter', () => {
  it('reads delay-seconds, including the decimals Groq sends', () => {
    expect(parseRetryAfter('7')).toBe(7000)
    expect(parseRetryAfter('2.31')).toBe(2310)
  })
  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-10-24T10:00:00Z')
    expect(parseRetryAfter('Sat, 24 Oct 2026 10:00:30 GMT', now)).toBe(30000)
  })
  it('ignores missing or garbage values', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter('-3')).toBeUndefined()
  })
})

describe('CircuitBreaker.openFor', () => {
  it('stays open for exactly the hold, then lets one probe through', () => {
    vi.useFakeTimers()
    const breaker = new CircuitBreaker('groq', 3)
    breaker.openFor(5000)
    expect(breaker.isOpen()).toBe(true)
    expect(breaker.holdRemainingMs()).toBe(5000)
    vi.advanceTimersByTime(4999)
    expect(breaker.isOpen()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.holdRemainingMs()).toBe(0)
  })
})

describe('ProviderChain rate limits', () => {
  it('parks a 429ed primary for its Retry-After and says who answered instead', async () => {
    vi.useFakeTimers()
    let groqReply: string | Error = new RateLimitError('groq rate-limited', 10000)
    const groq = new ScriptedProvider('groq', () => groqReply)
    const ollama = new ScriptedProvider('ollama', () => 'local')
    const chain = new ProviderChain()
    chain.addProvider(groq, 3, 1000, 1000)
    chain.addProvider(ollama, 10, 1000, 1000)
    const events: FallbackEvent[] = []
    chain.on('fallback', (e: FallbackEvent) => events.push(e))

    expect(await collect(chain)).toBe('local')
    expect(groq.calls).toBe(1)

    // Inside the hold: Groq is not called, but the UI still hears about it.
    vi.advanceTimersByTime(4000)
    expect(await collect(chain)).toBe('local')
    expect(groq.calls).toBe(1)
    expect(events.at(-1)).toEqual({ from: 'groq', to: 'ollama', reason: 'rate-limited; retrying in 6s' })

    // Hold over: Groq answers again.
    groqReply = 'cloud'
    vi.advanceTimersByTime(6000)
    expect(await collect(chain)).toBe('cloud')
    expect(groq.calls).toBe(2)
    expect(chain.getStatus()[0].circuitState).toBe('closed')
  })

  it('a rate limit does not count toward the breaker\'s failure trip', async () => {
    vi.useFakeTimers()
    const groq = new ScriptedProvider('groq', () => new RateLimitError('groq rate-limited', 1000))
    const chain = new ProviderChain()
    chain.addProvider(groq, 3, 1000, 1000)
    chain.addProvider(new ScriptedProvider('ollama', () => 'local'), 10, 1000, 1000)
    for (let i = 0; i < 5; i++) {
      expect(await collect(chain)).toBe('local')
      vi.advanceTimersByTime(1000)
    }
    // Probed after every 1s hold: never escalated to the 60s+ breaker backoff.
    expect(groq.calls).toBe(5)
  })

  it('caps an absurd Retry-After at an hour', async () => {
    vi.useFakeTimers()
    const groq = new ScriptedProvider('groq', () => new RateLimitError('daily quota', 86_400_000))
    const chain = new ProviderChain()
    chain.addProvider(groq, 3, 1000, 1000)
    chain.addProvider(new ScriptedProvider('ollama', () => 'local'), 10, 1000, 1000)
    await collect(chain)
    vi.advanceTimersByTime(60 * 60 * 1000)
    await collect(chain)
    expect(groq.calls).toBe(2)
  })
})

describe('GroqProvider 429', () => {
  it('turns a 429 into a RateLimitError carrying Retry-After', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"message":"Rate limit reached on tokens per minute (TPM)"}}', {
        status: 429,
        headers: { 'retry-after': '3' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const groq = new GroqProvider('test-key', 'qwen/qwen3.8-27b')
    const gen = groq.generate(req)
    const err = await gen.next().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfterMs).toBe(3000)
    expect((err as RateLimitError).message).toContain('tokens per minute')
    // Reasoning stays off for Qwen: <think> output would eat the answer budget.
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ model: 'qwen/qwen3.8-27b', reasoning_effort: 'none' })
  })
})
