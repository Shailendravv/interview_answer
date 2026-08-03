import { EventEmitter } from 'events'

export interface GenerationRequest {
  model: string
  messages: { role: string; content: string }[]
  stream?: boolean
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
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
