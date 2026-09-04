import { parentPort } from 'worker_threads'
import { VADProcessor, VADConfig, VADSegment, VADSegmentReason } from './vad'

interface AudioWorkerMessage {
  type: 'chunk' | 'config' | 'flush' | 'reset'
  data?: ArrayBuffer
  config?: Partial<VADConfig>
}

export interface SegmentMeta {
  durationMs: number
  trailingSilenceMs: number
  reason: VADSegmentReason
}

interface AudioWorkerResponse {
  type: 'segment' | 'ready' | 'error' | 'speech-start'
  data?: ArrayBuffer
  meta?: SegmentMeta
  error?: string
}

const vad = new VADProcessor()

vad.setOnSpeechStart(() => {
  parentPort?.postMessage({ type: 'speech-start' } satisfies AudioWorkerResponse)
})

function postSegments(segments: VADSegment[]): void {
  for (const seg of segments) {
    parentPort?.postMessage({
      type: 'segment',
      data: seg.data.buffer as ArrayBuffer,
      meta: {
        durationMs: seg.durationMs,
        trailingSilenceMs: seg.trailingSilenceMs,
        reason: seg.reason
      }
    } satisfies AudioWorkerResponse)
  }
}

parentPort?.on('message', (msg: AudioWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'config':
        if (msg.config) {
          vad.setConfig(msg.config)
        }
        parentPort?.postMessage({ type: 'ready' } satisfies AudioWorkerResponse)
        break

      case 'chunk':
        if (msg.data) {
          postSegments(vad.processChunk(new Int16Array(msg.data)))
        }
        break

      case 'flush':
        postSegments(vad.flush())
        break

      case 'reset':
        vad.reset()
        break
    }
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      error: String(err)
    } satisfies AudioWorkerResponse)
  }
})

parentPort?.postMessage({ type: 'ready' } satisfies AudioWorkerResponse)
