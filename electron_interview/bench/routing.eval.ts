// Track D -- understanding: question detection, category routing, project
// resolution and context injection, through the real Orchestrator. The LLM is
// replaced by a recorder, so this suite is deterministic and needs no models.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('electron', async () => {
  const m = await import('./lib/electronStub')
  return { ...m.electronModule, default: m.electronModule }
})

import fixture from './fixtures/routing-cases.json'
import { SYSTEM_PROMPTS, NO_PROJECT_MESSAGE } from '../src/main/orchestrator/SystemPrompts'
import { createAnswerPath, injectedContext, templateCategory, AnswerPath } from './lib/harness'
import { captureConsole, createRunDir, out, routeLogs, ConsoleCapture, RunDir } from './lib/report'
import { rate } from './lib/stats'

interface Case {
  id: string
  text: string
  pinned: string | null
  expect: { isQuestion: boolean; category?: string; context?: string }
  rationale: string
  verified: boolean
}

interface Outcome {
  id: string
  group: string
  text: string
  pinned: string | null
  expected: Case['expect']
  predicted: { isQuestion: boolean; category: string | null; context: string | null; template: string | null; refinedQuery: string | null }
  ok: { isQuestion: boolean; category: boolean | null; context: boolean | null }
}

const GROUPS: Record<string, string> = {
  g: 'general/conceptual',
  c: 'coding',
  s: 'system design',
  b: 'behavioral',
  p: 'project',
  n: 'non-question',
  h: 'Hindi/Hinglish'
}

describe('routing & understanding (track D)', () => {
  let path: AnswerPath
  let run: RunDir
  let capture: ConsoleCapture

  beforeAll(async () => {
    run = createRunDir('routing')
    capture = captureConsole(`${run.dir}/app.log`)
    path = await createAnswerPath('fake-llm')
  })

  afterAll(() => {
    path?.dispose()
    capture?.restore()
  })

  async function ask(text: string, pinned: string | null, freshInterview = true) {
    if (freshInterview) await path.orchestrator.startInterview('routing case')
    path.orchestrator.setActiveProject(pinned)
    const before = path.requests.length
    const evIdx = path.window.events.length
    const t = performance.now()
    // Interview questions arrive as speech; 'stt' is the production path.
    await path.orchestrator.processTranscript(text, 'stt')
    const req = path.requests.length > before ? path.requests[path.requests.length - 1] : null
    const route = routeLogs(capture, t).at(-1) ?? null
    // A fixed reply sent without the LLM (e.g. "no project selected").
    const events = path.window.since(evIdx)
    const directReply = !req && events.some((e) => e.channel === 'answer:done')
      ? events.filter((e) => e.channel === 'answer:token').map((e) => String(e.args[0])).join('')
      : null
    return { req, route, directReply }
  }

  it('scores every labelled case', async () => {
    const outcomes: Outcome[] = []
    for (const c of fixture.cases as Case[]) {
      const { req, route, directReply } = await ask(c.text, c.pinned)
      const system = req?.messages[0]?.content ?? ''
      const predicted = {
        isQuestion: req !== null || directReply !== null,
        category: (route?.category as string) ?? null,
        context: req ? injectedContext(system, path.catalog) : directReply === NO_PROJECT_MESSAGE ? 'clarify' : null,
        template: req ? templateCategory(system, SYSTEM_PROMPTS) : null,
        refinedQuery: (route?.refined_query as string) ?? null
      }
      const answerable = c.expect.isQuestion && predicted.isQuestion
      outcomes.push({
        id: c.id,
        group: GROUPS[c.id[0]] ?? 'other',
        text: c.text,
        pinned: c.pinned,
        expected: c.expect,
        predicted,
        ok: {
          isQuestion: predicted.isQuestion === c.expect.isQuestion,
          category: answerable ? predicted.category === c.expect.category : null,
          context: answerable ? predicted.context === c.expect.context : null
        }
      })
    }

    const sequences = []
    for (const s of fixture.sequences) {
      await path.orchestrator.startInterview('routing sequence')
      path.orchestrator.setActiveProject(null)
      let last = null
      for (const turn of s.turns) last = (await ask(turn, null, false)).req
      const history = (last?.messages ?? []).slice(1, -1).map((m) => m.content)
      sequences.push({
        id: s.id,
        turns: s.turns,
        historyTurns: history.length,
        carriesEarlierTurn: history.some((h) => h.includes(s.expectHistoryContains))
      })
    }

    // Sanity: the harness really drove the production path.
    expect(outcomes.some((o) => o.predicted.isQuestion)).toBe(true)
    expect(
      outcomes.every((o) => !o.predicted.isQuestion || o.predicted.context === 'clarify' || o.predicted.template === o.predicted.category)
    ).toBe(true)

    run.writeJson('results.json', { labelsVerified: false, outcomes, sequences })
    const md = renderMarkdown(outcomes, sequences)
    run.writeText('summary.md', md)
    out(md)
    out(`\nResults: ${run.dir}`)
  })
})

function renderMarkdown(outcomes: Outcome[], sequences: { id: string; historyTurns: number; carriesEarlierTurn: boolean }[]): string {
  const count = (pred: (o: Outcome) => boolean | null): [number, number] => {
    const scored = outcomes.map(pred).filter((v): v is boolean => v !== null)
    return [scored.filter(Boolean).length, scored.length]
  }
  const lines: string[] = []
  lines.push('# Track D — routing & understanding baseline', '')
  lines.push('> Labels are DRAFTS (verified=false). Treat accuracies as provisional until a human reviews `bench/fixtures/routing-cases.json`.', '')
  lines.push('| Metric | Result |', '|---|---|')
  lines.push(`| Question detection (answer vs ignore) | ${rate(...count((o) => o.ok.isQuestion))} |`)
  lines.push(`| Category (template) | ${rate(...count((o) => o.ok.category))} |`)
  lines.push(`| Context injection (none / clarify / project) | ${rate(...count((o) => o.ok.context))} |`)
  const nonQ = outcomes.filter((o) => !o.expected.isQuestion)
  lines.push(`| Non-questions that were answered anyway | ${rate(nonQ.filter((o) => o.predicted.isQuestion).length, nonQ.length)} |`)
  lines.push(`| Follow-ups carrying the earlier turn | ${rate(sequences.filter((s) => s.carriesEarlierTurn).length, sequences.length)} |`)
  lines.push('', '## By group', '', '| Group | Detection | Category | Context |', '|---|---|---|---|')
  for (const g of [...new Set(outcomes.map((o) => o.group))]) {
    const sub = outcomes.filter((o) => o.group === g)
    const c = (f: (o: Outcome) => boolean | null): string => {
      const v = sub.map(f).filter((x): x is boolean => x !== null)
      return rate(v.filter(Boolean).length, v.length)
    }
    lines.push(`| ${g} | ${c((o) => o.ok.isQuestion)} | ${c((o) => o.ok.category)} | ${c((o) => o.ok.context)} |`)
  }
  lines.push('', '## Mismatches', '', '| id | pinned | text | expected | got |', '|---|---|---|---|---|')
  for (const o of outcomes) {
    if (o.ok.isQuestion && o.ok.category !== false && o.ok.context !== false) continue
    const exp = o.expected.isQuestion ? `${o.expected.category} / ${o.expected.context}` : 'ignore'
    const got = o.predicted.isQuestion ? `${o.predicted.category} / ${o.predicted.context}` : 'ignored'
    lines.push(`| ${o.id} | ${o.pinned ?? '—'} | ${o.text} | ${exp} | ${got} |`)
  }
  return lines.join('\n')
}
