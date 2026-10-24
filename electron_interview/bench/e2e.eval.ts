// Track C -- end-to-end latency: audio replayed in real time through the
// production AudioService, wired to the production Orchestrator and LLM chain
// exactly as src/main/index.ts wires them. Ground truth for "speech ended" is
// the manifest's known speech boundary, not the app's own estimate.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('electron', async () => {
  const m = await import('./lib/electronStub')
  return { ...m.electronModule, default: m.electronModule }
})
vi.mock('worker_threads', async (importOriginal) => {
  const orig = await importOriginal<typeof import('worker_threads')>()
  const { bundledAudioWorkerPath } = await import('./lib/audioWorkerBundle')
  const path = bundledAudioWorkerPath()
  class BundledWorker extends orig.Worker {
    constructor(_file: string | URL, options?: import('worker_threads').WorkerOptions) {
      super(path, options)
    }
  }
  return { ...orig, Worker: BundledWorker, default: { ...orig, Worker: BundledWorker } }
})

import { dirname, join } from 'path'
import { ipcMain } from './lib/electronStub'
import { createAnswerPath, ollamaPreflight, AnswerPath } from './lib/harness'
import { HttpTap } from './lib/httpTap'
import { loadManifest, matchCommits, ManifestItem } from './lib/manifest'
import { captureConsole, createRunDir, out, ConsoleCapture, RunDir } from './lib/report'
import { ResourceSampler } from './lib/resources'
import { evalSttConfig, checkConfigDrift } from './lib/sttConfig'
import { loadPcm16 } from './lib/wav'
import { replayRealtime, waitFor } from './lib/replay'
import { summarize, rate, fmt } from './lib/stats'
import { AudioService } from '../src/main/audio/AudioService'
import { latencyTracer } from '../src/main/telemetry/LatencyTracer'
import type { WindowEvent } from './lib/fakeWindow'

interface AnswerBlock {
  resetAt: number
  question: string | null
  firstTokenAt: number | null
  doneAt: number | null
  deltas: Record<string, number> | null
}

interface QuestionResult {
  itemId: string
  qIndex: number
  scenario: string
  reference: string
  answeredAs: string | null
  outcome: 'answered' | 'answered-merged' | 'not-answered'
  speechEndToCommitMs: number | null
  speechEndToFirstTokenMs: number | null
  speechEndToDoneMs: number | null
  commitToFirstTokenMs: number | null
  queuedMs: number | null
  tracerT0ErrorMs: number | null
  tracerDeltas: Record<string, number> | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function answerBlocks(events: WindowEvent[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = []
  let cur: AnswerBlock | null = null
  for (const e of events) {
    if (e.channel === 'answer:reset') {
      cur = { resetAt: e.t, question: null, firstTokenAt: null, doneAt: null, deltas: null }
      blocks.push(cur)
    } else if (!cur) {
      continue
    } else if (e.channel === 'transcript:final' && cur.question === null && e.t - cur.resetAt < 50) {
      cur.question = String(e.args[0])
    } else if (e.channel === 'answer:token' && cur.firstTokenAt === null) {
      cur.firstTokenAt = e.t
    } else if (e.channel === 'answer:done') {
      cur.doneAt = e.t
    } else if (e.channel === 'latency:report' && cur.deltas === null) {
      cur.deltas = (e.args[0] as { deltas: Record<string, number> }).deltas
    }
  }
  return blocks
}

describe('end-to-end latency (track C)', () => {
  let run: RunDir
  let capture: ConsoleCapture
  let path: AnswerPath | null = null
  let audio: AudioService | null = null
  const tap = new HttpTap()
  let preflight: Awaited<ReturnType<typeof ollamaPreflight>>

  beforeAll(async () => {
    run = createRunDir('e2e')
    preflight = await ollamaPreflight()
    if (!preflight.ok) return
    capture = captureConsole(`${run.dir}/app.log`)
    tap.install()
    path = await createAnswerPath('real')
    await waitFor(() => tap.inFlight() === 0, 180_000, 200)
  })

  afterAll(() => {
    audio?.destroy()
    path?.dispose()
    tap.uninstall()
    capture?.restore()
  })

  it('measures speech end -> first visible token -> answer complete', async (ctx) => {
    if (!preflight.ok || !path) {
      run.writeText('summary.md', `# Track C — not measured\n\n${preflight.reason}\n`)
      out(`Track C skipped: ${preflight.reason}`)
      ctx.skip()
      return
    }
    const { manifest, path: manifestPath } = loadManifest()
    const baseDir = dirname(manifestPath)
    const limit = Number(process.env.EVAL_LIMIT) || 8
    const items: ManifestItem[] = process.env.EVAL_SCENARIOS
      ? manifest.items
      : [
          ...manifest.items.filter((i) => (i.scenario ?? 'single') === 'single').slice(0, limit),
          ...manifest.items.filter((i) => i.scenario === 'sequence')
        ]

    const cfg = evalSttConfig()
    const orchestrator = path.orchestrator
    const window = path.window
    audio = new AudioService(cfg.config, process.env.STT_DEBUG === '1' || process.env.STT_DEBUG === 'true')
    audio.setWindow(window.asBrowserWindow())
    const commits: { text: string; t: number }[] = []
    // Wired as in src/main/index.ts, plus a timestamp.
    audio.setOnFinalTranscript((text) => {
      commits.push({ text, t: performance.now() })
      void orchestrator.processTranscript(text)
    })
    audio.setOnSpeechStart(() => path!.llm.preconnect())
    const tracerReports: { stages: Record<string, number>; genId: number }[] = []
    const realReport = latencyTracer.report.bind(latencyTracer)
    latencyTracer.report = (genId: number) => {
      const r = realReport(genId)
      if (r) tracerReports.push({ genId: r.genId, stages: r.stages as Record<string, number> })
      return r
    }
    await audio.initStt()
    const audioPriv = audio as unknown as { workerReady: boolean }
    const orchPriv = orchestrator as unknown as { isProcessing: boolean; queuedTranscript: string | null }

    // Warm-up (discarded): first whisper inference and first answer after load.
    await orchestrator.processTranscript('What is a hash map?', 'user')

    const sampler = new ResourceSampler()
    sampler.start()
    const results: QuestionResult[] = []
    const dropped: string[] = []
    const timedOut: { itemId: string; stillGenerating: boolean; charsStreamed: number }[] = []
    for (const item of items) {
      await orchestrator.startInterview('e2e item')
      orchestrator.setActiveProject(null)
      const pcm = loadPcm16(join(baseDir, item.file))
      const evIdx = window.events.length
      const firstCommit = commits.length
      const firstReport = tracerReports.length
      ipcMain.emit('audio:start')
      await waitFor(() => audioPriv.workerReady, 10_000)
      const timing = await replayRealtime(ipcMain, pcm)
      const busy = (): boolean =>
        tap.inFlight('whisper-inference') > 0 || tap.inFlight('ollama-chat') > 0 || orchPriv.isProcessing || orchPriv.queuedTranscript !== null
      let quietSince = performance.now()
      const settled = await waitFor(() => {
        if (busy()) quietSince = performance.now()
        return performance.now() - quietSince > 2000
      }, 300_000, 100)
      ipcMain.emit('audio:stop')
      const drained = await waitFor(() => !busy(), 120_000, 100)
      if (!settled || !drained) {
        const streamed = window.since(evIdx).filter((e) => e.channel === 'answer:token').reduce((s, e) => s + String(e.args[0]).length, 0)
        timedOut.push({ itemId: item.id, stillGenerating: tap.inFlight('ollama-chat') > 0, charsStreamed: streamed })
      }
      await sleep(50)

      const blocks = answerBlocks(window.since(evIdx))
      const itemCommits = commits.slice(firstCommit)
      const reports = tracerReports.slice(firstReport)
      for (const cm of itemCommits) {
        if (!blocks.some((b) => b.question === cm.text)) dropped.push(cm.text)
      }
      const answered = blocks.filter((b) => b.doneAt !== null)
      const match = matchCommits(item.questions.map((q) => q.reference), answered.map((b) => b.question ?? ''))
      item.questions.forEach((q, qi) => {
        const bi = match.assigned[qi][0] ?? match.covering[qi][0]
        const block = bi !== undefined ? answered[bi] : null
        const end = q.endMs !== undefined ? timing.wallAt(q.endMs) : null
        const commit = block ? itemCommits.find((c) => c.text === block.question) : undefined
        const report = block ? reports.find((r) => r.stages.T7 !== undefined && Math.abs(r.stages.T7 - (block.firstTokenAt ?? 0)) < 50) : undefined
        const since = (t: number | null | undefined): number | null => (t != null && end !== null ? Math.round(t - end) : null)
        results.push({
          itemId: item.id,
          qIndex: qi,
          scenario: item.scenario ?? 'single',
          reference: q.reference,
          answeredAs: block?.question ?? null,
          outcome: !block ? 'not-answered' : bi !== undefined && match.coversOthers(bi, qi) ? 'answered-merged' : 'answered',
          speechEndToCommitMs: since(commit?.t),
          speechEndToFirstTokenMs: since(block?.firstTokenAt),
          speechEndToDoneMs: since(block?.doneAt),
          commitToFirstTokenMs: commit && block?.firstTokenAt ? Math.round(block.firstTokenAt - commit.t) : null,
          queuedMs: commit && block ? Math.max(0, Math.round(block.resetAt - commit.t)) : null,
          tracerT0ErrorMs: report?.stages.T0 !== undefined && end !== null ? Math.round(report.stages.T0 - end) : null,
          tracerDeltas: block?.deltas ?? null
        })
      })
      out(`  ${item.id}: ${answered.length} answers`)
    }
    const resources = sampler.stop()
    latencyTracer.report = realReport

    expect(results.length).toBeGreaterThan(0)
    const meta = {
      manifest: manifestPath,
      source: manifest.source,
      representative: manifest.representative,
      engine: cfg.engine,
      provenance: cfg.provenance,
      configDrift: checkConfigDrift(),
      ollama: preflight.version
    }
    run.writeJson('results.json', { meta, results, dropped, timedOut, resources })

    const L: string[] = ['# Track C — end-to-end latency baseline', '']
    if (!manifest.representative) L.push('> Synthetic TTS audio: valid for latency (speech boundaries are exact); not an accuracy measure.', '')
    L.push(`STT engine **${cfg.engine}** · answer model: production default (ollama/qwen2.5-coder:1.5b) · Ollama ${preflight.version}`, '')
    L.push('| Stage (from true end of speech) | Result |', '|---|---|')
    L.push(`| → transcript committed | ${fmt(summarize(results.map((r) => r.speechEndToCommitMs)))} |`)
    L.push(`| → first visible token (IPC to renderer) | ${fmt(summarize(results.map((r) => r.speechEndToFirstTokenMs)))} |`)
    L.push(`| → answer complete | ${fmt(summarize(results.map((r) => r.speechEndToDoneMs)))} |`)
    L.push(`| commit → first visible token | ${fmt(summarize(results.map((r) => r.commitToFirstTokenMs)))} |`)
    L.push(`| waited in queue behind a previous answer | ${fmt(summarize(results.map((r) => r.queuedMs).filter((v) => (v ?? 0) > 50)))} |`)
    L.push(`| renderer paint (T8) | not measured (no renderer in the harness) |`)
    L.push(`| app tracer T0 vs true end of speech | ${fmt(summarize(results.map((r) => r.tracerT0ErrorMs)))} |`)
    L.push('', '| Scenario | questions | answered | answered as part of a merged question | not answered | speech end → first token (median) |', '|---|---|---|---|---|---|')
    for (const s of [...new Set(results.map((r) => r.scenario))]) {
      const xs = results.filter((r) => r.scenario === s)
      L.push(`| ${s} | ${xs.length} | ${rate(xs.filter((x) => x.outcome === 'answered').length, xs.length)} | ${rate(xs.filter((x) => x.outcome === 'answered-merged').length, xs.length)} | ${rate(xs.filter((x) => x.outcome === 'not-answered').length, xs.length)} | ${summarize(xs.map((x) => x.speechEndToFirstTokenMs))?.median ?? '—'} ms |`)
    }
    L.push('', `Committed transcripts that never got an answer (superseded in the single-slot queue): ${dropped.length}${dropped.length ? ' — ' + dropped.map((d) => `"${d}"`).join(', ') : ''}`)
    for (const t of timedOut) {
      L.push(
        `**${t.itemId} timed out after 7 min** ${t.stillGenerating ? 'with an answer still generating' : 'without settling'} ` +
          `(${t.charsStreamed} characters streamed). Its unanswered questions are a consequence, not an STT miss.`
      )
    }
    L.push('', '| Resource | Result |', '|---|---|')
    L.push(`| GPU memory used | ${fmt(resources.gpu?.memoryUsedMB ?? null, ' MB')} of ${resources.gpu?.totalMB ?? '?'} MB |`)
    for (const p of resources.processes) L.push(`| ${p.name}: peak working set / avg CPU cores | ${p.peakWorkingSetMB} MB / ${p.avgCpuCores ?? 'n/a'} |`)
    const md = L.join('\n')
    run.writeText('summary.md', md)
    out(md)
    out(`\nResults: ${run.dir}`)
  })
})
