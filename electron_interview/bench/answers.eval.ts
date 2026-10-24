// Track E -- answer quality, plus the LLM half of end-to-end latency, through
// the real Orchestrator -> ProviderChain -> Ollama path with production
// defaults (no model, prompt or parameter overrides).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('electron', async () => {
  const m = await import('./lib/electronStub')
  return { ...m.electronModule, default: m.electronModule }
})

import fixture from './fixtures/answer-questions.json'
import { createAnswerPath, injectedContext, ollamaPreflight, AnswerPath } from './lib/harness'
import { HttpTap, TappedCall } from './lib/httpTap'
import { captureConsole, createRunDir, out, routeLogs, ConsoleCapture, RunDir } from './lib/report'
import { ResourceSampler, ResourceReport } from './lib/resources'
import { checkAnswer, AnswerChecks } from './lib/answerMetrics'
import { NO_PROJECT_MESSAGE } from '../src/main/orchestrator/SystemPrompts'
import { summarize, rate, fmt } from './lib/stats'
import { waitFor } from './lib/replay'

const RUNS = Math.max(1, Number(process.env.EVAL_RUNS) || 5)

interface AnswerRun {
  questionId: string
  run: number
  question: string
  pinned: string | null
  category: string | null
  context: string | null
  answer: string
  error: string | null
  completed: boolean
  submitToFirstTokenMs: number | null
  submitToDoneMs: number | null
  tracerDeltas: Record<string, number> | null
  requestedMaxTokens: number | null
  requestedTemperature: number | null
  sentOptions: boolean | null
  promptChars: number | null
  promptMessages: number | null
  ollama: TappedCall['stats'] | null
  tokensPerSecond: number | null
  checks: AnswerChecks
  expectClarify: boolean
  /** Provider that produced the answer; differs from the selected model after a fallback. */
  answeredBy: string
  fallbackReason: string | null
  /** --model=groq: times this run was re-asked after a 429 hold (fixed questions only). */
  rateLimitRetries: number
}

const SELECTED_MODEL = process.env.EVAL_MODEL === 'groq' ? 'groq' : 'ollama'
const MAX_RATE_LIMIT_RETRIES = 3

describe('answer quality (track E)', () => {
  let path: AnswerPath
  let run: RunDir
  let capture: ConsoleCapture
  const tap = new HttpTap()
  let preflight: Awaited<ReturnType<typeof ollamaPreflight>>

  beforeAll(async () => {
    run = createRunDir('answers')
    preflight = await ollamaPreflight()
    if (!preflight.ok) return
    capture = captureConsole(`${run.dir}/app.log`)
    tap.install()
    path = await createAnswerPath('real')
    // initialize() fires model preloads in the background; let them land so
    // they do not contend with the first measured question.
    await waitFor(() => tap.inFlight() === 0, 180_000, 200)
  })

  afterAll(() => {
    path?.dispose()
    tap.uninstall()
    capture?.restore()
  })

  /**
   * Free-tier Groq returns 429 once questions are fired back to back. A fixed
   * question is re-asked after the provider's Retry-After hold so the scores
   * measure Groq, not Ollama answering for it. The session keeps the first
   * outcome: re-asking would duplicate history, and its fallbacks are the
   * realistic-pace measurement.
   */
  async function askScored(...args: Parameters<typeof askOnce>): Promise<AnswerRun> {
    let res = await askOnce(...args)
    let retries = 0
    while (SELECTED_MODEL === 'groq' && /rate-limited/.test(res.fallbackReason ?? '') && retries < MAX_RATE_LIMIT_RETRIES) {
      const hold = path.llm.getGenerationChain().getProviders()[0].circuitBreaker.holdRemainingMs()
      await new Promise((r) => setTimeout(r, hold + 250))
      retries++
      res = await askOnce(...args)
    }
    return { ...res, rateLimitRetries: retries }
  }

  async function askOnce(
    questionId: string,
    runIndex: number,
    text: string,
    pinned: string | null,
    opts: { fresh: boolean; expectMentions?: string[]; expectClarify?: boolean }
  ): Promise<AnswerRun> {
    if (opts.fresh) await path.orchestrator.startInterview('answer eval')
    path.orchestrator.setActiveProject(pinned)
    const evIdx = path.window.events.length
    const reqIdx = path.requests.length
    const t0 = performance.now()
    await path.orchestrator.processTranscript(text, 'user')
    await waitFor(() => tap.inFlight('ollama-chat') === 0, 10_000)

    const events = path.window.since(evIdx)
    const tokens = events.filter((e) => e.channel === 'answer:token')
    const done = events.find((e) => e.channel === 'answer:done')
    const error = events.find((e) => e.channel === 'answer:error')
    const report = events.find((e) => e.channel === 'latency:report')
    const fallback = events.find((e) => e.channel === 'answer:fallback')?.args[0] as { to?: string; reason?: string } | undefined
    const route = routeLogs(capture, t0).at(-1)
    const req = path.requests[reqIdx] ?? null
    const call = tap.callsSince(t0).find((c) => c.kind === 'ollama-chat' || c.kind === 'cloud-chat') ?? null
    const system = call?.request?.messages?.[0]?.content ?? req?.messages[0]?.content ?? ''
    const context = req ? injectedContext(system, path.catalog) : done && tokens.map((e) => String(e.args[0])).join('') === NO_PROJECT_MESSAGE ? 'clarify' : null
    const projectId = context?.startsWith('project:') ? context.slice('project:'.length) : null
    const answer = tokens.map((e) => String(e.args[0])).join('')
    const category = (route?.category as string) ?? null
    const stats = call?.stats ?? null

    return {
      questionId,
      run: runIndex,
      question: text,
      pinned,
      category,
      context,
      answer,
      error: error ? String(error.args[0]) : null,
      completed: Boolean(done),
      submitToFirstTokenMs: tokens[0] ? Math.round(tokens[0].t - t0) : null,
      submitToDoneMs: done ? Math.round(done.t - t0) : null,
      tracerDeltas: (report?.args[0] as { deltas?: Record<string, number> })?.deltas ?? null,
      requestedMaxTokens: req?.maxTokens ?? null,
      requestedTemperature: req?.temperature ?? null,
      sentOptions: call?.request ? call.request.hasOptions : null,
      promptChars: call?.request?.promptChars ?? null,
      promptMessages: call?.request?.messages?.length ?? null,
      ollama: stats,
      tokensPerSecond:
        stats?.eval_count && stats.eval_duration ? Math.round((stats.eval_count / (stats.eval_duration / 1e9)) * 10) / 10 : null,
      checks: checkAnswer(answer, {
        category: category ?? 'general',
        question: text,
        projectBlock: projectId ? path.catalog.getPromptBlock(projectId) : undefined,
        expectMentions: opts.expectMentions
      }),
      expectClarify: Boolean(opts.expectClarify),
      answeredBy: fallback?.to ?? (req ? SELECTED_MODEL : 'none'),
      fallbackReason: fallback?.reason ?? null,
      rateLimitRetries: 0
    }
  }

  it('measures answers on the fixed question set and a multi-turn session', async (ctx) => {
    if (!preflight.ok) {
      run.writeText('summary.md', `# Track E — not measured\n\n${preflight.reason}\n`)
      out(`Track E skipped: ${preflight.reason}`)
      ctx.skip()
      return
    }

    // Warm-up (discarded): first request after preload can include a model reload.
    await askOnce('warmup', 0, 'What is a hash map?', null, { fresh: true })

    const sampler = new ResourceSampler()
    sampler.start()
    const runs: AnswerRun[] = []
    const skipped: string[] = []
    for (const q of fixture.questions as { id: string; text: string; pinned: string | null; project?: string; expectClarify?: boolean }[]) {
      if ((q.project && !path.catalog.has(q.project)) || (q.pinned && !path.catalog.has(q.pinned))) {
        skipped.push(`${q.id} (project "${q.project ?? q.pinned}" not in projects.json)`)
        continue
      }
      for (let r = 1; r <= RUNS; r++) {
        runs.push(await askScored(q.id, r, q.text, q.pinned, { fresh: true, expectClarify: q.expectClarify }))
      }
      out(`  ${q.id} done (${RUNS} runs)`)
    }
    const resources = sampler.stop()

    // Multi-turn session: one interview, realistic gaps between questions.
    const sessionStart = performance.now()
    await path.orchestrator.startInterview('session eval')
    const session: (AnswerRun & { answerWindow: [number, number] })[] = []
    for (const [i, turn] of fixture.session.turns.entries()) {
      const before = performance.now()
      const res = await askOnce(`s${String(i + 1).padStart(2, '0')}`, 1, turn.text, turn.pinned ?? null, {
        fresh: false,
        expectMentions: turn.expectMentions
      })
      session.push({ ...res, answerWindow: [before, performance.now()] })
      await new Promise((r) => setTimeout(r, fixture.session.gapMs))
    }
    await waitFor(() => tap.inFlight() === 0, 60_000, 200)
    const summarizations = tap.callsSince(sessionStart, 'ollama-generate')
    const overlapping = summarizations.filter((s) =>
      session.some(({ answerWindow: [a, b] }) => s.startedAt < b && (s.endedAt ?? Infinity) > a)
    )
    const contextService = (path.orchestrator as unknown as { contextService: { summaryCache: string | null } }).contextService
    const sessionInfo = {
      turns: session.length,
      summarizationCalls: summarizations.length,
      summarizationsOverlappingAnAnswer: overlapping.length,
      summarizationOutputTokens: summarizations.map((s) => s.stats?.eval_count ?? null),
      summarizationPromptChars: summarizations.map((s) => s.request?.promptChars ?? null),
      finalSummaryChars: contextService.summaryCache?.length ?? 0,
      historyMessagesPerTurn: session.map((s) => s.promptMessages)
    }

    expect(runs.length).toBeGreaterThan(0)
    run.writeJson('results.json', { runsPerQuestion: RUNS, preflight, skipped, runs, session, sessionInfo, resources })
    run.writeText('answers-for-review.md', renderReview(runs, session))
    const md = renderSummary(runs, session, sessionInfo, resources, skipped, preflight)
    run.writeText('summary.md', md)
    out(md)
    out(`\nResults: ${run.dir}`)
  })
})

function renderSummary(
  runs: AnswerRun[],
  session: AnswerRun[],
  info: Record<string, unknown>,
  resources: ResourceReport,
  skipped: string[],
  preflight: { version?: string }
): string {
  const L: string[] = []
  const pct = (xs: AnswerRun[], f: (r: AnswerRun) => boolean): string => rate(xs.filter(f).length, xs.length)
  const completed = runs.filter((r) => r.completed)
  const answerable = completed.filter((r) => !r.expectClarify)
  L.push('# Track E — answer-quality baseline', '')
  const selected = SELECTED_MODEL === 'groq' ? `groq/${process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'} (Ollama fallback)` : 'ollama/qwen2.5-coder:1.5b'
  L.push(`Generation model ${selected}, Ollama ${preflight.version}. ${RUNS} runs per question.`, '')
  const by = (xs: AnswerRun[]): string =>
    Object.entries(xs.reduce<Record<string, number>>((m, r) => ((m[r.answeredBy] = (m[r.answeredBy] ?? 0) + 1), m), {}))
      .map(([k, n]) => `${k} ${n}/${xs.length}`)
      .join(', ')
  L.push(`Answered by: fixed questions ${by(runs)}; session ${by(session)}. 429 re-asks: ${runs.reduce((n, r) => n + r.rateLimitRetries, 0)}.`, '')
  L.push('## Quality checks (automated heuristics)', '', '| Check | Result |', '|---|---|')
  L.push(`| Completed without error | ${pct(runs, (r) => r.completed && !r.error)} |`)
  L.push(`| All mandated \`##\` headings, in order | ${pct(answerable, (r) => r.checks.headingsStrict)} |`)
  const loose = summarize(answerable.map((r) => r.checks.headingsLooseFraction * 100))
  L.push(`| Mandated headings present in any form (mean %) | ${loose ? loose.mean + '%' : 'n/a'} |`)
  L.push(`| First-person voice | ${pct(answerable, (r) => r.checks.firstPerson)} |`)
  L.push(`| Says "the candidate" | ${pct(answerable, (r) => r.checks.saysTheCandidate)} |`)
  L.push(`| Prompt-marker leak | ${pct(completed, (r) => r.checks.markerLeak)} |`)
  const proj = answerable.filter((r) => r.context?.startsWith('project:'))
  L.push(`| Project answers naming tech absent from [PROJECT CONTEXT] | ${pct(proj, (r) => r.checks.unsupportedTech.length > 0)} |`)
  const clar = completed.filter((r) => r.expectClarify)
  L.push(`| Unpinned "your project" → exact clarify message | ${pct(clar, (r) => r.checks.clarifyExact)} |`)
  L.push('', '## Length & generation parameters', '', '| Metric | Result |', '|---|---|')
  L.push(`| Output tokens (Ollama eval_count) | ${fmt(summarize(completed.map((r) => r.ollama?.eval_count)), ' tok')} |`)
  L.push(`| Answer length | ${fmt(summarize(completed.map((r) => r.checks.words)), ' words')} |`)
  L.push(`| Prompt tokens (Ollama prompt_eval_count) | ${fmt(summarize(completed.map((r) => r.ollama?.prompt_eval_count)), ' tok')} |`)
  L.push(`| Requests carrying an Ollama \`options\` object | ${pct(completed.filter((r) => r.sentOptions !== null), (r) => r.sentOptions === true)} |`)
  L.push(`| Answers longer than the requested maxTokens (${completed[0]?.requestedMaxTokens ?? '?'}) | ${pct(completed, (r) => (r.ollama?.eval_count ?? 0) > (r.requestedMaxTokens ?? Infinity))} |`)
  const reasons = new Map<string, number>()
  for (const r of completed) reasons.set(r.ollama?.done_reason ?? 'unknown', (reasons.get(r.ollama?.done_reason ?? 'unknown') ?? 0) + 1)
  L.push(`| done_reason | ${[...reasons].map(([k, v]) => `${k}: ${v}`).join(', ')} |`)
  L.push('', '## Latency (text submitted → UI IPC)', '', '| Metric | Result |', '|---|---|')
  L.push(`| Submit → first visible token | ${fmt(summarize(completed.map((r) => r.submitToFirstTokenMs)))} |`)
  L.push(`| LLM request → first token (tracer T6−T5) | ${fmt(summarize(completed.map((r) => r.tracerDeltas?.['T6-T5'])))} |`)
  L.push(`| Submit → answer complete | ${fmt(summarize(completed.map((r) => r.submitToDoneMs)))} |`)
  L.push(`| Generation speed | ${fmt(summarize(completed.map((r) => r.tokensPerSecond)), ' tok/s')} |`)
  L.push('', '## By routed category', '', '| Category | n | Headings strict | First person | Output tokens (median) | Submit→done (median) |', '|---|---|---|---|---|---|')
  for (const cat of [...new Set(answerable.map((r) => r.category ?? 'unknown'))]) {
    const xs = answerable.filter((r) => (r.category ?? 'unknown') === cat)
    L.push(`| ${cat} | ${xs.length} | ${pct(xs, (r) => r.checks.headingsStrict)} | ${pct(xs, (r) => r.checks.firstPerson)} | ${summarize(xs.map((r) => r.ollama?.eval_count))?.median ?? '—'} | ${summarize(xs.map((r) => r.submitToDoneMs))?.median ?? '—'} ms |`)
  }
  L.push('', '## Multi-turn session', '', '| Metric | Result |', '|---|---|')
  const follow = session.filter((s) => s.checks.mentionsExpected !== null)
  L.push(`| Follow-ups mentioning the earlier topic (heuristic) | ${rate(follow.filter((s) => s.checks.mentionsExpected).length, follow.length)} |`)
  for (const [k, v] of Object.entries(info)) L.push(`| ${k} | ${JSON.stringify(v)} |`)
  L.push('', '## Resources during the question set', '', '| Metric | Result |', '|---|---|')
  L.push(`| GPU memory used | ${fmt(resources.gpu?.memoryUsedMB ?? null, ' MB')} of ${resources.gpu?.totalMB ?? '?'} MB |`)
  L.push(`| GPU utilisation | ${fmt(resources.gpu?.utilizationPct ?? null, '%')} |`)
  for (const p of resources.processes) L.push(`| ${p.name}: peak working set / avg CPU cores | ${p.peakWorkingSetMB} MB / ${p.avgCpuCores ?? 'n/a'} |`)
  L.push(SELECTED_MODEL === 'groq' ? `| API cost | Groq free tier (no charge); limits: see 429 re-asks above |` : `| API cost | $0 (local Ollama; no cloud calls) |`)
  if (skipped.length) L.push('', `Skipped: ${skipped.join('; ')}`)
  return L.join('\n')
}

function renderReview(runs: AnswerRun[], session: AnswerRun[]): string {
  const L = ['# Answers for human review', '', 'Score each answer 1–5 for **relevance**, **correctness**, **conciseness for a live interview**; note any hallucination.', '']
  for (const r of [...runs, ...session]) {
    L.push(`## ${r.questionId} · run ${r.run} · ${r.category ?? '?'} · ${r.context ?? ''}`, '', `**Q:** ${r.question}${r.pinned ? ` _(pinned: ${r.pinned})_` : ''}`, '')
    L.push('Relevance: _ / Correctness: _ / Conciseness: _ / Hallucination: _', '', '```text', r.answer || `(no answer: ${r.error ?? 'empty'})`, '```', '')
  }
  return L.join('\n')
}
