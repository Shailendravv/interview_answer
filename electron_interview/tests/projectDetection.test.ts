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

  it('does not build patterns from one/two-character tokens', () => {
    // "data-insight" previously matched ANY sentence via its \bto\b pattern
    // (tokenized from the keyword "text to sql").
    const noisy = [
      { project: 'x', patterns: buildDetectionPatterns({ id: 'x', title: 'X Platform', keywords: ['text to sql'] }) }
    ]
    expect(scoreDetection('to understand with gen ai', noisy).id).toBeNull()
    expect(scoreDetection('we need sql generation', noisy).id).toBe('x')
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

describe('RouterService.shouldInjectProjectContext', () => {
  const weak = { id: 'agent-pulse', confident: false, ambiguous: false }
  const confident = { id: 'agent-pulse', confident: true, ambiguous: false }
  const none = { id: null, confident: false, ambiguous: false }

  it('a weak keyword hit must NOT hijack a generic conceptual question', () => {
    // "What is an AI Agent?" — 'agent' weakly matches agent-pulse.
    expect(RouterService.shouldInjectProjectContext(weak, 'general', false)).toBe(false)
    expect(RouterService.shouldInjectProjectContext(weak, 'coding', false)).toBe(false)
  })

  it('a confident hit injects regardless of category', () => {
    expect(RouterService.shouldInjectProjectContext(confident, 'general', false)).toBe(true)
    expect(RouterService.shouldInjectProjectContext(confident, 'project_specific', false)).toBe(true)
  })

  it('project_specific category always injects (route owns intent)', () => {
    expect(RouterService.shouldInjectProjectContext(none, 'project_specific', false)).toBe(true)
    expect(RouterService.shouldInjectProjectContext(weak, 'project_specific', false)).toBe(true)
  })

  it('routed non-catalog project injects even without keyword confidence', () => {
    expect(RouterService.shouldInjectProjectContext(none, 'general', true)).toBe(true)
  })

  it('ambiguous detection never injects', () => {
    expect(
      RouterService.shouldInjectProjectContext({ id: null, confident: false, ambiguous: true }, 'general', false)
    ).toBe(false)
  })
})

describe('RouterService.referencesActiveProject', () => {
  it('matches pronominal references to the selected project', () => {
    expect(RouterService.referencesActiveProject('Explain this project architecture in brief')).toBe(true)
    expect(RouterService.referencesActiveProject('tell me about my project')).toBe(true)
    expect(RouterService.referencesActiveProject('what is the current project tech stack')).toBe(true)
    expect(RouterService.referencesActiveProject('walk me through your project overview')).toBe(true)
    expect(RouterService.referencesActiveProject('describe the selected project challenges')).toBe(true)
  })

  it('rejects conceptual questions and named-project mentions', () => {
    // Conceptual questions must stay generic even with a project pinned.
    expect(RouterService.referencesActiveProject('What is Node JS?')).toBe(false)
    expect(RouterService.referencesActiveProject('What is an AI Agent?')).toBe(false)
    expect(RouterService.referencesActiveProject('What do you understand by Gen AI?')).toBe(false)
    // Named projects are handled by keyword detection, not this pattern.
    expect(RouterService.referencesActiveProject('explain the project_a pipeline')).toBe(false)
  })
})

describe('RouterService.refine punctuation', () => {
  it('does not double existing terminal punctuation', () => {
    expect(RouterService.refine('Node.js.')).toBe('Node.js.')
    expect(RouterService.refine('what is an AI agent?')).toBe('What is an AI agent?')
  })

  it('appends a period only after alphanumeric endings', () => {
    expect(RouterService.refine('uh what is node js')).toBe('What is node js.')
    expect(RouterService.refine('tell me about (Gen AI)')).toBe('Tell me about (Gen AI).')
  })
})

describe('RouterService.route with LLM classifier disabled', () => {
  function makeRouterStub() {
    let calls = 0
    return {
      calls: () => calls,
      // OllamaProvider shape used by RouterService.llmRoute
      generate: async function* () {
        calls++
        yield '{"is_question":true,"category":"coding","project_id":null,"refined_query":"stub"}'
        return { text: '', provider: 'ollama', model: 'stub' }
      },
      healthCheck: async () => true,
      on: () => {}
    } as never
  }

  it('never invokes the local LLM and falls back to deterministic routing', async () => {
    const stub = makeRouterStub()
    const svc = new RouterService(stub, { llmEnabled: false })
    // No '?' and no QUESTION_KEYWORDS — historically required llmRoute.
    const out = await svc.route('event loop internals')
    expect(stub.calls()).toBe(0)
    expect(out.is_question).toBe(true)
    expect(out.category).toBe('coding')
  })

  it('still uses the deterministic fast path for question keywords', async () => {
    const stub = makeRouterStub()
    const svc = new RouterService(stub, { llmEnabled: false })
    const out = await svc.route('what is a closure?')
    expect(stub.calls()).toBe(0)
    expect(out.is_question).toBe(true)
  })
})
