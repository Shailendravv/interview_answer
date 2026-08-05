import { describe, it, expect } from 'vitest'
import {
  isSimilarTranscript,
  normalizeTranscript
} from '../src/main/orchestrator/transcriptSimilarity'

describe('transcriptSimilarity', () => {
  it('normalizes trailing punctuation and case', () => {
    expect(normalizeTranscript('What is OOPS??')).toBe('what is oops')
    expect(normalizeTranscript('  TELL ME ABOUT IT!  ')).toBe('tell me about it')
  })

  it('returns true for identical transcripts', () => {
    expect(isSimilarTranscript('What is OOPS concept?', 'what is oops concept?')).toBe(true)
  })

  it('returns true for near-duplicate ASR variants above 0.6 Jaccard', () => {
    expect(isSimilarTranscript('What is OOPS concept?', 'What is OOPS concept please?')).toBe(true)
    expect(isSimilarTranscript('Explain OOPS in python', 'Explain OOP in python')).toBe(true)
  })

  it('returns false for genuinely different questions', () => {
    expect(isSimilarTranscript('What is the financial automation platform?', 'Explain the sales dashboard')).toBe(false)
    expect(isSimilarTranscript('tell me about yourself', 'what is a load balancer?')).toBe(false)
  })

  it('handles empty strings without throwing', () => {
    expect(isSimilarTranscript('', '')).toBe(true)
    expect(isSimilarTranscript('what is oops', '')).toBe(false)
  })
})
