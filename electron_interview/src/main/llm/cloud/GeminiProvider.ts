import { BaseCloudProvider } from './BaseCloudProvider'

export class GeminiProvider extends BaseCloudProvider {
  constructor(apiKey: string) {
    super({
      name: 'gemini',
      apiKey,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash'
    })
  }
}
