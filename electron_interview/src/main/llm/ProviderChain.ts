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

/** Combine only EXTERNAL cancel signals; stall protection lives in providers. */
function combineExternal(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (a?.aborted) controller.abort(a.reason)
  else a?.addEventListener('abort', () => controller.abort(a.reason), { once: true })
  if (b.aborted) controller.abort(b.reason)
  else b.addEventListener('abort', () => controller.abort(b.reason), { once: true })
  return controller.signal
}

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
    let lastError: Error | null = null
    const available = this.providers.filter((e) => !e.circuitBreaker.isOpen())

    if (available.length === 0) {
      throw new Error('All providers in chain are open')
    }

    if (available.length === 1) {
      const entry = available[0]
      try {
        return yield* this.runSingle(entry, req)
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.cause === 'aborted')) {
          throw err
        }
        throw err instanceof Error ? err : new Error(String(err))
      }
    }

    const result = yield* this.runParallel(available, req)
    return result
  }

  private async *runSingle(
    entry: ProviderEntry,
    req: GenerationRequest
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
        yield token
      }
      entry.circuitBreaker.recordSuccess()
      return { text: fullText, provider: entry.provider.name, model: req.model }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.cause === 'aborted')) {
        throw err
      }
      entry.circuitBreaker.recordFailure()
      this.emit('warning', `${entry.provider.name} failed: ${describeError(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private async *runParallel(
    providers: ProviderEntry[],
    req: GenerationRequest
  ): AsyncGenerator<string, GenerationResponse, void> {
    const controllers = providers.map(() => new AbortController())

    const runners = providers.map((entry, idx) => ({
      entry,
      controller: controllers[idx],
      iterator: entry.provider.generate({
        ...req,
        signal: combineExternal(req.signal, controllers[idx].signal),
        timeouts: { connectMs: entry.connectMs, idleMs: entry.idleMs }
      })[Symbol.asyncIterator]()
    }))

    const firstTokenPromises = runners.map((r, idx) =>
      r.iterator.next().then((res) => ({ idx, res }))
    )

    let firstResult: { idx: number; res: IteratorResult<string, GenerationResponse> }
    try {
      firstResult = await Promise.race(firstTokenPromises)
    } catch {
      for (const c of controllers) c.abort()
      throw new Error('All providers failed before producing a token')
    }

    const winnerIdx = firstResult.idx

    for (let i = 0; i < runners.length; i++) {
      if (i !== winnerIdx) controllers[i].abort()
    }

    const winner = runners[winnerIdx]
    let fullText = ''

    try {
      if (!firstResult.res.done) {
        const token = firstResult.res.value as string
        fullText += token
        yield token
      }

      while (true) {
        const { done, value } = await winner.iterator.next()
        if (done) {
          const result = value as GenerationResponse
          winner.entry.circuitBreaker.recordSuccess()
          return result
        }
        fullText += value
        yield value
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.cause === 'aborted')) {
        throw err
      }
      winner.entry.circuitBreaker.recordFailure()
      this.emit('warning', `${winner.entry.provider.name} failed: ${describeError(err)}`)
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
