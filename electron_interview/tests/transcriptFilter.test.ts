import { describe, it, expect } from 'vitest'
import { cleanTranscript } from '../src/main/stt/transcriptFilter'

describe('cleanTranscript', () => {
  it('keeps a plain question intact', () => {
    expect(cleanTranscript('What is Node.js?')).toBe('What is Node.js?')
    expect(cleanTranscript('What is AI agent?')).toBe('What is AI agent?')
    expect(cleanTranscript('What do you understand by Gen AI?')).toBe(
      'What do you understand by Gen AI?'
    )
  })

  it('returns null for empty / tag-only input', () => {
    expect(cleanTranscript('')).toBeNull()
    expect(cleanTranscript('   ')).toBeNull()
    expect(cleanTranscript('[SOUND EFFECTS]')).toBeNull()
    expect(cleanTranscript('(electronic music)')).toBeNull()
    expect(cleanTranscript('♪')).toBeNull()
    expect(cleanTranscript('[unintelligible] (soft music)')).toBeNull()
  })

  it('strips tags but keeps the surrounding question', () => {
    expect(cleanTranscript('What is Node.js? [SOUND EFFECTS]')).toBe(
      'What is Node.js?'
    )
    expect(cleanTranscript('(music) What is AI agent?')).toBe('What is AI agent?')
  })

  it('drops repetition loops', () => {
    expect(cleanTranscript('What? What? What?')).toBeNull()
    expect(cleanTranscript('What? What? What? What?')).toBeNull()
    expect(cleanTranscript('Node.js, Node.js, Node.js,')).toBeNull()
    expect(cleanTranscript('the the the')).toBeNull()
  })

  it('keeps mild repetition inside real content', () => {
    expect(cleanTranscript('What, what do you mean?')).toBe(
      'What, what do you mean?'
    )
    expect(cleanTranscript('I mean, no, no it is fine')).toBe(
      'I mean, no, no it is fine'
    )
  })
})
