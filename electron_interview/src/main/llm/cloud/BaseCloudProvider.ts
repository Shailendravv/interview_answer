import { LlmProvider, GenerationRequest, GenerationResponse } from '../LlmProvider'

export interface CloudProviderConfig {
  name: string
  apiKey: string
  baseUrl: string
  model: string
}

export abstract class BaseCloudProvider extends LlmProvider {
  readonly name: string

  constructor(protected config: CloudProviderConfig) {
    super()
    this.name = config.name
  }

  async *generate(req: GenerationRequest): AsyncGenerator<string, GenerationResponse, void> {
    const url = `${this.config.baseUrl}/chat/completions`
    const body = {
      model: this.config.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: req.stream ?? true,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.7
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: req.signal
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`${this.config.name} returned ${response.status}: ${errText}`)
    }

    if (!response.body) {
      throw new Error(`${this.config.name} returned no response body`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter((l) => l.startsWith('data: '))

        for (const line of lines) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') break

          try {
            const parsed = JSON.parse(data)
            const token = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || ''
            if (token) {
              fullText += token
              yield token
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    } finally {
      reader.releaseLock()
    }

    return { text: fullText, provider: this.config.name, model: this.config.model }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }
}
