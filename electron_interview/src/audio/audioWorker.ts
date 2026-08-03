import { parentPort } from 'worker_threads'
import { VADProcessor, VADConfig, DEFAULT_VAD_CONFIG } from './vad'

interface AudioWorkerMessage {
  type: 'chunk' | 'config' | 'flush' | 'reset'
  data?: ArrayBuffer
  config?: Partial<VADConfig>
}

interface AudioWorkerResponse {
  type: 'segment' | 'ready' | 'error'
  data?: ArrayBuffer
  error?: string
}

const vad = new VADProcessor(DEFAULT_VAD_CONFIG)

parentPort?.on('message', (msg: AudioWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'config':
        if (msg.config) {
          vad.config = { ...DEFAULT_VAD_CONFIG, ...msg.config }
        }
        parentPort?.postMessage({ type: 'ready' } satisfies AudioWorkerResponse)
        break

      case 'chunk':
        if (msg.data) {
          const pcm16 = new Int16Array(msg.data)
          const segments = vad.processFrame(pcm16)
          for (const seg of segments) {
            parentPort?.postMessage(
              { type: 'segment', data: seg.buffer } satisfies AudioWorkerResponse
            )
          }
        }
        break

      case 'flush':
        {
          const segments = vad.flush()
          for (const seg of segments) {
            parentPort?.postMessage(
              { type: 'segment', data: seg.buffer } satisfies AudioWorkerResponse
            )
          }
        }
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
