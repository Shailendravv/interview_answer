import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SentenceDetector } from '../src/main/stt/SentenceDetector'

describe('SentenceDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('completes immediately on final transcripts', () => {
    const detector = new SentenceDetector()
    const onComplete = vi.fn()
    detector.setOnComplete(onComplete)

    const completed = detector.feedChunk('What is Node.js?', true)

    expect(completed).toBe(true)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('What is Node.js?')
  })

  it('completes immediately on ending punctuation', () => {
    const detector = new SentenceDetector()
    const onComplete = vi.fn()
    detector.setOnComplete(onComplete)

    const completed = detector.feedChunk('Hello world.', false)

    expect(completed).toBe(true)
    expect(onComplete).toHaveBeenCalledWith('Hello world.')
  })

  it('defers interim transcripts until the silence timeout', () => {
    const detector = new SentenceDetector(750)
    const onComplete = vi.fn()
    detector.setOnComplete(onComplete)

    const completed = detector.feedChunk('How does', false)

    expect(completed).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()

    vi.advanceTimersByTime(749)
    expect(onComplete).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('How does')
  })

  it('restarts the silence timer and replaces text on a new interim chunk', () => {
    const detector = new SentenceDetector()
    const onComplete = vi.fn()
    detector.setOnComplete(onComplete)

    detector.feedChunk('How does', false)
    vi.advanceTimersByTime(400)
    detector.feedChunk('How does Node', false)

    vi.advanceTimersByTime(749)
    expect(onComplete).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('How does Node')
  })

  it('uses a custom silence timeout', () => {
    const detector = new SentenceDetector(1500)
    const onComplete = vi.fn()
    detector.setOnComplete(onComplete)

    detector.feedChunk('partial text', false)
    vi.advanceTimersByTime(1500)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('flush returns and clears the pending text', () => {
    const detector = new SentenceDetector()
    detector.feedChunk('unfinished', false)

    expect(detector.flush()).toBe('unfinished')
    expect(detector.flush()).toBeNull()
  })

  it('reset clears pending state and pending timers', () => {
    const detector = new SentenceDetector()
    const onComplete = vi.fn()
    detector.setOnComplete(onComplete)

    detector.feedChunk('unfinished', false)
    detector.reset()

    vi.advanceTimersByTime(2000)
    expect(onComplete).not.toHaveBeenCalled()
    expect(detector.flush()).toBeNull()
  })
})
