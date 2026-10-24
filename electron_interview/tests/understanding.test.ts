import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {} }))
vi.mock('../src/main/db/DatabaseService', () => ({
  DatabaseService: class {
    private nextId = 1
    createInterview(): number { return this.nextId++ }
    addMessage(): void {}
    getSummary(): null { return null }
    getAllMessages(): [] { return [] }
    saveSummary(): void {}
    close(): void {}
  }
}))
vi.mock('../src/main/docs/ProjectDocsService', () => ({ ProjectDocsService: class {} }))
vi.mock('../src/main/docs/RetrievalService', () => ({
  RetrievalService: class { async retrieve(): Promise<[]> { return [] } }
}))

import { RouterService } from '../src/main/llm/RouterService'
import { isChitChat } from '../src/main/orchestrator/chitChat'
import { Orchestrator } from '../src/main/orchestrator/Orchestrator'
import { SYSTEM_PROMPTS } from '../src/main/orchestrator/SystemPrompts'
import type { GenerationRequest } from '../src/main/llm/LlmProvider'

describe('RouterService.detectCategory: conceptual questions use the general template', () => {
  it.each([
    'Explain the event loop in Node.js.',
    'What is a closure in JavaScript?',
    'What is the CAP theorem?',
    'What is the difference between SQL and NoSQL databases?',
    'What is Kubernetes used for?',
    'What are microservices?'
  ])('%s -> general', (q) => {
    expect(RouterService.detectCategory(q)).toBe('general')
  })

  it.each([
    ['Implement a function to reverse a linked list.', 'coding'],
    ['Write code to find the longest palindromic substring.', 'coding'],
    ['How would you debug a memory leak in a Node.js service?', 'coding'],
    ['What is the time complexity of binary search?', 'coding'],
    ['Solve two sum in linear time.', 'coding'],
    ['Design a URL shortener like bitly.', 'system_design'],
    ['How would you design a rate limiter for a public API?', 'system_design'],
    ['Explain how you would design a distributed cache.', 'system_design'],
    ['Tell me about a time you handled a conflict in your team.', 'behavioral']
  ])('%s -> %s', (q, category) => {
    expect(RouterService.detectCategory(q)).toBe(category)
  })
})

describe('isChitChat', () => {
  it.each(['Okay, great.', 'Hmm.', "Let's move on to the next topic.", 'Thank you, that\'s all for today.', 'Can you hear me?', 'Alright.', 'Got it, thanks.'])(
    'treats "%s" as chit-chat',
    (t) => expect(isChitChat(t)).toBe(true)
  )

  it.each([
    'What is a closure?',
    'Okay, so what is a closure?',
    "Let's move on to system design: how would you design a URL shortener?",
    'Thank you. Now explain the event loop.',
    'Can you hear me? Good, tell me about yourself.',
    'Great, can you walk me through your billing project?',
    'Hmm, why did you choose FastAPI?'
  ])('keeps "%s"', (t) => expect(isChitChat(t)).toBe(false))
})

function setup() {
  const requests: GenerationRequest[] = []
  let release: (() => void) | null = null
  const chain = {
    generate: (req: GenerationRequest) => {
      requests.push(req)
      return (async function* () {
        await new Promise<void>((r) => { release = r })
        yield 'answer\n'
        return { text: 'answer\n', provider: 'fake', model: 'fake' }
      })()
    }
  }
  const llm = { getRouter: () => ({}), getGenerationChain: () => chain, onFallback: () => {}, ollamaService: { getBaseUrl: () => '' } }
  const catalog = {
    getKeywordEntries: () => [{ project: 'billing', patterns: [{ regex: /\bbilling (?:validation|platform)\b/i, strong: true }] }],
    listProjectsForPrompt: () => 'billing',
    onUpdate: () => {},
    has: (id: string) => id === 'billing',
    getPromptBlock: (id: string) => (id === 'billing' ? 'PROJECT: Billing Platform' : undefined),
    getById: () => ({ title: 'Billing Platform' }),
    getIntroduction: () => ({ summary: '' })
  }
  const window = { webContents: { send: () => {} } }
  const orchestrator = new Orchestrator(llm as never, catalog as never)
  orchestrator.setWindow(window as never)
  const finish = async (): Promise<void> => {
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 1))
    release?.()
    release = null
  }
  return { orchestrator, requests, finish }
}

describe('Orchestrator understanding', () => {
  it('does not answer spoken chit-chat', async () => {
    const { orchestrator, requests } = setup()
    await orchestrator.startInterview()
    await orchestrator.processTranscript('Okay, great.', 'stt')
    expect(requests).toHaveLength(0)
  })

  it('still answers typed input even if it looks like chit-chat', async () => {
    const { orchestrator, requests, finish } = setup()
    await orchestrator.startInterview()
    const done = orchestrator.processTranscript('okay', 'user')
    await finish()
    await done
    expect(requests).toHaveLength(1)
  })

  it('chit-chat cannot replace a real question waiting in the queue', async () => {
    const { orchestrator, requests, finish } = setup()
    await orchestrator.startInterview()
    const first = orchestrator.processTranscript('What is a closure?', 'stt')
    await new Promise((r) => setTimeout(r, 5))
    void orchestrator.processTranscript('What is the event loop in Node.js?', 'stt') // queued
    void orchestrator.processTranscript('Okay, great.', 'stt') // must not supersede it
    await finish()
    await first
    await new Promise((r) => setTimeout(r, 5))
    await finish()
    await new Promise((r) => setTimeout(r, 5))
    const asked = requests.map((r) => r.messages[r.messages.length - 2].content)
    expect(asked[1]).toContain('What is the event loop in Node.js?')
  })

  it('uses the project template when a named project\'s context is injected', async () => {
    const { orchestrator, requests, finish } = setup()
    await orchestrator.startInterview()
    const done = orchestrator.processTranscript('Explain the architecture of your billing validation platform.', 'user')
    await finish()
    await done
    const system = requests[0].messages[0].content
    expect(system).toContain('PROJECT: Billing Platform')
    expect(system.endsWith(SYSTEM_PROMPTS.project_specific)).toBe(true)
  })
})
