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

  it('flushes a batch of 10 tokens', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)

    for (let i = 0; i < 10; i++) batcher.push(`t${i}`, 1)

    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC.ANSWER_TOKEN,
      't0t1t2t3t4t5t6t7t8t9'
    )
  })

  it('flushes buffered tokens on the interval timer', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)

    batcher.push('a', 1)
    batcher.push('b', 1)
    expect(win.webContents.send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(51)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.ANSWER_TOKEN, 'ab')
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
    batcher.push('a', 1)

    batcher.setActive(2)
    vi.advanceTimersByTime(60)
    expect(win.webContents.send).not.toHaveBeenCalled()

    batcher.push('b', 2)
    batcher.flush(2)
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.ANSWER_TOKEN, 'b')
  })

  it('flush only sends when the generation is active', () => {
    const win = makeWindow()
    const batcher = new TokenBatcher(win)
    batcher.setActive(1)
    batcher.push('a', 1)

    batcher.setActive(2)
    batcher.flush(1)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
