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
