export interface IdleAbortHandle {
  signal: AbortSignal
  /** Call for every received byte-chunk; restarts the idle window. */
  progress: () => void
  dispose: () => void
}

/**
 * Transport-level abort policy for streaming responses:
 * - connectTimeoutMs bounds waiting for the first bytes (headers + start).
 * - idleTimeoutMs bounds silence between chunks, resetting on every progress().
 * Unlike a total-duration timeout, an arbitrarily long stream survives as
 * long as it keeps producing data — but a stalled server is cut off.
 * An optional external signal (user cancel) aborts immediately and its
 * reason is propagated verbatim.
 */
export function createIdleAbortSignal(
  connectTimeoutMs: number,
  idleTimeoutMs: number,
  external?: AbortSignal
): IdleAbortHandle {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const armTimer = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      controller.abort(new DOMException('stream stalled', 'TimeoutError'))
    }, ms)
  }

  const onExternalAbort = (): void => {
    cleanupTimer()
    controller.abort(external?.reason)
  }

  const cleanupTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  armTimer(connectTimeoutMs)
  external?.addEventListener('abort', onExternalAbort, { once: true })

  return {
    signal: controller.signal,
    progress() {
      if (!disposed && !controller.signal.aborted && !external?.aborted) {
        armTimer(idleTimeoutMs)
      }
    },
    dispose() {
      disposed = true
      cleanupTimer()
      external?.removeEventListener('abort', onExternalAbort)
    }
  }
}
