import { describe, it, expect } from 'vitest'
import { AnswerSanitizer } from '../src/main/context/AnswerSanitizer'

// Streams text through the sanitizer in awkward token boundaries to prove
// line-buffering is safe (S4 scenario: markers echoed by a small local model).
function feed(sanitizer: AnswerSanitizer, text: string): string {
  let out = ''
  const chunks = [text.slice(0, 3), text.slice(3, 11), text.slice(11, 27), text.slice(27)]
  for (const chunk of chunks) {
    if (chunk) out += sanitizer.push(chunk).join('')
  }
  out += sanitizer.flush().join('')
  return out
}

describe('AnswerSanitizer', () => {
  it('strips the history marker header and all Past Q:/Past A: lines that follow', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    const input = [
      '[RECENT CONVERSATION HISTORY]',
      'Past Q: What is the financial automation platform?',
      'Past A: It automates invoice processing for Veolia.',
      '',
      '[PROJECT CONTEXT]',
      'This is the real answer.'
    ].join('\n')

    expect(feed(sanitizer, input)).toBe('This is the real answer.')
  })

  it('strips a [CURRENT QUESTION ...] header line the model echoes back', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: 'what is oops in python' })
    const input = [
      '[CURRENT QUESTION - answer ONLY this]',
      'What is OOPS in python?',
      'OOPS is a programming paradigm...'
    ].join('\n')

    expect(feed(sanitizer, input)).toBe('OOPS is a programming paradigm...')
  })

  it('drops a standalone line that merely reprints the current question', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: 'what is the financial automation platform' })
    const input = [
      'What is the financial automation platform?',
      'It automates invoices for Veolia.'
    ].join('\n')

    expect(feed(sanitizer, input)).toBe('It automates invoices for Veolia.')
  })

  it('keeps a "Past A:" phrase inside prose when it is not a history line', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    expect(feed(sanitizer, 'The dashboard included a Past A: review step.')).toBe(
      'The dashboard included a Past A: review step.'
    )
  })

  it('preserves markdown headings', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: 'what is oops' })
    expect(feed(sanitizer, '### Short Answer\nOOPS is four pillars.')).toBe(
      '### Short Answer\nOOPS is four pillars.'
    )
  })

  it('carries a partial final line across flush', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    sanitizer.push('Hello wor')
    sanitizer.push('ld\nWith')
    expect(sanitizer.flush()).toEqual(['With'])
    // buffer fully drained
    expect(sanitizer.flush()).toEqual([])
  })
})
