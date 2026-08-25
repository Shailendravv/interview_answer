export const STAGE_ORDER = [
  'T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'
] as const

export type Stage = (typeof STAGE_ORDER)[number]

interface GenTrace {
  stages: Partial<Record<Stage, number>>
  reported: boolean
}

/**
 * Per-generation latency stage tracker for the voice pipeline.
 * Stages: T0 end-of-speech, T1 VAD segment emitted, T2 whisper request sent,
 * T3 transcript ready, T4 processTranscript entered, T5 LLM request sent,
 * T6 first token, T7 first IPC flush to renderer, T8 renderer received,
 * T9 answer complete. report(genId) emits one console summary and cleans up.
 */
export class LatencyTracer {
  private traces = new Map<number, GenTrace>()
  private sttSlot: Partial<Record<Stage, number>> | null = null
  private activeGenId = 0

  setActive(genId: number): void {
    this.activeGenId = genId
  }

  getActive(): number {
    return this.activeGenId
  }

  /**
   * STT completes before the orchestrator assigns a genId, so whisper-stage
   * marks land in a slot keyed by nothing; beginSegment starts a fresh slot
   * per VAD segment (T0=end-of-speech estimate, T1=segment emitted).
   */
  beginSegment(t0: number, t1: number): void {
    this.sttSlot = { T0: t0, T1: t1 }
  }

  markSttStage(stage: 'T2' | 'T3', at: number = performance.now()): void {
    if (!this.sttSlot || this.sttSlot[stage] !== undefined) return
    this.sttSlot[stage] = at
  }

  adoptStt(genId: number): void {
    if (!this.traces.has(genId)) this.traces.set(genId, { stages: {}, reported: false })
    const trace = this.traces.get(genId)!
    if (this.sttSlot) {
      for (const stage of STAGE_ORDER) {
        const at = this.sttSlot[stage]
        if (at !== undefined && trace.stages[stage] === undefined) {
          trace.stages[stage] = at
        }
      }
      this.sttSlot = null
    }
    this.activeGenId = genId
  }

  mark(genId: number, stage: Stage, at: number = performance.now()): void {
    const trace = this.traces.get(genId)
    if (!trace) {
      if (stage !== 'T0') return
      this.traces.set(genId, { stages: { T0: at }, reported: false })
      return
    }
    if (trace.reported) return
    if (trace.stages[stage] === undefined) {
      trace.stages[stage] = at
    }
  }

  report(genId: number): {
    genId: number
    stages: Partial<Record<Stage, number>>
    deltas: Record<string, number>
  } | null {
    const trace = this.traces.get(genId)
    if (!trace) return null

    trace.reported = true
    this.traces.delete(genId)

    const deltas: Record<string, number> = {}
    let prevStage: Stage | null = null
    let prevAt: number | undefined
    for (const stage of STAGE_ORDER) {
      const at = trace.stages[stage]
      if (at === undefined) continue
      if (prevAt !== undefined && prevStage !== null) {
        deltas[`${stage}-${prevStage}`] = Math.round(at - prevAt)
      }
      prevStage = stage
      prevAt = at
    }

    return { genId, stages: { ...trace.stages }, deltas }
  }

  formatReport(report: {
    genId: number
    stages: Partial<Record<Stage, number>>
    deltas: Record<string, number>
  }): string {
    const parts = Object.entries(report.deltas).map(([k, v]) => `${k}=${v}ms`)
    return `[latency] gen#${report.genId} ${parts.join(' | ')}`
  }
}

export const latencyTracer = new LatencyTracer()
