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
import { SYSTEM_PROMPTS, NO_PROJECT_MESSAGE, answerPrefill, formatReminder } from './SystemPrompts'
import { AnswerSanitizer } from '../context/AnswerSanitizer'
import { isSimilarTranscript } from './transcriptSimilarity'
import { isChitChat } from './chitChat'
import { describeError } from '../llm/errors'
import { latencyTracer } from '../telemetry/LatencyTracer'

const GENERIC_QUERY_PATTERN = /^(everything|explain|tell me more|tell me about it|more|all of it|all|go on|continue|elaborate)\.?$/i

export type TranscriptSource = 'stt' | 'user'

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
  /** Single slot; a newer spoken question supersedes an older queued one. */
  private queuedTranscript: string | null = null
  private tokenBatcher = new TokenBatcher()
  private generationCounter = 0
  private projectCatalog: ProjectCatalogService
  private activeProjectId: string | null = null
  private maxTokens: number
  private temperature: number
  private groundedTemperature: number

  constructor(
    llmOrchestrator: LlmOrchestrator,
    projectCatalog: ProjectCatalogService,
    options: { routerLlmEnabled?: boolean; maxTokens?: number; temperature?: number; groundedTemperature?: number } = {}
  ) {
    this.llmOrchestrator = llmOrchestrator
    this.projectCatalog = projectCatalog
    // Until Ollama options were forwarded, no cap reached the local model
    // (median answer 295 tokens, one runaway of 35,800). With every mandated
    // section now filled, 512 cut off 36% of answers in the bench suite; 768
    // cut off 10% and still bounds a runaway to ~7s.
    this.maxTokens = options.maxTokens ?? 768
    this.temperature = options.temperature ?? 0.7
    // Answers built on [PROJECT CONTEXT] describe the candidate's own work, so
    // invented details are the costliest error. 0.3 halved project answers
    // naming tech absent from the context in the bench prompt experiment
    // (12/20 -> 6/20) and lowered it in the full suite (9/20 -> 7/20).
    this.groundedTemperature = options.groundedTemperature ?? 0.3
    this.routerService = new RouterService(llmOrchestrator.getRouter(), {
      llmEnabled: options.routerLlmEnabled ?? false
    })
    this.dbService = new DatabaseService()
    this.contextService = new ContextService(this.dbService)

    const ollamaBaseUrl = llmOrchestrator['ollamaService']?.getBaseUrl() || 'http://localhost:11434'
    const projectDocsService = new ProjectDocsService(ollamaBaseUrl)
    this.retrievalService = new RetrievalService(projectDocsService)

    this.configureRouter()
    this.projectCatalog.onUpdate(() => this.configureRouter())

    // Tell the UI when the selected model (Groq) failed and Ollama answered.
    this.llmOrchestrator.onFallback((event) => {
      this.window?.webContents.send(IPC.ANSWER_FALLBACK, event)
    })
  }

  private configureRouter(): void {
    configureProjectKeywords(this.projectCatalog.getKeywordEntries())
    setRouterProjectList(this.projectCatalog.listProjectsForPrompt())
  }

  setActiveProject(projectId: string | null): void {
    this.activeProjectId = projectId
  }

  setGenerationModel(model: 'ollama' | 'groq'): void {
    this.llmOrchestrator.setGenerationModel(model)
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

  async processTranscript(transcript: string, source: TranscriptSource = 'stt'): Promise<void> {
    const normalized = transcript.trim().toLowerCase()

    // Spoken remarks with nothing to answer ("Okay, great.") are dropped here,
    // before the queue: in the single queue slot they would otherwise replace
    // a real question waiting behind the current answer. Typed input is
    // always answered -- the user typed it on purpose.
    if (source === 'stt' && isChitChat(transcript)) {
      console.log('[route-skip] chit-chat', JSON.stringify({ transcript: transcript.slice(0, 80) }))
      return
    }

    if (this.isProcessing && this.lastProcessedTranscript &&
        isSimilarTranscript(this.lastProcessedTranscript, normalized)) {
      return
    }
    if (!this.window) return

    // A spoken question never cancels the answer already streaming: aborting
    // mid-stream sends ANSWER_RESET with no ANSWER_DONE, so the partial answer
    // vanishes without ever entering history. Queue it and run it when the
    // current answer finishes. Typed input still pre-empts, because a person
    // typing is deliberately overriding what is on screen.
    if (this.isProcessing && source === 'stt') {
      this.queuedTranscript = transcript
      return
    }

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

    // Adopt the STT-side marks (T0-T3) recorded before a genId existed.
    latencyTracer.adoptStt(genId)
    latencyTracer.mark(genId, 'T4')

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
      } else if (
        detection.id === null &&
        (RouterService.referencesActiveProject(routeResult.refined_query) ||
          RouterService.referencesActiveProject(transcript))
      ) {
        // Pronominal reference ("explain this project architecture") names no
        // keyword, so detection sees nothing and heuristic routing classifies
        // it as system_design/general — the model then answers with no
        // [PROJECT CONTEXT] and hallucinates. Force the pinned project; when
        // nothing is pinned, project_specific routes to the clarify block
        // instead of an invented answer.
        routeResult = { ...routeResult, category: 'project_specific' }
      }

      const routedNonCatalogProject =
        routeResult.project_id && !this.projectCatalog.has(routeResult.project_id)
      const isProjectQuery = RouterService.shouldInjectProjectContext(
        detection,
        routeResult.category,
        Boolean(routedNonCatalogProject)
      )

      let contextTexts: string[] = []
      let needsProjectSelection = false
      let promptQuery = routeResult.refined_query

      if (isProjectQuery) {
        const projectId = resolved.projectId ?? routeResult.project_id
        const block = projectId && this.projectCatalog.has(projectId)
          ? this.projectCatalog.getPromptBlock(projectId)
          : undefined
        if (block) {
          contextTexts = [block]
          // "Explain that project" / "the selected project" does not tell the
          // local model which project is meant: with the block injected it
          // still asked "which project is it?" in 3/3 runs. Naming the
          // project in the question turn fixed that (3/3 answered).
          const title = this.projectCatalog.getById(projectId!)?.title
          if (title) promptQuery = `${promptQuery} (Project: ${title})`
          // A named project's facts belong in the project template. Routed by
          // keyword to system_design instead, the mandated "## Database"
          // section made the model invent databases for the project
          // (MongoDB/PostgreSQL in 5/5 bench runs of one question). The
          // behavioral STAR template stays: it is grounded in the context too.
          if (routeResult.category === 'coding' || routeResult.category === 'system_design' || routeResult.category === 'general') {
            routeResult = { ...routeResult, category: 'project_specific' }
          }
        } else if (projectId && !this.projectCatalog.has(projectId)) {
          const fallbackDocs = speculativeProjectId === projectId && speculativeDocs.length > 0
            ? speculativeDocs
            : await this.retrievalService.retrieve(routeResult.refined_query, projectId)
          contextTexts = fallbackDocs.map((d) => d.text)
        } else if (routeResult.category === 'project_specific') {
          // A question about "your project" with nothing pinned or named.
          // The model was asked to reply with a fixed sentence here and did
          // so in only 3/5 measured runs (the others invented a project), so
          // the reply is now deterministic.
          needsProjectSelection = true
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

      if (needsProjectSelection) {
        this.respondWithoutModel(transcript, NO_PROJECT_MESSAGE, genId)
        return
      }

      const { systemExtra, turns } = await this.contextService.buildPrompt(
        promptQuery,
        contextTexts
      )

      await this.generateAndStream(
        routeResult,
        systemExtra,
        turns,
        transcript,
        abort.signal,
        genId,
        contextTexts.length > 0
      )

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      this.window?.webContents.send(IPC.ANSWER_ERROR, describeError(err))
    } finally {
      if (this.tokenBatcher.isActive(genId)) {
        this.isProcessing = false
        this.lastProcessedTranscript = null
        this.sendStatus('idle')
        this.drainQueuedTranscript()
      }
    }
  }

  /** Runs a question that arrived while an answer was still streaming. */
  private drainQueuedTranscript(): void {
    const queued = this.queuedTranscript
    this.queuedTranscript = null
    if (!queued) return
    void this.processTranscript(queued, 'stt')
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

  /** Shows a fixed reply through the normal answer channel, without the LLM. */
  private respondWithoutModel(transcript: string, text: string, genId: number): void {
    if (!this.window || !this.tokenBatcher.isActive(genId)) return
    this.window.webContents.send(IPC.ANSWER_RESET)
    this.window.webContents.send(IPC.TRANSCRIPT_FINAL, transcript)
    this.pushToken(text, genId)
    this.flushTokenBuffer(genId)
    this.window.webContents.send(IPC.ANSWER_DONE, { question: transcript })
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
    genId = 0,
    grounded = false
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

    // Format reminder on the final user turn + an assistant prefill opening
    // the first mandated heading (see formatReminder in SystemPrompts) --
    // except for answers grounded in [PROJECT CONTEXT]. Forcing every
    // project section ("## Architecture & Tech Stack", ...) made the local
    // model fill them with invented technology: 14/40 project answers named
    // tech absent from the context with forcing, 0/40 without (bench prompt
    // experiment, temperature 0.3). For the candidate's own work, correct
    // facts outweigh the heading format.
    const category = SYSTEM_PROMPTS[route.category] ? route.category : 'general'
    const prefill = grounded ? '' : answerPrefill(category)
    const last = turns[turns.length - 1]
    const messages: { role: string; content: string }[] = grounded
      ? [{ role: 'system', content: systemPrompt }, ...turns]
      : [
          { role: 'system', content: systemPrompt },
          ...turns.slice(0, -1),
          { ...last, content: last.content + formatReminder(category) },
          { role: 'assistant', content: prefill }
        ]

    this.window.webContents.send(IPC.ANSWER_RESET)
    this.window.webContents.send(IPC.TRANSCRIPT_FINAL, transcript)

    latencyTracer.mark(genId, 'T5')

    const gen = this.llmOrchestrator.getGenerationChain().generate({
      model: route.category,
      messages,
      stream: true,
      maxTokens: this.maxTokens,
      temperature: grounded ? this.groundedTemperature : this.temperature,
      signal
    })

    // Defense-in-depth: strip prompt markers / history / question echoes the
    // model might reproduce (primary defense is the multi-turn prompt shape).
    const sanitizer = new AnswerSanitizer({ refinedQuery: route.refined_query, skipLeadingLine: prefill })

    let fullAnswer = ''
    let seenFirstToken = false
    const emitLine = (line: string): void => {
      // The prefilled heading is shown together with the model's first real
      // output, so "first visible token" still measures the model.
      if (!fullAnswer) line = prefill + line
      fullAnswer += line
      this.pushToken(line, genId)
    }

    for await (const token of gen) {
      if (signal?.aborted || !this.tokenBatcher.isActive(genId)) {
        return fullAnswer
      }
      if (!seenFirstToken) {
        seenFirstToken = true
        latencyTracer.mark(genId, 'T6')
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

    const report = latencyTracer.report(genId)
    if (report) {
      console.log(latencyTracer.formatReport(report))
      this.window.webContents.send(IPC.LATENCY_REPORT, {
        genId: report.genId,
        deltas: report.deltas
      })
    }

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
