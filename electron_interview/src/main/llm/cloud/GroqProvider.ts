import { BaseCloudProvider } from './BaseCloudProvider'

const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b'

export class GroqProvider extends BaseCloudProvider {
  constructor(apiKey: string, model?: string) {
    const resolvedModel = model || DEFAULT_GROQ_MODEL
    super({
      name: 'groq',
      apiKey,
      baseUrl: 'https://api.groq.com/openai/v1',
      model: resolvedModel,
      // Reasoning models (Qwen 3.x) think by default, which leaks a <think>…
      // block into the answer and eats the token budget. Only Qwen supports
      // `reasoning_effort`, so gate it on the model family to keep non-reasoning
      // models (llama, gpt-oss) unaffected.
      extraBody: /qwen/i.test(resolvedModel)
        ? { reasoning_effort: 'none' }
        : undefined
    })
  }
}
