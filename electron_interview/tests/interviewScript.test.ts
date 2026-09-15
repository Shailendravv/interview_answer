import { describe, it, expect } from 'vitest'
import { buildInterviewScript } from '../src/main/docs/interviewScript'
import type { ProjectConcept } from '../src/main/docs/projectsTypes'

function project(overrides: Partial<ProjectConcept['body']> = {}, top: Partial<ProjectConcept> = {}): ProjectConcept {
  return {
    id: 'p1',
    type: 'Project',
    title: 'Sales Intelligence Platform',
    description: 'AI-powered sales intelligence platform for analyzing customer data.',
    tags: [],
    keywords: [],
    body: {
      role: 'Full Stack Developer',
      duration: '',
      techStack: ['React.js', 'FastAPI', 'OpenAI', 'GCP', 'Pandas', 'MongoDB'],
      architecture: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
      features: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
      challenges: ['c1', 'c2', 'c3', 'c4'],
      accomplishments: ['x1', 'x2', 'x3', 'x4'],
      ...overrides
    },
    ...top
  }
}

const cardIds = (p: ProjectConcept): string[] => buildInterviewScript(p).cards.map((c) => c.id)

describe('buildInterviewScript', () => {
  it('builds the opening from description, role and a capped tech stack', () => {
    const script = buildInterviewScript(project())
    expect(script.pitch).toBe('AI-powered sales intelligence platform for analyzing customer data.')
    expect(script.role).toBe('Full Stack Developer')
    expect(script.duration).toBe('')
    // 6 technologies in, 5 headline ones out
    expect(script.techStack).toEqual(['React.js', 'FastAPI', 'OpenAI', 'GCP', 'Pandas'])
  })

  it('falls back to the title when there is no description', () => {
    expect(buildInterviewScript(project({}, { description: '' })).pitch).toBe('Sales Intelligence Platform')
  })

  it('emits all five cards in speaking order', () => {
    expect(cardIds(project())).toEqual(['how', 'what', 'hard', 'impact', 'followups'])
  })

  it('sends every line but previews only the first few', () => {
    const cards = buildInterviewScript(project()).cards
    const how = cards.find((c) => c.id === 'how')!
    // All 8 architecture lines ship, so "Show all 8" has something to reveal.
    expect(how.lines).toHaveLength(8)
    expect(how.previewCount).toBe(5)
    expect(how.numbered).toBe(true)

    expect(cards.find((c) => c.id === 'what')!.previewCount).toBe(5)
    expect(cards.find((c) => c.id === 'hard')!.previewCount).toBe(3)
    expect(cards.find((c) => c.id === 'impact')!.previewCount).toBe(3)
  })

  it('previews everything when a card is shorter than its cap', () => {
    const how = buildInterviewScript(project({ architecture: ['only one'] })).cards.find((c) => c.id === 'how')!
    expect(how.lines).toHaveLength(1)
    expect(how.lines.length).toBeLessThanOrEqual(how.previewCount)
  })

  it('omits cards whose source list is empty or blank rather than emitting empty ones', () => {
    expect(cardIds(project({ challenges: [], accomplishments: [] }))).toEqual(['how', 'what', 'followups'])
    expect(cardIds(project({ features: ['', '   '] }))).not.toContain('what')
  })

  it('drops blank entries and trims the rest', () => {
    const how = buildInterviewScript(project({ architecture: ['  a1  ', '', '   ', 'a2'] })).cards.find(
      (c) => c.id === 'how'
    )!
    expect(how.lines).toEqual(['a1', 'a2'])
  })

  it('derives follow-up questions only from tech and challenges that exist', () => {
    const followups = buildInterviewScript(project()).cards.find((c) => c.id === 'followups')!
    expect(followups.lines.slice(0, 4)).toEqual([
      'Why React.js?',
      'Why FastAPI?',
      'Why OpenAI?',
      'Why GCP?'
    ])
    expect(followups.lines.slice(4)).toEqual(['Walk me through: c1', 'Walk me through: c2'])
    // Never capped in the panel — the list is already short.
    expect(followups.previewCount).toBe(followups.lines.length)
  })

  it('has no follow-ups card when there is no tech stack and no challenges', () => {
    expect(cardIds(project({ techStack: [], challenges: [] }))).not.toContain('followups')
  })

  it('shortens a long challenge at a word boundary for the question stem', () => {
    const long =
      'Handling approximately 2,000 customer records while providing responsive filtering, searching, and navigation in the web application.'
    const followups = buildInterviewScript(project({ techStack: [], challenges: [long] })).cards.find(
      (c) => c.id === 'followups'
    )!
    const stem = followups.lines[0]
    expect(stem.startsWith('Walk me through: Handling approximately 2,000 customer records')).toBe(true)
    expect(stem.endsWith('…')).toBe(true)
    expect(stem).not.toMatch(/\s…$/) // no dangling space before the ellipsis
    expect(stem.length).toBeLessThan(long.length)
  })

  it('leaves a short challenge intact and strips its trailing period', () => {
    const followups = buildInterviewScript(project({ techStack: [], challenges: ['Short one.'] })).cards.find(
      (c) => c.id === 'followups'
    )!
    expect(followups.lines[0]).toBe('Walk me through: Short one')
  })
})
