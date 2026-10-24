import { LlmProvider, GenerationRequest, GenerationResponse } from '../LlmProvider'
import { createIdleAbortSignal } from '../idleSignal'
import { RateLimitError, parseRetryAfter } from '../errors'

const DEFAULT_CONNECT_MS = 10000
const DEFAULT_IDLE_MS = 8000

export interface CloudProviderConfig {
  name: string
  apiKey: string
  baseUrl: string
  model: string
  extraBody?: Record<string, unknown>
}

/**
 * Incremental SSE parser. Network chunks do not align with SSE event
 * boundaries, so an incomplete trailing line must be carried over to the next
 * chunk — splitting on '\n' per-chunk silently dropped tokens that happened to
 * straddle a TCP read.
 */
export function parseSseChunk(
  remainder: string,
  chunk: string
): { tokens: string[]; remainder: string; done: boolean } {
  const tokens: string[] = []
  let done = false

  let buf = remainder + chunk
  let newlineIdx = buf.indexOf('\n')
  while (newlineIdx !== -1 && !done) {
    const line = buf.slice(0, newlineIdx).replace(/\r$/, '')
    buf = buf.slice(newlineIdx + 1)

    if (!line.startsWith('data: ')) {
      newlineIdx = buf.indexOf('\n')
      continue
    }

    const data = line.slice(6).trim()
    if (data === '[DONE]') {
      done = true
      break
    }

    try {
      const parsed = JSON.parse(data)
      const token = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || ''
      if (token) tokens.push(token)
    } catch { /* skip malformed events */ }

    newlineIdx = buf.indexOf('\n')
  }

  return { tokens, remainder: buf, done }
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
      temperature: req.temperature ?? 0.7,
      ...this.config.extraBody
    }

    const connectMs = req.timeouts?.connectMs ?? DEFAULT_CONNECT_MS
    const idleMs = req.timeouts?.idleMs ?? DEFAULT_IDLE_MS
    const idle = createIdleAbortSignal(connectMs, idleMs, req.signal)
    // External cancellation must surface as AbortError, not our TimeoutError.
    if (req.signal?.aborted) {
      idle.dispose()
      throw new DOMException('aborted', 'AbortError')
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: idle.signal
      })
    } catch (err) {
      idle.dispose()
      throw this.classifyStreamError(err, connectMs, idleMs)
    }
    idle.progress() // headers arrived — switch to the idle window

    if (!response.ok) {
      const errText = await response.text()
      idle.dispose()
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
        throw new RateLimitError(
          `${this.config.name} rate-limited (429${retryAfterMs !== undefined ? `, retry in ${Math.ceil(retryAfterMs / 1000)}s` : ''}): ${errText.slice(0, 300)}`,
          retryAfterMs
        )
      }
      throw new Error(`${this.config.name} returned ${response.status}: ${errText}`)
    }

    if (!response.body) {
      idle.dispose()
      throw new Error(`${this.config.name} returned no response body`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let remainder = ''
    let finished = false

    try {
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        idle.progress()

        const parsedChunk = parseSseChunk(remainder, decoder.decode(value, { stream: true }))
        remainder = parsedChunk.remainder
        for (const token of parsedChunk.tokens) {
          fullText += token
          yield token
        }
        if (parsedChunk.done) finished = true
      }
      // Flush any final complete line left without trailing newline.
      if (!finished && remainder.startsWith('data: ')) {
        const data = remainder.slice(6).trim()
        if (data && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data)
            const token = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || ''
            if (token) {
              fullText += token
              yield token
            }
          } catch { /* malformed tail */ }
        }
      }
    } catch (err) {
      throw this.classifyStreamError(err, connectMs, idleMs)
    } finally {
      idle.dispose()
      reader.releaseLock()
    }

    return { text: fullText, provider: this.config.name, model: this.config.model }
  }

  private classifyStreamError(err: unknown, connectMs: number, idleMs: number): Error {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return new Error(
        `${this.config.name} stream stalled (no data within ${connectMs}/${idleMs}ms connect/idle windows)`
      )
    }
    return err instanceof Error ? err : new Error(String(err))
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
