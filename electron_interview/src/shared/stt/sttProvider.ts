import { EventEmitter } from 'events'

export interface STTEngine {
  readonly name: string
  start(): Promise<void>
  stop(): void
  feedAudioChunk(chunk: Buffer): void
  finalize(): void
  cancel(): void
  on(event: 'transcript', listener: (text: string, isFinal: boolean) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'ready', listener: () => void): this
  on(event: 'status', listener: (info: { engine: string; error: string | null }) => void): this
  removeAllListeners(event?: string): this
}

export abstract class BaseSTTEngine extends EventEmitter implements STTEngine {
  abstract readonly name: string
  abstract start(): Promise<void>
  abstract stop(): void
  abstract feedAudioChunk(chunk: Buffer): void
  abstract finalize(): void
  cancel(): void {}
}
