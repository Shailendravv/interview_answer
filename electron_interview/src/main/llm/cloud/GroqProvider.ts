import { BaseCloudProvider } from './BaseCloudProvider'

const DEFAULT_GROQ_MODEL = 'llama-3.1-8b-instant'

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
      // models (llama-3.1-8b-instant) unaffected.
      extraBody: /qwen/i.test(resolvedModel)
        ? { reasoning_effort: 'none' }
        : undefined
    })
  }
}
