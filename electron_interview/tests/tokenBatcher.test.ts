import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import { TokenBatcher } from '../src/main/llm/TokenBatcher'
import { IPC } from '../src/shared/ipcChannels'

function makeWindow(): BrowserWindow {
  return {
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('TokenBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first payload of a generation immediately', () => {
    // This flush is the first visible word. Batching it cost up to 50ms in
    // front of every answer for no bandwidth benefit.
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)

    batcher.push('Encapsulation', 1)

    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.ANSWER_TOKEN, 'Encapsulation')
  })

  it('batches subsequent tokens on the interval timer', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)

    batcher.push('a', 1) // immediate
    vi.mocked(win.webContents.send).mockClear()

    batcher.push('b', 1)
    batcher.push('c', 1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(51)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.ANSWER_TOKEN, 'bc')
  })

  it('flushes early once the buffer passes the character threshold', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)

    batcher.push('x', 1) // immediate first flush
    vi.mocked(win.webContents.send).mockClear()

    // Ten-character tokens: the threshold is characters, not entries, so this
    // trips well before ten pushes.
    for (let i = 0; i < 9; i++) batcher.push('0123456789', 1)

    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(win.webContents.send).mock.calls[0][1] as string
    expect(sent.length).toBeGreaterThanOrEqual(80)
  })

  it('drops tokens from a stale generation', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(2)

    for (let i = 0; i < 10; i++) batcher.push(`x${i}`, 1)

    vi.advanceTimersByTime(60)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('setActive clears the pending buffer and timer', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)
    batcher.push('a', 1) // immediate
    batcher.push('buffered', 1) // held on the timer
    vi.mocked(win.webContents.send).mockClear()

    batcher.setActive(2)
    vi.advanceTimersByTime(60)
    expect(win.webContents.send).not.toHaveBeenCalled()

    batcher.push('b', 2)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.ANSWER_TOKEN, 'b')
  })

  it('flush only sends when the generation is active', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)
    batcher.push('a', 1) // immediate
    batcher.push('held', 1)
    vi.mocked(win.webContents.send).mockClear()

    batcher.setActive(2)
    batcher.flush(1)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
