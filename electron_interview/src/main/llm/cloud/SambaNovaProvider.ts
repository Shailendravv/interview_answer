import { BaseCloudProvider } from './BaseCloudProvider'

export class SambaNovaProvider extends BaseCloudProvider {
  constructor(apiKey: string) {
    super({
      name: 'sambanova',
      apiKey,
      baseUrl: 'https://api.sambanova.ai/v1',
      model: 'Meta-Llama-3.1-8B-Instruct'
    })
  }
}
