import { describe, it, expect, vi } from 'vitest'
import { createIdleAbortSignal } from '../src/main/llm/idleSignal'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createIdleAbortSignal', () => {
  it('aborts when no progress happens within the connect window', async () => {
    const h = createIdleAbortSignal(40, 1000)
    expect(h.signal.aborted).toBe(false)
    await wait(120)
    expect(h.signal.aborted).toBe(true)
    expect((h.signal.reason as Error)?.name).toBe('TimeoutError')
    h.dispose()
  })

  it('progress() keeps the stream alive past the original deadline', async () => {
    const h = createIdleAbortSignal(60, 60)
    // Drip progress every 25ms for 200ms — 3x longer than either window.
    for (let i = 0; i < 8; i++) {
      await wait(25)
      h.progress()
      if (h.signal.aborted) break
    }
    expect(h.signal.aborted).toBe(false)
    h.dispose()
    await wait(80)
    expect(h.signal.aborted).toBe(false) // disposed timers never fire
  })

  it('aborts after idleTimeoutMs of silence following the last progress()', async () => {
    const h = createIdleAbortSignal(500, 60)
    h.progress() // connected
    await wait(140)
    expect(h.signal.aborted).toBe(true)
    expect((h.signal.reason as Error)?.name).toBe('TimeoutError')
    h.dispose()
  })

  it('external abort wins immediately regardless of timers', async () => {
    const external = new AbortController()
    const h = createIdleAbortSignal(10000, 10000, external.signal)
    external.abort(new Error('user cancelled'))
    expect(h.signal.aborted).toBe(true)
    expect((h.signal.reason as Error)?.message).toBe('user cancelled')
    h.dispose()
  })

  it('dispose() is idempotent and safe without progress', () => {
    const h = createIdleAbortSignal(10000, 10000)
    expect(() => {
      h.dispose()
      h.dispose()
    }).not.toThrow()
    expect(h.signal.aborted).toBe(false)
  })

  it('does not leak timers (fake-timers sanity)', async () => {
    vi.useFakeTimers()
    const h = createIdleAbortSignal(1000, 1000)
    h.dispose()
    vi.advanceTimersByTime(60000)
    expect(h.signal.aborted).toBe(false)
    vi.useRealTimers()
  })
})
