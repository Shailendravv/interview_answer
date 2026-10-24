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
    let out = ''
    out += sanitizer.push('Hello wor').join('')
    out += sanitizer.push('ld\nWith').join('')
    out += sanitizer.flush().join('')
    expect(out).toBe('Hello world\nWith')
    // buffer fully drained
    expect(sanitizer.flush()).toEqual([])
  })

  it('streams a line out as it arrives instead of holding it for the newline', () => {
    // Holding whole lines stalled the first visible word for as long as the
    // model took to finish its opening line.
    const sanitizer = new AnswerSanitizer({ refinedQuery: 'what is oops' })
    expect(sanitizer.push('Encapsulation ').join('')).toBe('Encapsulation ')
    expect(sanitizer.push('bundles state').join('')).toBe('bundles state')
    expect(sanitizer.push(' and behaviour.\n').join('')).toBe(' and behaviour.\n')
  })

  it('withholds a partial line that could still become a dropped marker', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    // Still a prefix of "[CURRENT QUESTION ...": emitting now would be a leak.
    expect(sanitizer.push('[CURRENT QUE').join('')).toBe('')
    expect(sanitizer.push('STION - answer ONLY this]\n').join('')).toBe('')
  })

  it('withholds a partial line that could still be a reprint of the question', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: 'what is oops' })
    expect(sanitizer.push('What is ').join('')).toBe('')
    expect(sanitizer.push('oops\n').join('')).toBe('')
  })

  it('releases a line once it diverges from the question text', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: 'what is oops' })
    expect(sanitizer.push('What is ').join('')).toBe('')
    // Longer than the question, so it can no longer be a verbatim reprint.
    expect(sanitizer.push('oops used for?').join('')).toBe('What is oops used for?')
  })

  it('never streams a partial token that could grow into <think>', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    let streamed = sanitizer.push('Answer <').join('')
    expect(streamed).toBe('Answer ')
    streamed += sanitizer.push('think>hidden</think> done\n').join('')
    expect(streamed).toBe('Answer  done\n')
  })

  it('strips a <think> block on a single line', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    const input = '<think>I should reason here.</think>\nNode.js is a runtime.'
    expect(feed(sanitizer, input)).toBe('Node.js is a runtime.')
  })

  it('strips a <think> block split across many lines', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    const input = [
      '<think> Here is a thinking process:',
      'Step one: analyze.',
      'Step two: draft.',
      '</think>',
      '## Answer',
      'Node.js is a runtime.'
    ].join('\n')
    expect(feed(sanitizer, input)).toBe('## Answer\nNode.js is a runtime.')
  })

  it('keeps text after a <think> region closes across tokens', () => {
    const sanitizer = new AnswerSanitizer({ refinedQuery: '' })
    sanitizer.push('<think>reasoning ')
    sanitizer.push('still going</think>\n')
    expect(sanitizer.push('The answer.\n')).toEqual(['The answer.\n'])
  })
})

describe('AnswerSanitizer skipLeadingLine (prefilled heading)', () => {
  const run = (tokens: string[]): string => {
    const s = new AnswerSanitizer({ refinedQuery: 'q', skipLeadingLine: '## Answer\n' })
    const out: string[] = []
    for (const t of tokens) out.push(...s.push(t))
    out.push(...s.flush())
    return out.join('')
  }

  it('drops a repeated prefilled heading even when it arrives in pieces', () => {
    expect(run(['## ', 'Ans', 'wer\n', 'Body text\n'])).toBe('Body text\n')
  })

  it('keeps a first line that only starts like the heading', () => {
    expect(run(['## Answering ', 'this\n', 'x\n'])).toBe('## Answering this\nx\n')
  })

  it('only considers the first non-blank line', () => {
    expect(run(['Intro\n', '## Answer\n', 'x\n'])).toBe('Intro\n## Answer\nx\n')
  })

  it('streams ordinary first lines without waiting for the newline', () => {
    const s = new AnswerSanitizer({ refinedQuery: 'q', skipLeadingLine: '## Answer' })
    expect(s.push('A process owns')).toEqual(['A process owns'])
  })
})
