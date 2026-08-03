import { BaseCloudProvider } from './BaseCloudProvider'

export class CerebrasProvider extends BaseCloudProvider {
  constructor(apiKey: string) {
    super({
      name: 'cerebras',
      apiKey,
      baseUrl: 'https://api.cerebras.ai/v1',
      model: 'llama3.1-8b'
    })
  }
}
