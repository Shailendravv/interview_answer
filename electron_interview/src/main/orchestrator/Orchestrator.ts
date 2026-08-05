import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipcChannels'
import { RouterService, RouterOutput, configureProjectKeywords, setRouterProjectList } from '../llm/RouterService'
import { LlmOrchestrator } from '../llm/LlmOrchestrator'
import { ContextService, PromptTurn } from '../context/ContextService'
import { DatabaseService } from '../db/DatabaseService'
import { RetrievalService } from '../docs/RetrievalService'
import { ProjectDocsService } from '../docs/ProjectDocsService'
import { ProjectCatalogService } from '../docs/ProjectCatalogService'
import { TokenBatcher } from '../llm/TokenBatcher'
import { SYSTEM_PROMPTS } from './SystemPrompts'
import { AnswerSanitizer } from '../context/AnswerSanitizer'
import { isSimilarTranscript } from './transcriptSimilarity'

const GENERIC_QUERY_PATTERN = /^(everything|explain|tell me more|tell me about it|more|all of it|all|go on|continue|elaborate)\.?$/i

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
        isSimilarTranscript(this.lastProcessedTranscript, normalized)) {
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

      const pinnedProjectId = this.activeProjectId
      const detection = RouterService.detectProjectScored(transcript)

      // Resolve which project (if any) this turn is about, honoring the
      // decision table: pinned unless explicitly/confidently overridden.
      const resolved = this.resolveProject(pinnedProjectId, detection)

      // Speculative vector retrieval only for projects not in the JSON catalog.
      const speculativeProjectId =
        resolved.projectId && !this.projectCatalog.has(resolved.projectId)
          ? resolved.projectId
          : null
      const speculativeRetrieval = speculativeProjectId
        ? this.retrievalService.retrieve(transcript, speculativeProjectId).catch(() => [] as { text: string; score: number }[])
        : Promise.resolve([] as { text: string; score: number }[])

      const [routeResult0, speculativeDocs] = await Promise.all([
        this.routerService.route(transcript),
        speculativeRetrieval
      ])

      if (!routeResult0.is_question) return
      let routeResult = routeResult0

      // Generic follow-ups ("everything", "explain") answer the active
      // project instead of drifting to the last history topic.
      if (
        GENERIC_QUERY_PATTERN.test(routeResult.refined_query.trim()) ||
        GENERIC_QUERY_PATTERN.test(transcript.trim())
      ) {
        const targetProject = resolved.projectId
        if (targetProject) {
          const project = this.projectCatalog.getById(targetProject)
          routeResult = {
            ...routeResult,
            category: 'project_specific',
            refined_query: `Explain the ${project?.title ?? 'selected project'} comprehensively.`
          }
        }
      }

      const routedNonCatalogProject =
        routeResult.project_id && !this.projectCatalog.has(routeResult.project_id)
      const explicitMention = detection.id !== null && !detection.ambiguous
      const isProjectQuery =
        explicitMention ||
        routeResult.category === 'project_specific' ||
        Boolean(routedNonCatalogProject)

      let contextTexts: string[] = []

      if (isProjectQuery) {
        const projectId = resolved.projectId ?? routeResult.project_id
        const block = projectId && this.projectCatalog.has(projectId)
          ? this.projectCatalog.getPromptBlock(projectId)
          : undefined
        if (block) {
          contextTexts = [block]
        } else if (projectId && !this.projectCatalog.has(projectId)) {
          const fallbackDocs = speculativeProjectId === projectId && speculativeDocs.length > 0
            ? speculativeDocs
            : await this.retrievalService.retrieve(routeResult.refined_query, projectId)
          contextTexts = fallbackDocs.map((d) => d.text)
        } else if (routeResult.category === 'project_specific') {
          contextTexts = [this.projectCatalog.buildClarifyBlock()]
        }
      }

      console.log('[route]', JSON.stringify({
        transcript: transcript.slice(0, 140),
        category: routeResult.category,
        project_id: routeResult.project_id,
        refined_query: routeResult.refined_query,
        pinned: pinnedProjectId,
        resolved: resolved.projectId,
        detection: {
          id: detection.id,
          hits: detection.hits,
          confident: detection.confident,
          ambiguous: detection.ambiguous
        }
      }))

      const { systemExtra, turns } = await this.contextService.buildPrompt(
        routeResult.refined_query,
        contextTexts
      )

      await this.generateAndStream(
        routeResult,
        systemExtra,
        turns,
        transcript,
        abort.signal,
        genId
      )

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

  private resolveProject(
    pinnedProjectId: string | null,
    detection: { id: string | null; confident: boolean; ambiguous: boolean }
  ): { projectId: string | null; switched: boolean } {
    if (detection.ambiguous) {
      // Tied multi-match — keep pinned (if any); otherwise fall through to clarify.
      return { projectId: pinnedProjectId, switched: false }
    }
    if (detection.id === null) {
      return { projectId: pinnedProjectId, switched: false }
    }
    if (pinnedProjectId === detection.id) {
      return { projectId: pinnedProjectId, switched: false }
    }
    if (pinnedProjectId !== null && detection.confident) {
      this.activeProjectId = detection.id
      console.log('[project] switched', JSON.stringify({ from: pinnedProjectId, to: detection.id }))
      return { projectId: detection.id, switched: true }
    }
    if (pinnedProjectId !== null && !detection.confident) {
      console.log('[project] weak mention ignored', JSON.stringify({ mentioned: detection.id, pinned: pinnedProjectId }))
      return { projectId: pinnedProjectId, switched: false }
    }
    if (detection.confident) {
      this.activeProjectId = detection.id
      console.log('[project] first pin', JSON.stringify({ to: detection.id }))
      return { projectId: detection.id, switched: true }
    }
    // No pinned project + weak single-token mention → one-turn override, non-sticky.
    return { projectId: detection.id, switched: false }
  }

  private pushToken(token: string, genId: number): void {
    this.tokenBatcher.push(token, genId)
  }

  private flushTokenBuffer(genId: number): void {
    this.tokenBatcher.flush(genId)
  }

  private async generateAndStream(
    route: RouterOutput,
    systemExtra: string,
    turns: PromptTurn[],
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
    const systemPrompt =
      introBlock +
      (systemExtra ? systemExtra + '\n' : '') +
      (SYSTEM_PROMPTS[route.category] || SYSTEM_PROMPTS.general)

    const messages: { role: string; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...turns
    ]

    this.window.webContents.send(IPC.ANSWER_RESET)
    this.window.webContents.send(IPC.TRANSCRIPT_FINAL, transcript)

    const gen = this.llmOrchestrator.getGenerationChain().generate({
      model: route.category,
      messages,
      stream: true,
      maxTokens: 512,
      temperature: 0.7,
      signal
    })

    // Defense-in-depth: strip prompt markers / history / question echoes the
    // model might reproduce (primary defense is the multi-turn prompt shape).
    const sanitizer = new AnswerSanitizer({ refinedQuery: route.refined_query })

    let fullAnswer = ''
    const emitLine = (line: string): void => {
      fullAnswer += line
      this.pushToken(line, genId)
    }

    for await (const token of gen) {
      if (signal?.aborted || !this.tokenBatcher.isActive(genId)) {
        return fullAnswer
      }
      for (const line of sanitizer.push(token)) emitLine(line)
    }
    for (const line of sanitizer.flush()) emitLine(line)

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

    console.log('[answer]', JSON.stringify({
      category: route.category,
      project_id: route.project_id,
      length: fullAnswer.length
    }))

    return fullAnswer
  }

  private sendStatus(status: string): void {
    this.window?.webContents.send(IPC.STATUS_UPDATE, { status })
  }

  destroy(): void {
    this.dbService.close()
  }
}
