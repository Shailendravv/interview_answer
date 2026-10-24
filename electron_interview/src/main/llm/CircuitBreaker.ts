export enum CircuitState {
  Closed,
  Open,
  HalfOpen
}

const BACKOFF_STAGES = [60000, 120000, 240000, 480000, 900000]

export class CircuitBreaker {
  private state: CircuitState = CircuitState.Closed
  private failureCount = 0
  private lastFailureTime = 0
  private backoffIndex = 0
  // Set by openFor(): a hold the provider itself asked for (rate limit),
  // independent of the failure count and backoff stages.
  private holdUntil = 0

  constructor(
    public readonly providerName: string,
    private maxFailures = 3
  ) {}

  private get currentCooldownMs(): number {
    const idx = Math.min(this.backoffIndex, BACKOFF_STAGES.length - 1)
    return BACKOFF_STAGES[idx]
  }

  recordSuccess(): void {
    this.holdUntil = 0
    this.failureCount = 0
    this.backoffIndex = 0
    this.state = CircuitState.Closed
  }

  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.failureCount >= this.maxFailures) {
      this.state = CircuitState.Open
      this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_STAGES.length - 1)
    }
  }

  /** Open for exactly `ms`, then half-open: one request probes the provider. */
  openFor(ms: number): void {
    this.state = CircuitState.Open
    this.lastFailureTime = Date.now()
    this.holdUntil = this.lastFailureTime + ms
  }

  /** Remaining time of an openFor() hold; 0 when not held. */
  holdRemainingMs(): number {
    return Math.max(0, this.holdUntil - Date.now())
  }

  isOpen(): boolean {
    if (this.holdUntil) {
      if (Date.now() < this.holdUntil) return true
      this.holdUntil = 0
      this.state = CircuitState.HalfOpen
      return false
    }
    if (this.state === CircuitState.Open) {
      if (Date.now() - this.lastFailureTime >= this.currentCooldownMs) {
        this.state = CircuitState.HalfOpen
        return false
      }
      return true
    }
    return false
  }

  reset(): void {
    this.holdUntil = 0
    this.state = CircuitState.Closed
    this.failureCount = 0
    this.lastFailureTime = 0
    this.backoffIndex = 0
  }

  getState(): CircuitState {
    return this.state
  }
}
