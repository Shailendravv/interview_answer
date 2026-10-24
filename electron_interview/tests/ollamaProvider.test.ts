import { describe, it, expect, vi, afterEach } from 'vitest'
import { OllamaService, OLLAMA_NUM_CTX } from '../src/main/llm/OllamaService'
import { OllamaProvider } from '../src/main/llm/OllamaProvider'

/** A chat stream whose chunks the test pushes by hand. */
function controllableStream(signal?: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      signal?.addEventListener('abort', () => c.error(signal.reason))
    }
  })
  const enc = new TextEncoder()
  return {
    body,
    push: (content: string) => controller.enqueue(enc.encode(JSON.stringify({ message: { content }, done: false }) + '\n')),
    end: () => {
      controller.enqueue(enc.encode(JSON.stringify({ message: { content: '' }, done: true }) + '\n'))
      controller.close()
    }
  }
}

const messages = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'q' }
]

async function collect(gen: AsyncGenerator<string, unknown, void>): Promise<string> {
  let out = ''
  for await (const t of gen) out += t
  return out
}

describe('OllamaProvider', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    vi.useRealTimers()
  })

  it('sends maxTokens, temperature and the shared num_ctx to Ollama', async () => {
    let sent: Record<string, unknown> | null = null
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      const s = controllableStream()
      s.push('hi')
      s.end()
      return new Response(s.body, { status: 200 })
    }) as typeof fetch

    const provider = new OllamaProvider(new OllamaService(), 'qwen2.5-coder:1.5b')
    const text = await collect(provider.generate({ model: 'general', messages, maxTokens: 512, temperature: 0.3 }))

    expect(text).toBe('hi')
    expect(sent!.options).toEqual({ num_ctx: OLLAMA_NUM_CTX, num_predict: 512, temperature: 0.3 })
  })

  it('times out a stream that stalls after the first tokens', async () => {
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const s = controllableStream(init?.signal ?? undefined)
      s.push('partial ')
      return new Response(s.body, { status: 200 }) // never ends
    }) as typeof fetch

    const provider = new OllamaProvider(new OllamaService())
    const gen = provider.generate({ model: 'general', messages, timeouts: { connectMs: 1000, idleMs: 150 } })
    const started = Date.now()
    await expect(collect(gen)).rejects.toThrow(/stalled/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('stops reading when the caller aborts mid-stream', async () => {
    const abort = new AbortController()
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const s = controllableStream(init?.signal ?? undefined)
      s.push('first ')
      setTimeout(() => abort.abort(), 20)
      return new Response(s.body, { status: 200 })
    }) as typeof fetch

    const provider = new OllamaProvider(new OllamaService())
    const gen = provider.generate({ model: 'general', messages, signal: abort.signal, timeouts: { connectMs: 1000, idleMs: 5000 } })
    await expect(collect(gen)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
