import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipcChannels'
import { RouterService, RouterOutput, configureProjectKeywords, setRouterProjectList } from '../llm/RouterService'
import { LlmOrchestrator } from '../llm/LlmOrchestrator'
import { ContextService } from '../context/ContextService'
import { DatabaseService } from '../db/DatabaseService'
import { RetrievalService } from '../docs/RetrievalService'
import { ProjectDocsService } from '../docs/ProjectDocsService'
import { ProjectCatalogService } from '../docs/ProjectCatalogService'
import { TokenBatcher } from '../llm/TokenBatcher'

const BASE_SYSTEM_PROMPT = `
You are a senior software engineer and interview assistant.

Your primary goal is to help the candidate answer interview questions quickly, accurately, and naturally.

Rules:
- Give the answer immediately.
- Do not repeat the question.
- Do not add unnecessary introductions.
- Keep answers concise unless the question explicitly requires detail.
- Use bullet points where appropriate.
- When explaining concepts, use simple language first, then provide technical details.
- If multiple solutions exist, recommend the most commonly accepted interview answer first.
- Mention trade-offs only when relevant.
- If the question is incomplete, infer the most likely intent and answer it.
- Never hallucinate project details. Use only the supplied project context.
- Optimize every response for interview situations where time is limited.
`

const SYSTEM_PROMPTS: Record<string, string> = {
  coding: `
${BASE_SYSTEM_PROMPT}

You are an expert coding interviewer.

For every coding question:

1. Identify the problem.
2. Explain the intuition.
3. Give the optimal algorithm.
4. State Time Complexity.
5. State Space Complexity.
6. Mention important edge cases.
7. Provide clean production-quality code.
8. Explain the code briefly.
9. Mention alternative approaches only if significantly different.

Keep explanations interview-friendly.
`,

  system_design: `
${BASE_SYSTEM_PROMPT}

You are a Staff Software Engineer specializing in System Design interviews.

Answer using this structure:

1. Clarify requirements
2. Functional requirements
3. Non-functional requirements
4. High-level architecture
5. Components
6. Database
7. APIs
8. Scaling
9. Bottlenecks
10. Trade-offs
11. Security
12. Monitoring
13. Future improvements

Use Mermaid diagrams when useful.
`,

  behavioral: `
${BASE_SYSTEM_PROMPT}

You are an interview coach.

Answer using STAR:

- Situation
- Task
- Action
- Result

Keep responses authentic and conversational.

Avoid sounding scripted.

Highlight measurable impact whenever possible.
`,

  project_specific: `
${BASE_SYSTEM_PROMPT}

You are answering questions about the candidate's own software projects.

Rules:

- Use ONLY the provided project documentation.
- Never invent architecture.
- If documentation is missing, clearly state that.
- Explain design decisions.
- Explain trade-offs.
- Explain why technologies were selected.
- Reference modules, workflows, APIs, and architecture when available.
- Keep answers technically deep but concise.
`,

  general: `
${BASE_SYSTEM_PROMPT}

Answer technical interview questions clearly.

Structure:

- Short Answer
- Explanation
- Example
- Best Practice
- Common Mistake (if applicable)

Prioritize clarity over completeness.
`,
}

export class Orchestrator {
  private routerService: RouterService
  private contextService: ContextService
  private retrievalService: RetrievalService
  private dbService: DatabaseService
  private llmOrchestrator: LlmOrchestrator
  private window: BrowserWindow | null = null
  private isProcessing = false
  private currentAbort: AbortController | null = null
  private lastProcessedTranscript: string | null = null
  private tokenBatcher = new TokenBatcher()
  private generationCounter = 0
  private projectCatalog: ProjectCatalogService
  private activeProjectId: string | null = null

  constructor(
    llmOrchestrator: LlmOrchestrator,
    projectCatalog: ProjectCatalogService
  ) {
    this.llmOrchestrator = llmOrchestrator
    this.projectCatalog = projectCatalog
    this.routerService = new RouterService(llmOrchestrator.getRouter())
    this.dbService = new DatabaseService()
    this.contextService = new ContextService(this.dbService, llmOrchestrator.getRouter())

    const ollamaBaseUrl = llmOrchestrator['ollamaService']?.getBaseUrl() || 'http://localhost:11434'
    const projectDocsService = new ProjectDocsService(ollamaBaseUrl)
    this.retrievalService = new RetrievalService(projectDocsService)

    this.configureRouter()
    this.projectCatalog.onUpdate(() => this.configureRouter())
  }

  private configureRouter(): void {
    configureProjectKeywords(this.projectCatalog.getKeywordEntries())
    setRouterProjectList(this.projectCatalog.listProjectsForPrompt())
  }

  setActiveProject(projectId: string | null): void {
    this.activeProjectId = projectId
  }

  getActiveProject(): string | null {
    return this.activeProjectId
  }

  setWindow(win: BrowserWindow): void {
    this.window = win
    this.tokenBatcher.setWindow(win)
  }

  async startInterview(title = ''): Promise<void> {
    await this.contextService.startNewInterview(title)
  }

  async processTranscript(transcript: string): Promise<void> {
    const normalized = transcript.trim().toLowerCase()

    if (this.isProcessing && this.lastProcessedTranscript &&
        this.isSimilar(this.lastProcessedTranscript, normalized)) {
      return
    }
    if (!this.window) return

    // Every transcript starts a new generation that supersedes the previous
    // one; stale generations may no longer stream tokens or emit ANSWER_DONE.
    const genId = ++this.generationCounter
    this.tokenBatcher.setActive(genId)
    this.currentAbort?.abort()
    this.currentAbort = null
    this.isProcessing = true
    this.lastProcessedTranscript = normalized

    const abort = new AbortController()
    this.currentAbort = abort

    try {
      this.sendStatus('processing')

      // Speculative: detect project via regex (fast) before LLM route completes.
      // When a project is pinned by the user OR is in the JSON catalog, skip
      // vector retrieval entirely — the catalog block is injected directly.
      const pinnedProjectId = this.activeProjectId
      const speculativeProjectId = pinnedProjectId ?? RouterService.detectProject(transcript)
      const needsVectorRetrieval = Boolean(speculativeProjectId && !pinnedProjectId && !this.projectCatalog.has(speculativeProjectId))
      const speculativeRetrieval = needsVectorRetrieval
        ? this.retrievalService.retrieve(transcript, speculativeProjectId).catch(() => [] as { text: string; score: number }[])
        : Promise.resolve([] as { text: string; score: number }[])

      // Step 1 + speculative retrieval in parallel
      const [routeResult, speculativeDocs] = await Promise.all([
        this.routerService.route(transcript),
        speculativeRetrieval
      ])

      if (!routeResult.is_question) return

      // Deterministic fast path: pinned project > routed project > keyword detect.
      // Fire whenever the question targets a catalog project, regardless of the
      // detected category (e.g. "explain the architecture of my X" routes as
      // system_design but still needs the project block).
      const routedCatalogProject =
        routeResult.project_id && this.projectCatalog.has(routeResult.project_id)
      const isProjectQuery =
        routedCatalogProject || routeResult.category === 'project_specific' || Boolean(pinnedProjectId)
      let contextTexts: string[] = []

      if (isProjectQuery) {
        const projectId = pinnedProjectId ?? routeResult.project_id ?? speculativeProjectId
        const block = projectId ? this.projectCatalog.getPromptBlock(projectId) : undefined
        if (block) {
          contextTexts = [block]
        } else if (routeResult.category === 'project_specific') {
          contextTexts = [this.projectCatalog.buildClarifyBlock()]
        }
      }

      // Fallback: markdown/vector retrieval for projects not in the catalog
      if (contextTexts.length === 0 && routeResult.project_id && !this.projectCatalog.has(routeResult.project_id)) {
        const fallbackDocs = routeResult.project_id === speculativeProjectId && speculativeDocs.length > 0
          ? speculativeDocs
          : await this.retrievalService.retrieve(routeResult.refined_query, routeResult.project_id)
        contextTexts = fallbackDocs.map((d) => d.text)
      }

      const { prompt } = await this.contextService.buildPrompt(
        routeResult.refined_query,
        contextTexts
      )

      await this.generateAndStream(routeResult, prompt, transcript, abort.signal, genId)

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      this.window?.webContents.send(IPC.ANSWER_ERROR, String(err))
    } finally {
      if (this.tokenBatcher.isActive(genId)) {
        this.isProcessing = false
        this.lastProcessedTranscript = null
        this.sendStatus('idle')
      }
    }
  }

  private pushToken(token: string, genId: number): void {
    this.tokenBatcher.push(token, genId)
  }

  private flushTokenBuffer(genId: number): void {
    this.tokenBatcher.flush(genId)
  }

  private async generateAndStream(
    route: RouterOutput,
    prompt: string,
    transcript: string,
    signal?: AbortSignal,
    genId = 0
  ): Promise<string> {
    if (!this.window) return ''
    // A stale generation must not clobber the display of a newer question.
    if (!this.tokenBatcher.isActive(genId)) return ''

    const intro = this.projectCatalog.getIntroduction()
    const introBlock = intro?.summary
      ? `<about>\n${intro.summary}\n</about>\n`
      : ''
    const systemPrompt = introBlock + (SYSTEM_PROMPTS[route.category] || SYSTEM_PROMPTS.general)

    this.window.webContents.send(IPC.ANSWER_RESET)
    this.window.webContents.send(IPC.TRANSCRIPT_FINAL, transcript)

    const gen = this.llmOrchestrator.getGenerationChain().generate({
      model: route.category,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: true,
      maxTokens: 512,
      temperature: 0.7,
      signal
    })

    let fullAnswer = ''

    for await (const token of gen) {
      if (signal?.aborted || !this.tokenBatcher.isActive(genId)) {
        return fullAnswer
      }
      fullAnswer += token
      this.pushToken(token, genId)
    }

    // A cancelled generation ends "cleanly" from the provider's perspective;
    // only an actually-live generation may finalize.
    if (signal?.aborted || !this.tokenBatcher.isActive(genId)) {
      return fullAnswer
    }

    this.flushTokenBuffer(genId)
    this.window.webContents.send(IPC.ANSWER_DONE, { question: transcript })

    this.contextService.addInteraction(
      route.refined_query || transcript,
      fullAnswer
    )

    return fullAnswer
  }

  private normalizeTranscript(text: string): string {
    return text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/[.!?]+(\s|$)/g, '$1')
  }

  private isSimilar(a: string, b: string): boolean {
    const na = this.normalizeTranscript(a)
    const nb = this.normalizeTranscript(b)
    if (na === nb) return true

    const aWords = na.split(/\s+/).filter(Boolean)
    const bWords = nb.split(/\s+/).filter(Boolean)
    if (aWords.length === 0 || bWords.length === 0) return na === nb

    const intersection = aWords.filter((w) => bWords.includes(w)).length
    const union = new Set([...aWords, ...bWords]).size
    return intersection / union >= 0.6
  }

  private sendStatus(status: string): void {
    this.window?.webContents.send(IPC.STATUS_UPDATE, { status })
  }

  destroy(): void {
    this.dbService.close()
  }
}
