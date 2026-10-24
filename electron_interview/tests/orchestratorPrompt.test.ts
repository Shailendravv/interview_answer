import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { Orchestrator } from '../src/main/orchestrator/Orchestrator'
import { NO_PROJECT_MESSAGE, answerPrefill, formatReminder, templateHeadings } from '../src/main/orchestrator/SystemPrompts'
import type { GenerationRequest } from '../src/main/llm/LlmProvider'

const BILLING_BLOCK = 'PROJECT: Billing Platform\nTECH: FastAPI'

function setup(modelOutput: string[], options: { maxTokens?: number; temperature?: number } = {}) {
  const requests: GenerationRequest[] = []
  const chain = {
    generate: (req: GenerationRequest) => {
      requests.push(req)
      return (async function* () {
        for (const t of modelOutput) yield t
        return { text: modelOutput.join(''), provider: 'fake', model: 'fake' }
      })()
    }
  }
  const llm = {
    getRouter: () => ({}),
    getGenerationChain: () => chain,
    onFallback: () => {},
    ollamaService: { getBaseUrl: () => 'http://127.0.0.1:11434' }
  }
  const catalog = {
    getKeywordEntries: () => [],
    listProjectsForPrompt: () => 'billing (Billing Platform)',
    onUpdate: () => {},
    has: (id: string) => id === 'billing',
    getPromptBlock: (id: string) => (id === 'billing' ? BILLING_BLOCK : undefined),
    getById: (id: string) => (id === 'billing' ? { title: 'Billing Platform' } : undefined),
    getIntroduction: () => ({ summary: '' })
  }
  const sent: { channel: string; args: unknown[] }[] = []
  const window = { webContents: { send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }) } }
  const orchestrator = new Orchestrator(llm as never, catalog as never, options)
  orchestrator.setWindow(window as never)
  const answer = (): string => sent.filter((s) => s.channel === 'answer:token').map((s) => String(s.args[0])).join('')
  return { orchestrator, requests, sent, answer }
}

describe('Orchestrator prompt shape', () => {
  beforeEach(() => vi.useRealTimers())

  it('restates the format on the question turn and prefills the first heading', async () => {
    const { orchestrator, requests } = setup(['A process owns memory.\n'])
    await orchestrator.startInterview()
    await orchestrator.processTranscript('What is the difference between a process and a thread?', 'user')

    const msgs = requests[0].messages
    const userTurn = msgs[msgs.length - 2]
    expect(userTurn.role).toBe('user')
    expect(userTurn.content).toContain('[CURRENT QUESTION - answer ONLY this]')
    expect(userTurn.content.endsWith(formatReminder('general'))).toBe(true)
    expect(msgs[msgs.length - 1]).toEqual({ role: 'assistant', content: answerPrefill('general') })
  })

  it('shows the prefilled heading with the first model output, not before it', async () => {
    const { orchestrator, answer } = setup(['A process ', 'owns memory.\n'])
    await orchestrator.startInterview()
    await orchestrator.processTranscript('What is the difference between a process and a thread?', 'user')
    expect(answer()).toBe('## Answer\nA process owns memory.\n')
  })

  it('does not repeat the heading when the model ignores the prefill', async () => {
    const { orchestrator, answer } = setup(['## Answer\n', 'A process owns memory.\n'])
    await orchestrator.startInterview()
    await orchestrator.processTranscript('What is the difference between a process and a thread?', 'user')
    expect(answer()).toBe('## Answer\nA process owns memory.\n')
  })

  it('sends the configured length cap and temperature', async () => {
    const { orchestrator, requests } = setup(['ok\n'], { maxTokens: 300, temperature: 0.2 })
    await orchestrator.startInterview()
    await orchestrator.processTranscript('What is a closure?', 'user')
    expect(requests[0].maxTokens).toBe(300)
    expect(requests[0].temperature).toBe(0.2)
  })

  it('defaults to the 768-token cap and temperature 0.7', async () => {
    const { orchestrator, requests } = setup(['ok\n'])
    await orchestrator.startInterview()
    await orchestrator.processTranscript('What is a closure?', 'user')
    expect(requests[0]).toMatchObject({ maxTokens: 768, temperature: 0.7 })
  })

  it('answers "your project" with nothing selected deterministically, without the LLM', async () => {
    const { orchestrator, requests, answer, sent } = setup(['should not be used'])
    await orchestrator.startInterview()
    await orchestrator.processTranscript('Tell me about your project.', 'user')
    expect(requests).toHaveLength(0)
    expect(answer()).toBe(NO_PROJECT_MESSAGE)
    expect(sent.some((s) => s.channel === 'answer:done')).toBe(true)
  })

  it('still uses the LLM with project context when a project is pinned', async () => {
    const { orchestrator, requests } = setup(['It ingests invoices.\n'])
    await orchestrator.startInterview()
    orchestrator.setActiveProject('billing')
    await orchestrator.processTranscript('Tell me about your project.', 'user')
    expect(requests).toHaveLength(1)
    expect(requests[0].messages[0].content).toContain(BILLING_BLOCK)
    // Grounded in the candidate's own project: the conservative temperature.
    expect(requests[0].temperature).toBe(0.3)
    // No format forcing for grounded answers: it made the model invent tech.
    const msgs = requests[0].messages
    expect(msgs.at(-1)!.role).toBe('user')
    expect(msgs.at(-1)!.content).not.toContain(formatReminder('project_specific'))
    expect(templateHeadings('project_specific')[0]).toBe('Overview')
  })
})

describe('generationOptionsFromEnv', () => {
  it('reads overrides and ignores empty or invalid values', async () => {
    const { generationOptionsFromEnv } = await import('../src/main/llm/generationOptions')
    expect(generationOptionsFromEnv({ LLM_MAX_TOKENS: '600', LLM_TEMPERATURE: '0', LLM_GROUNDED_TEMPERATURE: '0.2' })).toEqual({
      maxTokens: 600,
      temperature: 0,
      groundedTemperature: 0.2
    })
    expect(generationOptionsFromEnv({ LLM_MAX_TOKENS: '', LLM_TEMPERATURE: 'abc' })).toEqual({
      maxTokens: undefined,
      temperature: undefined,
      groundedTemperature: undefined
    })
  })
})
