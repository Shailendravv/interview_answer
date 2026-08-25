import { describe, it, expect } from 'vitest'
import { SYSTEM_PROMPTS } from '../src/main/orchestrator/SystemPrompts'

const HEADINGS: Record<string, string[]> = {
  general: ['Answer', 'Explanation', 'Example', 'Best Practice', 'Common Mistake'],
  coding: ['Problem', 'Approach', 'Code', 'Explanation', 'Edge Cases'],
  system_design: ['Requirements', 'Architecture', 'Components', 'Database', 'Scaling & Trade-offs', 'Security & Monitoring'],
  behavioral: ['Situation', 'Task', 'Action', 'Result'],
  project_specific: ['Overview', 'Architecture & Tech Stack', 'Key Features', 'Challenges & Solutions', 'My Role & Impact']
}

describe('SYSTEM_PROMPTS heading contracts', () => {
  for (const [category, headings] of Object.entries(HEADINGS)) {
    it(`${category} keeps its exact heading sequence`, () => {
      const prompt = SYSTEM_PROMPTS[category]
      let idx = -1
      for (const h of headings) {
        const at = prompt.indexOf(`## ${h}`)
        expect(at, `## ${h} missing from ${category}`).toBeGreaterThan(idx)
        idx = at
      }
    })
  }

  it('every variant preserves the core behavioral rules', () => {
    for (const [, prompt] of Object.entries(SYSTEM_PROMPTS)) {
      expect(prompt).toContain('first person')
      expect(prompt).toContain('[CURRENT QUESTION]')
      expect(prompt).toContain('[PROJECT CONTEXT]')
    }
  })

  it('every single-variant prompt stays lean (per-request eval cost)', () => {
    // Each request sends exactly ONE variant; baseline variants were ~1700-
    // 2100 chars of template + ~450 chars of restated rules each.
    const longest = Math.max(...Object.values(SYSTEM_PROMPTS).map((p) => p.length))
    expect(longest).toBeLessThan(2300)
  })
})
