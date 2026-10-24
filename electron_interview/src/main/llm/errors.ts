const MAX_CAUSE_DEPTH = 5

function errorCode(err: Error): string | undefined {
  const code = (err as Error & { code?: unknown }).code
  return typeof code === 'string' && code ? code : undefined
}

// Node's undici fetch wraps network failures (ECONNREFUSED, ENOTFOUND, ...) in
// `TypeError: fetch failed` and buries the real reason in `err.cause`. This
// unwraps the cause chain so the user sees something actionable instead of a
// bare "fetch failed".
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)

  const messages: string[] = []
  let current: Error | undefined = err
  let depth = 0
  while (current && depth < MAX_CAUSE_DEPTH) {
    const code = errorCode(current)
    const message = current.message || current.name
    messages.push(code ? `[${code}] ${message}` : message)
    current = (current as Error & { cause?: unknown }).cause as Error | undefined
    depth++
  }
  return messages.join(': ')
}

/**
 * The provider refused the request on quota grounds (HTTP 429). Free-tier
 * cloud keys hit this routinely, so it is not a fault: the chain parks the
 * provider for `retryAfterMs` instead of counting it toward the breaker.
 */
export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number | undefined) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/** `Retry-After` is either delay-seconds (Groq sends decimals) or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : undefined
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}
