import { describe, it, expect } from 'vitest'
import { mergeTranscript } from '../src/main/stt/transcriptMerge'

describe('mergeTranscript', () => {
  it('returns the other side when one is empty', () => {
    expect(mergeTranscript('', 'what is node')).toBe('what is node')
    expect(mergeTranscript('what is node', '')).toBe('what is node')
  })

  it('appends disjoint whisper segments', () => {
    // whisper clears its buffer per inference, so the two halves of a question
    // split by a mid-sentence pause arrive as separate, non-overlapping text.
    expect(
      mergeTranscript("What's the difference between React and Vue", 'in terms of state management')
    ).toBe("What's the difference between React and Vue in terms of state management")
  })

  it('does not duplicate cumulative Deepgram interims', () => {
    expect(mergeTranscript('how does', 'how does node')).toBe('how does node')
    expect(mergeTranscript('how does node', 'how does node handle async')).toBe(
      'how does node handle async'
    )
  })

  it('treats a cumulative update as cumulative despite punctuation drift', () => {
    expect(mergeTranscript('how does node', 'How does node handle async?')).toBe(
      'How does node handle async?'
    )
  })

  it('drops words whisper repeats across a segment boundary', () => {
    expect(mergeTranscript('tell me about your project', 'your project architecture')).toBe(
      'tell me about your project architecture'
    )
  })

  it('is idempotent for an identical repeat', () => {
    expect(mergeTranscript('what is oops', 'what is oops')).toBe('what is oops')
  })

  it('normalizes spacing and floating punctuation', () => {
    expect(mergeTranscript('what is node', '?')).toBe('what is node?')
    expect(mergeTranscript('what  is', 'node   js')).toBe('what is node js')
  })

  it('keeps two genuinely different questions in order', () => {
    expect(mergeTranscript('what is a closure', 'explain the event loop')).toBe(
      'what is a closure explain the event loop'
    )
  })
})
