// Assembles the app's real main-process answer path, wired as src/main/index.ts
// wires it. Requires `vi.mock('electron', ...)` in the calling suite.
import { LlmOrchestrator } from '../../src/main/llm/LlmOrchestrator'
import { Orchestrator } from '../../src/main/orchestrator/Orchestrator'
import { ProjectCatalogService } from '../../src/main/docs/ProjectCatalogService'
import { generationOptionsFromEnv } from '../../src/main/llm/generationOptions'
import type { GenerationRequest } from '../../src/main/llm/LlmProvider'
import { FakeWindow } from './fakeWindow'
import { loadAppEnv } from './sttConfig'

export interface AnswerPath {
  orchestrator: Orchestrator
  llm: LlmOrchestrator
  catalog: ProjectCatalogService
  window: FakeWindow
  /** Requests the generation chain received (fake mode records; real mode too). */
  requests: GenerationRequest[]
  dispose(): void
}

const OLLAMA = 'http://127.0.0.1:11434'

/**
 * The app's OllamaService.start() spawns `ollama serve` and kills any
 * llama-server.exe when Ollama is not already up. The harness must never do
 * that, so it only proceeds against an already-running Ollama.
 */
export async function ollamaPreflight(): Promise<{ ok: boolean; version?: string; models?: string[]; reason?: string }> {
  try {
    const v = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(3000) })
    const tags = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })
    const models = ((await tags.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? []
    return { ok: v.ok && tags.ok, version: ((await v.json()) as { version?: string }).version, models }
  } catch (err) {
    return { ok: false, reason: `Ollama not reachable at ${OLLAMA} (${err instanceof Error ? err.message : err}). Start it with \`ollama serve\`.` }
  }
}

export async function createAnswerPath(mode: 'real' | 'fake-llm'): Promise<AnswerPath> {
  loadAppEnv()
  const window = new FakeWindow()
  const catalog = new ProjectCatalogService()
  const llm = new LlmOrchestrator({ groq: process.env.GROQ_API_KEY, groqModel: process.env.GROQ_MODEL })
  const requests: GenerationRequest[] = []

  if (mode === 'real') {
    await llm.initialize()
  }

  const orchestrator = new Orchestrator(llm, catalog, {
    routerLlmEnabled: process.env.ROUTER_LLM_ENABLED === '1',
    ...generationOptionsFromEnv()
  })
  orchestrator.setWindow(window.asBrowserWindow())
  await orchestrator.startInterview('Evaluation Session')
  // --model=groq: same path the UI dropdown takes (Groq first, Ollama fallback).
  if (process.env.EVAL_MODEL === 'groq') {
    if (!process.env.GROQ_API_KEY) throw new Error('--model=groq needs GROQ_API_KEY in .env')
    orchestrator.setGenerationModel('groq')
  }

  // Wrap (real) or replace (fake) the generation chain to record what it is
  // asked to generate. The chain object is rebuilt on model switches, so the
  // wrap is applied to whatever getGenerationChain() returns right now.
  const chain = llm.getGenerationChain()
  const realGenerate = chain.generate.bind(chain)
  chain.generate = (req: GenerationRequest) => {
    requests.push(req)
    if (mode === 'real') return realGenerate(req)
    return (async function* () {
      yield '## Answer\nfake answer for routing evaluation\n'
      return { text: '', provider: 'fake', model: 'fake' }
    })()
  }

  return {
    orchestrator,
    llm,
    catalog,
    window,
    requests,
    dispose: () => {
      orchestrator.destroy()
      catalog.destroy()
    }
  }
}

/** Identifies which [PROJECT CONTEXT] (if any) a system prompt carries. */
export function injectedContext(systemPrompt: string, catalog: ProjectCatalogService): string {
  if (systemPrompt.includes('AVAILABLE PROJECTS:')) return 'clarify'
  // The injected block is a line of its own; BASE_RULES also mentions
  // "[PROJECT CONTEXT]" inline, which must not count as injection.
  const m = systemPrompt.match(/^\[PROJECT CONTEXT\]\nPROJECT: (.+)/m)
  if (!m) return /^\[PROJECT CONTEXT\]$/m.test(systemPrompt) ? 'project:retrieved-docs' : 'none'
  const project = catalog.getAllProjects().find((p) => p.title === m[1].trim())
  return project ? `project:${project.id}` : 'project:unknown'
}

/** Which category template a system prompt ends with. */
export function templateCategory(systemPrompt: string, templates: Record<string, string>): string {
  for (const [category, template] of Object.entries(templates)) {
    if (systemPrompt.endsWith(template)) return category
  }
  return 'unknown'
}
