import { LlmProvider, GenerationRequest, GenerationResponse } from './LlmProvider'
import { OllamaService, OllamaStream } from './OllamaService'

export class OllamaProvider extends LlmProvider {
  readonly name = 'ollama'

  constructor(
    private ollama: OllamaService,
    private modelName = 'qwen2.5-coder:1.5b'
  ) {
    super()
  }

  async *generate(req: GenerationRequest): AsyncGenerator<string, GenerationResponse, void> {
    const multiTurn = req.messages.length > 1
    const extractToken = (parsed: { response?: string; message?: { content?: string } }): string =>
      multiTurn ? parsed.message?.content ?? '' : parsed.response ?? ''

    const prompt = req.messages.map((m) => `${m.role}: ${m.content}`).join('\n')

    // maxTokens/temperature used to be dropped here, so Ollama ran with its
    // own defaults (temperature 0.8, no length cap): one measured answer ran
    // 35,800 tokens / 7 minutes while every following question waited.
    const options = { num_predict: req.maxTokens, temperature: req.temperature }

    let stream: OllamaStream
    try {
      stream = multiTurn
        ? await this.ollama.chat(this.modelName, req.messages, true, req.signal, req.timeouts, options)
        : await this.ollama.generate(this.modelName, prompt, true, req.signal, req.timeouts, options)
    } catch (err) {
      throw this.friendlyUnreachableError(err)
    }
    const { response } = stream

    if (!response.ok) {
      let errMsg = `Ollama returned ${response.status}`
      try {
        const errBody = await response.text()
        if (errBody) errMsg += `: ${errBody.slice(0, 500)}`
      } catch { /* ignore */ }
      stream.dispose()
      throw new Error(errMsg)
    }

    if (!response.body) {
      stream.dispose()
      throw new Error('Ollama returned no response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''

    try {
      let remainder = ''
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (err) {
          if (err instanceof DOMException && err.name === 'TimeoutError') {
            throw new Error(`Ollama stream stalled (no data within ${req.timeouts?.idleMs ?? 30000}ms)`)
          }
          throw err
        }
        const { done, value } = chunk
        if (done) break
        stream.progress()

        remainder += decoder.decode(value, { stream: true })
        const lines = remainder.split('\n')
        remainder = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line)
            const token = extractToken(parsed)
            if (token) {
              fullText += token
              yield token
            }
            if (parsed.done) break
          } catch { /* skip kept-alive / empty tokens */ }
        }
      }
      if (remainder.trim()) {
        try {
          const parsed = JSON.parse(remainder)
          const token = extractToken(parsed)
          if (token) fullText += token
        } catch { /* trailing garbage */ }
      }
    } finally {
      stream.dispose()
      reader.releaseLock()
    }

    return { text: fullText, provider: 'ollama', model: this.modelName }
  }

  async healthCheck(): Promise<boolean> {
    return this.ollama.isReady() && this.ollama.isModelLoaded(this.modelName)
  }

  // undici reports an unreachable server as `TypeError: fetch failed` with the
  // real reason (ECONNREFUSED/ENOTFOUND/...) on `err.cause.code`. Translate that
  // into a message the user can act on instead of the bare "fetch failed".
  private friendlyUnreachableError(err: unknown): Error {
    if (err instanceof Error) {
      const outerCode = (err as Error & { code?: unknown }).code
      const causeCode = (err as Error & { cause?: { code?: unknown } }).cause?.code
      const code = typeof outerCode === 'string' ? outerCode : causeCode
      if (typeof code === 'string' && /^(ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|UND_ERR_)/.test(code)) {
        return new Error(
          `Cannot reach Ollama at ${this.ollama.getBaseUrl()} (${code}). ` +
          'Make sure Ollama is installed and running (`ollama serve`).'
        )
      }
    }
    return err instanceof Error ? err : new Error(String(err))
  }
}
