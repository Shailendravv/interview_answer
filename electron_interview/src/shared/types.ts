export interface RouterOutput {
  is_question: boolean
  category: 'coding' | 'system_design' | 'behavioral' | 'project_specific' | 'general'
  project_id: string | null
  refined_query: string
}

export interface AudioChunk {
  buffer: ArrayBuffer
  sampleRate: number
  channels: number
}

export interface STTConfig {
  mode: 'whisper' | 'parakeet' | 'deepgram'
  deepgramApiKey?: string
  parakeetServerUrl?: string
}

export interface LLMProviderConfig {
  name: string
  apiKey?: string
  baseUrl: string
  model: string
}
