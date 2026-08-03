import { BaseCloudProvider } from './BaseCloudProvider'

export class OpenRouterProvider extends BaseCloudProvider {
  constructor(apiKey: string) {
    super({
      name: 'openrouter',
      apiKey,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'meta-llama/llama-3.1-8b-instruct:free'
    })
  }
}
