import { describe, it, expect } from 'vitest'
import { accuracy, leadInKept, matchCommits, normalizeForWer, termRecall } from '../bench/lib/textMetrics'
import { checkAnswer, expectedHeadings, CLARIFY_MESSAGE } from '../bench/lib/answerMetrics'

// The evaluation harness's scoring code: a wrong metric would silently
// mislead every before/after comparison, so it is pinned here.

describe('accuracy (WER/CER)', () => {
  it('is zero for a match that differs only in case and punctuation', () => {
    expect(accuracy('What is Node.js?', 'what is node js').wer).toBe(0)
  })

  it('counts substitutions, deletions and insertions', () => {
    const a = accuracy('implement a function to reverse a list', 'implement the function reverse a linked list')
    expect(a.counts).toEqual({ substitutions: 1, deletions: 1, insertions: 1, refLength: 7 })
    expect(a.wer).toBeCloseTo(3 / 7)
  })

  it('treats an empty hypothesis as all deletions', () => {
    expect(accuracy('what is a closure', '').wer).toBe(1)
  })

  it('normalizes thousands separators', () => {
    expect(normalizeForWer('1,000 elements')).toBe('1000 elements')
  })

  it('keeps Devanagari combining marks inside words', () => {
    expect(normalizeForWer('प्रोसेस और थ्रेड में क्या अंतर है?').split(' ')).toHaveLength(7)
    expect(accuracy('प्रोसेस और थ्रेड', 'प्रोसेस और थ्रेड').wer).toBe(0)
  })

  it('flags a script mismatch instead of pretending WER is meaningful', () => {
    expect(accuracy('प्रोसेस और थ्रेड', 'process aur thread').scriptMismatch).toBe(true)
    expect(accuracy('React mein useEffect', 'React mein useEffect').scriptMismatch).toBe(false)
  })
})

describe('termRecall / leadInKept', () => {
  it('matches multi-word terms as consecutive tokens', () => {
    expect(termRecall(['event loop', 'Node.js'], 'explain the event loop in node js')).toEqual({ found: ['event loop', 'Node.js'], missed: [] })
    expect(termRecall(['event loop'], 'the loop of events').missed).toEqual(['event loop'])
  })

  it('detects a dropped lead-in but tolerates a changed article', () => {
    expect(leadInKept('What is a closure?', 'Is a closure?')).toBe(false)
    expect(leadInKept('Implement a function', 'Implement the function')).toBe(true)
  })
})

describe('matchCommits', () => {
  const refs = ['What is the CAP theorem?', 'What is Kubernetes used for?']

  it('reports one commit covering two questions as covering both', () => {
    const m = matchCommits(refs, ['What is the CAP theorem? What is Kubernetes used for?'])
    expect(m.covering).toEqual([[0], [0]])
    expect(m.coversOthers(0, 0)).toBe(true)
  })

  it('assigns both halves of a split question to that question', () => {
    const m = matchCommits(['What is the difference between a process and a thread?'], ['What is the difference between', 'a process and a thread?'])
    expect(m.assigned[0]).toEqual([0, 1])
  })

  it('does not match different questions that share an opener', () => {
    const m = matchCommits(
      ['What is the difference between a process and a thread?', 'What is the CAP theorem?'],
      ['What is the difference between a process and a thread?', 'What is the CAP theorem?']
    )
    expect(m.covering).toEqual([[0], [1]])
    expect(m.assigned).toEqual([[0], [1]])
  })

  it('leaves unrelated text unassigned', () => {
    expect(matchCommits(refs, ['thanks everyone']).assigned).toEqual([[], []])
  })
})

describe('checkAnswer', () => {
  it('reads mandated headings from the live production template', () => {
    expect(expectedHeadings('general')).toEqual(['Answer', 'Explanation', 'Example', 'Best Practice', 'Common Mistake'])
  })

  it('requires every mandated ## heading in order for strict compliance', () => {
    const ok = '## Answer\nx\n## Explanation\nx\n## Example\nx\n## Best Practice\nx\n## Common Mistake\nx'
    expect(checkAnswer(ok, { category: 'general', question: 'q' }).headingsStrict).toBe(true)
    const bold = '**Answer**: x\n**Explanation**: y'
    const c = checkAnswer(bold, { category: 'general', question: 'q' })
    expect(c.headingsStrict).toBe(false)
    expect(c.headingsLooseFraction).toBeCloseTo(2 / 5)
  })

  it('flags technology absent from the project context and the question', () => {
    const c = checkAnswer('I built it with Kafka and FastAPI.', {
      category: 'project_specific',
      question: 'Explain the architecture',
      projectBlock: 'TECH: FastAPI, Python'
    })
    expect(c.unsupportedTech).toEqual(['Kafka'])
  })

  it('does not count "Java" inside "JavaScript"', () => {
    const c = checkAnswer('Written in JavaScript.', { category: 'project_specific', question: 'q', projectBlock: 'TECH: JavaScript' })
    expect(c.unsupportedTech).toEqual([])
  })

  it('detects first person outside code and the exact clarify message', () => {
    expect(checkAnswer('```\nI = 1\n```\nThe system uses caching.', { category: 'general', question: 'q' }).firstPerson).toBe(false)
    expect(checkAnswer(`  ${CLARIFY_MESSAGE}`, { category: 'project_specific', question: 'q' }).clarifyExact).toBe(true)
  })
})
