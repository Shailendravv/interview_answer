import { describe, it, expect } from 'vitest'
import { LatencyTracer, STAGE_ORDER } from '../src/main/telemetry/LatencyTracer'

describe('LatencyTracer', () => {
  it('records stage timestamps and computes monotonic deltas', () => {
    const tracer = new LatencyTracer()
    const genId = 1

    tracer.mark(genId, 'T0')
    tracer.mark(genId, 'T1')
    tracer.mark(genId, 'T2')

    const report = tracer.report(genId)
    expect(report).not.toBeNull()
    expect(report!.genId).toBe(genId)
    expect(report!.stages.T0).toBeLessThanOrEqual(report!.stages.T1)
    expect(report!.stages.T1).toBeLessThanOrEqual(report!.stages.T2)

    // Deltas are computed against the previous stage in T0..T9 order
    expect(report!.deltas['T1-T0']).toBeGreaterThanOrEqual(0)
    expect(report!.deltas['T2-T1']).toBeGreaterThanOrEqual(0)
    expect(tracer.report(genId)).toBeNull() // cleaned up after report
  })

  it('skips deltas when an intermediate stage is missing', () => {
    const tracer = new LatencyTracer()
    tracer.mark(2, 'T0')
    tracer.mark(2, 'T5') // T1..T4 never happened

    const report = tracer.report(2)!
    expect(report.deltas['T5-T0']).toBeGreaterThanOrEqual(0)
    expect(report.deltas['T1-T0']).toBeUndefined()
  })

  it('report returns null for unknown generations', () => {
    const tracer = new LatencyTracer()
    expect(tracer.report(999)).toBeNull()
  })

  it('mark on a completed generation is ignored (late stale marks)', () => {
    const tracer = new LatencyTracer()
    tracer.mark(3, 'T0')
    tracer.mark(3, 'T9')
    tracer.report(3)
    // Late mark for an already-reported generation must not throw or resurrect state
    expect(() => tracer.mark(3, 'T6')).not.toThrow()
    expect(tracer.report(3)).toBeNull()
  })

  it('exposes ordered stage names for stable report columns', () => {
    expect(STAGE_ORDER).toEqual([
      'T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'
    ])
  })

  it('beginSegment starts a fresh stt slot; adoptStt moves it into a generation', () => {
    const tracer = new LatencyTracer()
    tracer.beginSegment(100, 420) // T0=100, T1=420
    tracer.markSttStage('T2', 500)
    tracer.markSttStage('T3', 900)

    const genId = 7
    tracer.adoptStt(genId)
    tracer.mark(genId, 'T4', 910)

    const report = tracer.report(genId)!
    expect(report.stages.T0).toBe(100)
    expect(report.stages.T1).toBe(420)
    expect(report.stages.T3).toBe(900)
    expect(report.deltas['T1-T0']).toBe(320)
    expect(report.deltas['T3-T2']).toBe(400)
    expect(report.deltas['T4-T3']).toBe(10)
  })

  it('a new segment overwrites the previous stt slot (multi-segment questions)', () => {
    const tracer = new LatencyTracer()
    tracer.beginSegment(0, 300)
    tracer.markSttStage('T2', 400)
    tracer.markSttStage('T3', 800)
    tracer.beginSegment(1000, 1300) // second VAD segment resets slot

    const genId = 8
    tracer.adoptStt(genId)
    tracer.mark(genId, 'T4', 1310)

    const report = tracer.report(genId)!
    expect(report.stages.T0).toBe(1000)
    expect(report.stages.T2).toBeUndefined() // second segment never reached whisper yet
  })

  it('adoptStt without any segment still allows downstream marks', () => {
    const tracer = new LatencyTracer()
    const genId = 9
    tracer.adoptStt(genId)
    tracer.mark(genId, 'T4')
    expect(tracer.report(genId)!.stages.T4).toBeDefined()
  })

  it('tracks the active generation for renderer-side T8 marks', () => {
    const tracer = new LatencyTracer()
    tracer.setActive(11)
    expect(tracer.getActive()).toBe(11)
    tracer.setActive(12)
    expect(tracer.getActive()).toBe(12)
  })
})
