// Tracks A (STT accuracy) and B (transcription latency / segmentation).
//
// Two modes, so recognition errors and segmentation errors stay separable:
//  - model:    each question's audio slice goes straight to the production
//              WhisperServerProvider (recognition only);
//  - pipeline: whole clips are replayed in real time through the production
//              AudioService (VAD worker -> whisper -> filter -> continuation hold).
//
// Audio comes from a manifest (see bench/README.md). Default: your recordings
// at bench/audio/local/manifest.json if present, else the synthetic TTS set.
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

import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { ipcMain } from './lib/electronStub'
import { loadManifest, matchCommits } from './lib/manifest'
import { FakeWindow } from './lib/fakeWindow'
import { HttpTap, TappedCall } from './lib/httpTap'
import { captureConsole, createRunDir, out, ConsoleCapture, RunDir } from './lib/report'
import { ResourceSampler, ResourceReport } from './lib/resources'
import { evalSttConfig, checkConfigDrift, EvalSttConfig } from './lib/sttConfig'
import { loadPcm16, SAMPLE_RATE, msToSamples } from './lib/wav'
import { accuracy, termRecall, leadInKept } from './lib/textMetrics'
import { replayRealtime, waitFor } from './lib/replay'
import { summarize, rate, fmt } from './lib/stats'
import { AudioService } from '../src/main/audio/AudioService'
import { WhisperServerProvider } from '../src/main/stt/WhisperServerProvider'
import { resolveSttLanguage } from '../src/main/stt/SttService'
import { cleanTranscript } from '../src/main/stt/transcriptFilter'
import { latencyTracer } from '../src/main/telemetry/LatencyTracer'

type Priv = { busy: boolean; buffer: Buffer[]; pendingBuffer: Buffer[] }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const toBuffer = (pcm: Int16Array): Buffer => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)

interface ModelResult {
  itemId: string
  qIndex: number
  scenario: string
  accent: string
  speaker: string
  language: string
  condition: string
  reference: string
  hypothesis: string
  filteredHypothesis: string | null
  audioMs: number
  inferenceMs: number[]
  wer: number | null
  cer: number | null
  scriptMismatch: boolean
  termsFound: string[]
  termsMissed: string[]
  leadInKept: boolean | null
}

interface PipelineQuestion {
  itemId: string
  qIndex: number
  scenario: string
  pauseMs: number | null
  reference: string
  commits: string[]
  hypothesis: string
  wer: number | null
  vadCloseMs: number | null
  endpointMs: number | null
  outcome: 'one-commit' | 'split' | 'merged' | 'missed'
}

interface PipelineItem {
  itemId: string
  scenario: string
  speechStarts: number
  commits: { text: string; t: number; onStop: boolean }[]
  whisperCalls: number
  whisperMs: number[]
}

describe('speech-to-text (tracks A & B)', () => {
  let run: RunDir
  let capture: ConsoleCapture
  let cfg: EvalSttConfig
  let manifestInfo: ReturnType<typeof loadManifest>
  const tap = new HttpTap()
  let direct: WhisperServerProvider | null = null
  let audio: AudioService | null = null

  beforeAll(() => {
    run = createRunDir('stt')
    capture = captureConsole(`${run.dir}/app.log`)
    tap.install()
    cfg = evalSttConfig()
    manifestInfo = loadManifest()
  })

  afterAll(() => {
    audio?.destroy()
    direct?.stop()
    tap.uninstall()
    capture?.restore()
  })

  it('measures recognition (model) and segmentation (pipeline)', async () => {
    const { manifest, path: manifestPath } = manifestInfo
    const baseDir = dirname(manifestPath)
    const c = cfg.config
    const drift = checkConfigDrift()
    // The direct (model-level) server is the first engine the app would try.
    const directBinary = (c.whisperCudaServerBinaryPath ?? c.whisperVulkanServerBinaryPath ?? c.whisperServerBinaryPath)!
    const directName = c.whisperCudaServerBinaryPath ? 'whisper-server-cuda' : c.whisperVulkanServerBinaryPath ? 'whisper-server-vulkan' : 'whisper-server'
    for (const bin of [directBinary, c.whisperModelPath!]) {
      expect(existsSync(bin), `missing ${bin}`).toBe(true)
    }

    const sampler = new ResourceSampler()
    sampler.start()

    // ---- model level ------------------------------------------------------
    direct = new WhisperServerProvider({
      modelPath: c.whisperModelPath!,
      name: directName,
      binaryPath: directBinary,
      preferDiscreteGpu: directName === 'whisper-server-vulkan',
      host: c.whisperServerHost,
      port: c.whisperServerPort,
      language: resolveSttLanguage(c),
      initialPrompt: c.whisperInitialPrompt,
      noSpeechThreshold: c.whisperNoSpeechThreshold
    })
    direct.on('error', (e) => out(`whisper error: ${e.message}`))
    await direct.start()
    const p = direct as unknown as Priv

    async function transcribe(pcm: Int16Array): Promise<{ text: string; calls: TappedCall[] }> {
      const texts: string[] = []
      const onT = (t: string): void => { texts.push(t) }
      direct!.on('transcript', onT)
      const t0 = performance.now()
      direct!.feedAudioChunk(toBuffer(pcm))
      direct!.finalize()
      await waitFor(() => !p.busy && p.buffer.length === 0 && p.pendingBuffer.length === 0, 180_000)
      await sleep(5)
      direct!.off('transcript', onT)
      return { text: texts.join(' ').trim(), calls: tap.callsSince(t0, 'whisper-inference') }
    }

    // Warm-up: first inference after model load is slower and not representative.
    await transcribe(loadPcm16(join(baseDir, manifest.items[0].file)).slice(0, SAMPLE_RATE * 2))

    const model: ModelResult[] = []
    for (const item of manifest.items) {
      const pcm = loadPcm16(join(baseDir, item.file))
      const regions = item.questions.length
        ? item.questions.map((q) =>
            q.startMs !== undefined && q.endMs !== undefined
              // What an ideal VAD would hand whisper: pre-roll + speech + hangover.
              ? pcm.slice(Math.max(0, msToSamples(q.startMs - (c.vadPreRollMs ?? 300))), msToSamples(q.endMs + (c.vadHangoverMs ?? 350)))
              : pcm)
        : [pcm]
      for (const [qi, region] of regions.entries()) {
        const q = item.questions[qi]
        const { text, calls } = await transcribe(region)
        const ref = q?.reference ?? ''
        const acc = accuracy(ref, text)
        const terms = termRecall(q?.terms ?? [], text)
        model.push({
          itemId: item.id,
          qIndex: qi,
          scenario: item.scenario ?? 'single',
          accent: item.accent ?? 'unknown',
          speaker: item.speaker ?? 'unknown',
          language: item.language,
          condition: item.condition ?? 'unknown',
          reference: ref,
          hypothesis: text,
          filteredHypothesis: text ? cleanTranscript(text) : null,
          audioMs: Math.round((region.length / SAMPLE_RATE) * 1000),
          inferenceMs: calls.map((x) => Math.round((x.endedAt ?? x.startedAt) - x.startedAt)),
          wer: q ? acc.wer : null,
          cer: q ? acc.cer : null,
          scriptMismatch: acc.scriptMismatch,
          termsFound: terms.found,
          termsMissed: terms.missed,
          leadInKept: q ? leadInKept(ref, text) : null
        })
      }
    }
    out(`  model level: ${model.length} transcriptions`)

    // ---- pipeline level ---------------------------------------------------
    const window = new FakeWindow()
    audio = new AudioService(c, process.env.STT_DEBUG === '1' || process.env.STT_DEBUG === 'true')
    audio.setWindow(window.asBrowserWindow())
    const commits: { text: string; t: number; onStop: boolean }[] = []
    let stopping = false
    audio.setOnFinalTranscript((text) => { commits.push({ text, t: performance.now(), onStop: stopping }) })
    let speechStarts = 0
    audio.setOnSpeechStart(() => { speechStarts++ })
    const segmentMarks: { t0: number; t1: number }[] = []
    const realBegin = latencyTracer.beginSegment.bind(latencyTracer)
    latencyTracer.beginSegment = (t0: number, t1: number) => {
      segmentMarks.push({ t0, t1 })
      realBegin(t0, t1)
    }
    await audio.initStt()
    const engineStatus = window.events.filter((e) => e.channel === 'stt:status').map((e) => e.args[0])
    const audioPriv = audio as unknown as { workerReady: boolean; segments?: Buffer[] }

    const pipeline: PipelineItem[] = []
    const pipelineQuestions: PipelineQuestion[] = []
    const pipelineItemsWer: { reference: string; hypothesis: string }[] = []
    const retainedBeforeStop: number[] = []
    // --stt-mode=model skips the real-time replay (recognition comparisons only).
    const pipelineItems = process.env.EVAL_STT_MODE === 'model' ? [] : manifest.items
    for (const item of pipelineItems) {
      const pcm = loadPcm16(join(baseDir, item.file))
      const firstCommit = commits.length
      const firstSeg = segmentMarks.length
      const startsBefore = speechStarts
      stopping = false
      ipcMain.emit('audio:start')
      await waitFor(() => audioPriv.workerReady, 10_000)
      const tStream = performance.now()
      const timing = await replayRealtime(ipcMain, pcm)
      const lastActivity = (): number =>
        Math.max(
          commits.at(-1)?.t ?? 0,
          segmentMarks.at(-1)?.t1 ?? 0,
          ...tap.callsSince(tStream, 'whisper-inference').map((x) => x.endedAt ?? performance.now())
        )
      await waitFor(() => tap.inFlight('whisper-inference') === 0 && performance.now() - lastActivity() > 1500, 120_000, 100)
      // AudioService.segments is only cleared when a capture starts, so this
      // is what one capture session has accumulated (and never read).
      retainedBeforeStop.push((audioPriv.segments ?? []).reduce((s, b) => s + b.length, 0))
      stopping = true
      ipcMain.emit('audio:stop')
      await sleep(50)

      const itemCommits = commits.slice(firstCommit)
      const segs = segmentMarks.slice(firstSeg)
      const calls = tap.callsSince(tStream, 'whisper-inference')
      pipeline.push({
        itemId: item.id,
        scenario: item.scenario ?? 'single',
        speechStarts: speechStarts - startsBefore,
        commits: itemCommits,
        whisperCalls: calls.length,
        whisperMs: calls.map((x) => Math.round((x.endedAt ?? x.startedAt) - x.startedAt))
      })

      // Commits are matched to questions by text, not time: when STT is slower
      // than the gap between questions, a commit can land after later
      // questions have ended, or cover several of them at once.
      const ends = item.questions.map((q) => (q.endMs !== undefined ? timing.wallAt(q.endMs) : null))
      const match = matchCommits(item.questions.map((q) => q.reference), itemCommits.map((x) => x.text))
      item.questions.forEach((q, qi) => {
        const own = match.assigned[qi].map((ci) => itemCommits[ci])
        const covering = match.covering[qi].map((ci) => itemCommits[ci])
        const completing = [...own, ...covering].sort((a, b) => a.t - b.t).at(-1)
        const merged = own.length <= 1 && covering.some((cm) => match.coversOthers(itemCommits.indexOf(cm), qi))
        const end = ends[qi]
        const seg = end === null ? null : segs.find((s) => s.t1 >= end)
        pipelineQuestions.push({
          itemId: item.id,
          qIndex: qi,
          scenario: item.scenario ?? 'single',
          pauseMs: item.pauseMs ?? null,
          reference: q.reference,
          commits: own.map((x) => x.text),
          hypothesis: own.map((x) => x.text).join(' '),
          wer: accuracy(q.reference, own.map((x) => x.text).join(' ')).wer,
          vadCloseMs: seg && end !== null ? Math.round(seg.t1 - end) : null,
          endpointMs: completing && end !== null ? Math.round(completing.t - end) : null,
          outcome: !completing ? 'missed' : merged ? 'merged' : own.length > 1 ? 'split' : 'one-commit'
        })
      })
      pipelineItemsWer.push({
        reference: item.questions.map((q) => q.reference).join(' '),
        hypothesis: itemCommits.map((x) => x.text).join(' ')
      })
    }
    const speechMsReplayed = manifest.items.reduce(
      (s, i) => s + i.questions.reduce((q, x) => q + (x.endMs !== undefined && x.startMs !== undefined ? x.endMs - x.startMs : 0), 0),
      0
    )
    const leak = {
      perCaptureBytes: retainedBeforeStop,
      totalBytes: retainedBeforeStop.reduce((s, v) => s + v, 0),
      speechMsReplayed
    }
    latencyTracer.beginSegment = realBegin
    const resources = sampler.stop()
    out(`  pipeline level: ${pipeline.length} clips replayed`)

    expect(model.length).toBeGreaterThan(0)
    const meta = {
      manifest: manifestPath,
      source: manifest.source,
      representative: manifest.representative,
      engine: cfg.engine,
      provenance: cfg.provenance,
      model: c.whisperModelPath,
      serverBinary: directBinary,
      cpuFallbackBinary: c.whisperServerBinaryPath,
      sttPrompt: c.whisperInitialPrompt,
      engineStatus,
      configDrift: drift
    }
    run.writeJson('results.json', { meta, model, pipeline, pipelineQuestions, pipelineItemsWer, leak, resources })
    const md = renderSummary(meta, model, pipeline, pipelineQuestions, pipelineItemsWer, leak, resources)
    run.writeText('summary.md', md)
    out(md)
    out(`\nResults: ${run.dir}`)
  })
})

function renderSummary(
  meta: Record<string, unknown>,
  model: ModelResult[],
  pipeline: PipelineItem[],
  pq: PipelineQuestion[],
  itemsWer: { reference: string; hypothesis: string }[],
  leak: { perCaptureBytes: number[]; totalBytes: number; speechMsReplayed: number },
  resources: ResourceReport
): string {
  const L: string[] = []
  const speech = model.filter((m) => m.reference)
  const nonSpeech = model.filter((m) => !m.reference)
  const pooledWer = (xs: { reference: string; hypothesis: string }[]): string => {
    let errs = 0
    let n = 0
    for (const x of xs) {
      const a = accuracy(x.reference, x.hypothesis)
      errs += a.counts.substitutions + a.counts.deletions + a.counts.insertions
      n += a.counts.refLength
    }
    return n ? `${((errs / n) * 100).toFixed(1)}%` : 'n/a'
  }
  L.push('# Tracks A & B — speech-to-text baseline', '')
  if (!meta.representative) {
    L.push('> **Synthetic TTS audio — NOT an accuracy baseline.** References are exact, but clean TTS speech does not represent real interview audio. Use these numbers to validate the pipeline and for latency/segmentation only.', '')
  }
  L.push(`Engine: **${meta.engine}** (${(meta.provenance as Record<string, string>).engine}) · model: \`${String(meta.model).split(/[\\/]/).pop()}\` · STT prompt from ${(meta.provenance as Record<string, string>).sttPrompt} · capture: ${process.env.EVAL_CAPTURE ? `48 kHz renderer path, ${process.env.EVAL_CAPTURE} resampler` : '16 kHz direct (ffmpeg; renderer resampler not modelled)'}`, '')
  L.push(`Config drift vs src/main/index.ts: ${(meta.configDrift as string[]).length ? '**' + (meta.configDrift as string[]).join('; ') + '**' : 'none'}`, '')

  L.push('## Track A — recognition (model level: one slice per question)', '', '| Slice | n | WER (pooled) | Lead-in kept | Term recall |', '|---|---|---|---|---|')
  const groups: [string, ModelResult[]][] = [['all speech', speech]]
  for (const key of ['accent', 'speaker', 'scenario', 'language', 'condition'] as const) {
    for (const v of [...new Set(speech.map((m) => m[key]))]) groups.push([`${key}=${v}`, speech.filter((m) => m[key] === v)])
  }
  for (const [label, xs] of groups) {
    const lead = xs.filter((x) => x.leadInKept !== null)
    const found = xs.reduce((s, x) => s + x.termsFound.length, 0)
    const total = xs.reduce((s, x) => s + x.termsFound.length + x.termsMissed.length, 0)
    L.push(`| ${label} | ${xs.length} | ${pooledWer(xs)} | ${rate(lead.filter((x) => x.leadInKept).length, lead.length)} | ${rate(found, total)} |`)
  }
  const mism = speech.filter((m) => m.scriptMismatch).length
  if (mism) L.push('', `Script mismatch (reference vs output script) on ${mism} slices — WER not meaningful there.`)
  L.push('', `Non-speech clips producing a raw transcript: ${rate(nonSpeech.filter((m) => m.hypothesis).length, nonSpeech.length)}; after the app's transcript filter: ${rate(nonSpeech.filter((m) => m.filteredHypothesis).length, nonSpeech.length)}`)
  const worst = [...speech].sort((a, b) => (b.wer ?? 0) - (a.wer ?? 0)).filter((m) => (m.wer ?? 0) > 0).slice(0, 8)
  if (worst.length) {
    L.push('', '| Worst slices | WER | reference | hypothesis |', '|---|---|---|---|')
    for (const w of worst) L.push(`| ${w.itemId}#${w.qIndex} | ${((w.wer ?? 0) * 100).toFixed(0)}% | ${w.reference} | ${w.hypothesis || '(empty)'} |`)
  }

  L.push('', '## Track B — transcription latency & segmentation', '', '| Metric | Result |', '|---|---|')
  const rtf = speech.flatMap((m) => (m.inferenceMs.length ? [m.inferenceMs.reduce((s, v) => s + v, 0) / m.audioMs] : []))
  L.push(`| Whisper inference per question slice | ${fmt(summarize(speech.map((m) => m.inferenceMs.reduce((s, v) => s + v, 0))))} |`)
  L.push(`| Real-time factor (inference ÷ audio) | ${fmt(summarize(rtf), '×')} |`)
  L.push(`| Pipeline: speech end → VAD segment close | ${fmt(summarize(pq.map((q) => q.vadCloseMs)))} |`)
  L.push(`| Pipeline: speech end → transcript committed to orchestrator | ${fmt(summarize(pq.map((q) => q.endpointMs)))} |`)
  L.push(`| Pipeline WER (all commits vs all references per clip) | ${pooledWer(itemsWer.filter((x) => x.reference))} |`)
  L.push(`| Time to first partial transcript | not applicable (whisper-server path emits finals only) |`)
  L.push('', '| Scenario | questions | one commit | split (premature commit) | merged with another question | missed | endpoint median |', '|---|---|---|---|---|---|---|')
  const scen = new Map<string, PipelineQuestion[]>()
  for (const q of pq) {
    const k = q.pauseMs !== null ? `${q.scenario} ${q.pauseMs}ms` : q.scenario
    scen.set(k, [...(scen.get(k) ?? []), q])
  }
  for (const [k, xs] of scen) {
    const share = (o: PipelineQuestion['outcome']): string => rate(xs.filter((x) => x.outcome === o).length, xs.length)
    L.push(`| ${k} | ${xs.length} | ${share('one-commit')} | ${share('split')} | ${share('merged')} | ${share('missed')} | ${summarize(xs.map((x) => x.endpointMs))?.median ?? '—'} ms |`)
  }
  const ns = pipeline.filter((p) => p.scenario === 'non-speech')
  L.push('', `Non-speech clips: VAD speech onsets ${ns.reduce((s, p) => s + p.speechStarts, 0)} across ${ns.length} clips; transcripts committed ${ns.reduce((s, p) => s + p.commits.length, 0)}.`)
  L.push(`Commits only released by audio:stop (would otherwise wait for more speech): ${pipeline.reduce((s, p) => s + p.commits.filter((c) => c.onStop).length, 0)}.`)
  const kbPerSpeechSecond = leak.speechMsReplayed ? leak.totalBytes / 1024 / (leak.speechMsReplayed / 1000) : 0
  L.push(
    `AudioService.segments (never read; cleared only when a capture starts): ${(leak.totalBytes / 1024).toFixed(0)} KB held across ` +
      `${leak.perCaptureBytes.length} captures ≈ ${kbPerSpeechSecond.toFixed(0)} KB per second of speech, ` +
      `≈ ${((kbPerSpeechSecond * 3600) / 1024).toFixed(0)} MB per hour of speech in one capture session.`
  )

  L.push('', '## Resources (whole suite)', '', '| Metric | Result |', '|---|---|')
  L.push(`| GPU memory used | ${fmt(resources.gpu?.memoryUsedMB ?? null, ' MB')} of ${resources.gpu?.totalMB ?? '?'} MB |`)
  L.push(`| GPU utilisation | ${fmt(resources.gpu?.utilizationPct ?? null, '%')} |`)
  for (const p of resources.processes) L.push(`| ${p.name}: peak working set / avg CPU cores | ${p.peakWorkingSetMB} MB / ${p.avgCpuCores ?? 'n/a'} |`)
  return L.join('\n')
}
