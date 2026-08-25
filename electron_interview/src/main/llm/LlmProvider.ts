import { EventEmitter } from 'events'

export interface StreamTimeouts {
  /** Max wait for the first bytes of the response. */
  connectMs: number
  /** Max silence between stream chunks; resets on every received chunk. */
  idleMs: number
}

export interface GenerationRequest {
  model: string
  messages: { role: string; content: string }[]
  stream?: boolean
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  timeouts?: StreamTimeouts
}

export interface GenerationResponse {
  text: string
  provider: string
  model: string
}

export abstract class LlmProvider extends EventEmitter {
  abstract readonly name: string

  abstract generate(req: GenerationRequest): AsyncGenerator<string, GenerationResponse, void>

  abstract healthCheck(): Promise<boolean>
}
