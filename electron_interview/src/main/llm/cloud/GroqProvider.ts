import { BaseCloudProvider } from './BaseCloudProvider'

export class GroqProvider extends BaseCloudProvider {
  constructor(apiKey: string) {
    super({
      name: 'groq',
      apiKey,
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-8b-instant'
    })
  }
}
