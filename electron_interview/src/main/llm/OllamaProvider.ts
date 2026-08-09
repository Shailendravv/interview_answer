import { LlmProvider, GenerationRequest, GenerationResponse } from './LlmProvider'
import { OllamaService } from './OllamaService'

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

    let response: Response
    try {
      response = multiTurn
        ? await this.ollama.chat(this.modelName, req.messages, true, req.signal)
        : await this.ollama.generate(this.modelName, prompt, true, req.signal)
    } catch (err) {
      throw this.friendlyUnreachableError(err)
    }

    if (!response.ok) {
      let errMsg = `Ollama returned ${response.status}`
      try {
        const errBody = await response.text()
        if (errBody) errMsg += `: ${errBody.slice(0, 500)}`
      } catch { /* ignore */ }
      throw new Error(errMsg)
    }

    if (!response.body) {
      throw new Error('Ollama returned no response body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''

    try {
      let remainder = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

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
