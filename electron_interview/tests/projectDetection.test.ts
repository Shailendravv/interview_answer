import { describe, it, expect } from 'vitest'
import {
  buildDetectionPatterns,
  scoreDetection
} from '../src/main/docs/detection'
import { RouterService } from '../src/main/llm/RouterService'

const ENTRIES = [
  {
    project: 'financial-automation',
    patterns: buildDetectionPatterns({
      id: 'financial-automation',
      title: 'Financial Automation Platform',
      keywords: ['veolia', 'invoice', 'email processing']
    })
  },
  {
    project: 'sales-intelligence',
    patterns: buildDetectionPatterns({
      id: 'sales-intelligence',
      title: 'Sales Intelligence Dashboard',
      keywords: ['lead scoring', 'crm', 'pipeline']
    })
  },
  {
    project: 'multi-llm',
    patterns: buildDetectionPatterns({
      id: 'multi-llm',
      title: 'Multi-LLM Project',
      keywords: ['llm', 'multi-llm', 'model comparison']
    })
  }
]

describe('scoreDetection', () => {
  it('treats a full project id phrase as a strong, confident match', () => {
    const r = scoreDetection('Explain the financial-automation project', ENTRIES)
    expect(r).toEqual({ id: 'financial-automation', hits: 1, confident: true, ambiguous: false })
  })

  it('detects the MULTI-LLM project via the multi-llm keyword', () => {
    const r = scoreDetection('MULTI-LLM Project', ENTRIES)
    expect(r.id).toBe('multi-llm')
    expect(r.confident).toBe(true)
  })

  it('matches a strong multi-word title phrase', () => {
    const r = scoreDetection('How does the Financial Automation Platform handle invoices?', ENTRIES)
    expect(r.id).toBe('financial-automation')
    expect(r.confident).toBe(true)
  })

  it('returns null for generic tokens on the stoplist', () => {
    expect(scoreDetection('build a dashboard for the project', ENTRIES)).toEqual({
      id: null, hits: 0, confident: false, ambiguous: false
    })
  })

  it('flags a single weak-token hit as non-confident (one-turn override, non-sticky)', () => {
    const r = scoreDetection('Tell me about veolia', ENTRIES)
    expect(r).toEqual({ id: 'financial-automation', hits: 1, confident: false, ambiguous: false })
  })

  it('marks ties across projects as ambiguous', () => {
    const r = scoreDetection('veolia crm integration', ENTRIES)
    expect(r.ambiguous).toBe(true)
    expect(r.id).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(scoreDetection('', ENTRIES)).toEqual({
      id: null, hits: 0, confident: false, ambiguous: false
    })
  })
})

describe('RouterService.detectCategory (OOP routing)', () => {
  it('routes conceptual OOP questions to the general template', () => {
    expect(RouterService.detectCategory('What is OOPS concept?')).toBe('general')
    expect(RouterService.detectCategory('Explain object oriented programming')).toBe('general')
    expect(RouterService.detectCategory('OOPS in python?')).toBe('general')
  })

  it('routes implementation-style OOP to the coding template', () => {
    expect(RouterService.detectCategory('Implement an OOP inventory system')).toBe('coding')
  })

  it('routes non-OOP coding and design questions normally', () => {
    expect(RouterService.detectCategory('implement a binary search tree')).toBe('coding')
    expect(RouterService.detectCategory('design a distributed cache')).toBe('system_design')
  })
})
