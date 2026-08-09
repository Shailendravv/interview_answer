import { describe, expect, it } from 'vitest'
import { describeError } from '../src/main/llm/errors'

describe('describeError', () => {
  it('returns the message of a plain error', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-error values', () => {
    expect(describeError('oops')).toBe('oops')
    expect(describeError(42)).toBe('42')
  })

  it('unwraps the undici fetch-failure cause chain', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
      code: 'ECONNREFUSED'
    })
    const fetchErr = Object.assign(new TypeError('fetch failed'), { cause })
    const msg = describeError(fetchErr)
    expect(msg).toContain('fetch failed')
    expect(msg).toContain('ECONNREFUSED')
    expect(msg).toContain('127.0.0.1:11434')
  })
})
