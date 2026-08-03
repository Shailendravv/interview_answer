import { LlmProvider, GenerationRequest, GenerationResponse } from './LlmProvider'
import { CircuitBreaker, CircuitState } from './CircuitBreaker'

export interface ProviderEntry {
  provider: LlmProvider
  circuitBreaker: CircuitBreaker
  timeoutMs: number
}

const STATE_LABELS: Record<CircuitState, string> = {
  [CircuitState.Closed]: 'closed',
  [CircuitState.Open]: 'open',
  [CircuitState.HalfOpen]: 'half-open'
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortController {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal?.aborted) {
      controller.abort(signal.reason)
      return controller
    }
    signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller
}

export class ProviderChain extends LlmProvider {
  readonly name = 'provider-chain'
  private providers: ProviderEntry[] = []

  addProvider(provider: LlmProvider, maxFailures = 3, timeoutMs = 5000): void {
    this.providers.push({
      provider,
      circuitBreaker: new CircuitBreaker(provider.name, maxFailures),
      timeoutMs
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
    const timeoutSignal = AbortSignal.timeout(entry.timeoutMs)
    const combined = combineSignals(req.signal, timeoutSignal)

    const gen = entry.provider.generate({ ...req, signal: combined.signal })
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
        const timedOut = timeoutSignal.aborted && !req.signal?.aborted
        if (timedOut) {
          entry.circuitBreaker.recordFailure()
          this.emit('warning', `${entry.provider.name} timed out after ${entry.timeoutMs}ms`)
          throw new Error(`${entry.provider.name} timed out after ${entry.timeoutMs}ms`)
        }
        throw err
      }
      entry.circuitBreaker.recordFailure()
      this.emit('warning', `${entry.provider.name} failed: ${err instanceof Error ? err.message : String(err)}`)
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
        signal: combineSignals(
          req.signal,
          AbortSignal.timeout(entry.timeoutMs),
          controllers[idx].signal
        ).signal
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
      const errMsg = err instanceof Error ? err.message : String(err)
      this.emit('warning', `${winner.entry.provider.name} failed: ${errMsg}`)
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
