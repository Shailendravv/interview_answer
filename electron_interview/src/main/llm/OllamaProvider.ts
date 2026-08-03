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
    const prompt = req.messages.map((m) => `${m.role}: ${m.content}`).join('\n')

    const response = await this.ollama.generate(this.modelName, prompt, true, req.signal)

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
            const token = parsed.response || ''
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
          const token = parsed.response || ''
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
}
