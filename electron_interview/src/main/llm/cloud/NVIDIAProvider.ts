import { BaseCloudProvider } from './BaseCloudProvider'

export class NVIDIAProvider extends BaseCloudProvider {
  constructor(apiKey: string) {
    super({
      name: 'nvidia',
      apiKey,
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'meta/llama-3.1-8b-instruct'
    })
  }
}
