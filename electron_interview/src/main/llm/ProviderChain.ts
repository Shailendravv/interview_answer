import { LlmProvider, GenerationRequest, GenerationResponse } from './LlmProvider'
import { CircuitBreaker, CircuitState } from './CircuitBreaker'
import { describeError } from './errors'

export interface ProviderEntry {
  provider: LlmProvider
  circuitBreaker: CircuitBreaker
  connectMs: number
  idleMs: number
}

const STATE_LABELS: Record<CircuitState, string> = {
  [CircuitState.Closed]: 'closed',
  [CircuitState.Open]: 'open',
  [CircuitState.HalfOpen]: 'half-open'
}

export interface FallbackEvent {
  from: string
  to: string
  reason: string
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.cause === 'aborted')
}

/**
 * Ordered providers with sequential fallback: the first provider whose circuit
 * is closed is tried; if it fails BEFORE yielding a token, the next one takes
 * over and a 'fallback' event is emitted. A failure after the first token is
 * surfaced as-is -- splicing a second model's answer onto a half-streamed one
 * would produce a garbled reply.
 */
export class ProviderChain extends LlmProvider {
  readonly name = 'provider-chain'
  private providers: ProviderEntry[] = []

  addProvider(
    provider: LlmProvider,
    maxFailures = 3,
    connectMs = 10000,
    idleMs = 30000
  ): void {
    this.providers.push({
      provider,
      circuitBreaker: new CircuitBreaker(provider.name, maxFailures),
      connectMs,
      idleMs
    })
  }

  async *generate(req: GenerationRequest): AsyncGenerator<string, GenerationResponse, void> {
    // An open circuit (repeated recent failures) skips that provider outright,
    // so an unavailable primary doesn't cost a timeout on every question.
    const available = this.providers.filter((e) => !e.circuitBreaker.isOpen())

    if (available.length === 0) {
      throw new Error('All providers in chain are open')
    }

    let lastError: Error | null = null
    for (let i = 0; i < available.length; i++) {
      const entry = available[i]
      const state = { yielded: false }
      try {
        return yield* this.runSingle(entry, req, state)
      } catch (err) {
        if (isAbort(err)) throw err
        const error = err instanceof Error ? err : new Error(String(err))
        // Mid-stream failure: the user already sees part of this answer.
        if (state.yielded) throw error
        lastError = error
        const next = available[i + 1]
        if (next) {
          this.emit('fallback', {
            from: entry.provider.name,
            to: next.provider.name,
            reason: describeError(error)
          } satisfies FallbackEvent)
        }
      }
    }
    throw lastError ?? new Error('All providers failed')
  }

  private async *runSingle(
    entry: ProviderEntry,
    req: GenerationRequest,
    state: { yielded: boolean }
  ): AsyncGenerator<string, GenerationResponse, void> {
    // Connect/idle windows ride on the request; each provider enforces them
    // around its own transport (a total-duration cap here would truncate
    // long-but-healthy streams).
    const gen = entry.provider.generate({
      ...req,
      timeouts: { connectMs: entry.connectMs, idleMs: entry.idleMs }
    })
    let fullText = ''

    try {
      for await (const token of gen) {
        if (req.signal?.aborted) {
          entry.circuitBreaker.recordSuccess()
          return { text: fullText, provider: entry.provider.name, model: req.model }
        }
        fullText += token
        state.yielded = true
        yield token
      }
      entry.circuitBreaker.recordSuccess()
      return { text: fullText, provider: entry.provider.name, model: req.model }
    } catch (err) {
      if (isAbort(err)) throw err
      entry.circuitBreaker.recordFailure()
      this.emit('warning', `${entry.provider.name} failed: ${describeError(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  async healthCheck(): Promise<boolean> {
    for (const entry of this.providers) {
      if (await entry.provider.healthCheck()) return true
    }
    return false
  }

  getStatus(): { name: string; circuitState: string }[] {
    return this.providers.map((entry) => ({
      name: entry.provider.name,
      circuitState: STATE_LABELS[entry.circuitBreaker.getState()]
    }))
  }

  getProviders(): ProviderEntry[] {
    return this.providers
  }
}
