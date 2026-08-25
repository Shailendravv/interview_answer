import { describe, it, expect } from 'vitest'
import { parseSseChunk } from '../src/main/llm/cloud/BaseCloudProvider'

function sse(payload: object | string): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return `data: ${data}\n\n`
}

describe('parseSseChunk', () => {
  it('extracts delta tokens from complete lines', () => {
    const r = parseSseChunk('', sse({ choices: [{ delta: { content: 'Hello' } }] }))
    expect(r.tokens).toEqual(['Hello'])
    expect(r.remainder).toBe('')
    expect(r.done).toBe(false)
  })

  it('buffers partial lines across chunk boundaries instead of dropping them', () => {
    const full = sse({ choices: [{ delta: { content: 'world' } }] })
    // Split mid-JSON, simulating a TCP boundary inside one SSE event
    const cut = full.indexOf('delta')
    const first = parseSseChunk('', full.slice(0, cut))
    expect(first.tokens).toEqual([])

    const second = parseSseChunk(first.remainder, full.slice(cut))
    expect(second.tokens).toEqual(['world'])
  })

  it('handles multiple events in one network chunk', () => {
    const chunk =
      sse({ choices: [{ delta: { content: 'a' } }] }) +
      sse({ choices: [{ delta: { content: 'b' } }] })
    expect(parseSseChunk('', chunk).tokens).toEqual(['a', 'b'])
  })

  it('signals done on [DONE] and ignores trailing events after it', () => {
    const chunk =
      sse({ choices: [{ delta: { content: 'x' } }] }) +
      'data: [DONE]\n\n' +
      sse({ choices: [{ delta: { content: 'late' } }] })
    const r = parseSseChunk('', chunk)
    expect(r.tokens).toEqual(['x'])
    expect(r.done).toBe(true)
  })

  it('skips malformed JSON lines without losing later events', () => {
    const chunk = 'data: {broken json\n\n' + sse({ choices: [{ delta: { content: 'ok' } }] })
    expect(parseSseChunk('', chunk).tokens).toEqual(['ok'])
  })

  it('ignores non-data lines (comments, empty lines)', () => {
    expect(parseSseChunk('', ': keep-alive\n\n\n').tokens).toEqual([])
    expect(parseSseChunk('', ': keep-alive\n\n\n').done).toBe(false)
  })

  it('matches single-read token stream when a long body is split at every position', () => {
    const events = [
      { choices: [{ delta: { content: 'The ' } }] },
      { choices: [{ text: 'quick ' }] },
      { choices: [{ delta: {} }] },
      { choices: [{ delta: { content: 'brown fox' } }] }
    ]
    const whole = events.map(sse).join('')
    let remainder = ''
    const streamed: string[] = []
    for (let i = 0; i < whole.length; i += 7) {
      const r = parseSseChunk(remainder, whole.slice(i, i + 7))
      remainder = r.remainder
      streamed.push(...r.tokens)
    }
    const direct: string[] = []
    for (const e of events) {
      const t = e.choices[0].delta?.content ?? e.choices[0].text ?? ''
      if (t) direct.push(t)
    }
    expect(streamed).toEqual(direct)
  })
})
