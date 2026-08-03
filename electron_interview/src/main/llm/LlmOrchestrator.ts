import { OllamaService } from './OllamaService'
import { OllamaProvider } from './OllamaProvider'
import { ProviderChain } from './ProviderChain'
import { LlmProvider, GenerationRequest, GenerationResponse } from './LlmProvider'
import { GroqProvider } from './cloud/GroqProvider'
import { CerebrasProvider } from './cloud/CerebrasProvider'
import { SambaNovaProvider } from './cloud/SambaNovaProvider'
import { GeminiProvider } from './cloud/GeminiProvider'
import { NVIDIAProvider } from './cloud/NVIDIAProvider'
import { OpenRouterProvider } from './cloud/OpenRouterProvider'

interface ProviderKeys {
  groq?: string
  cerebras?: string
  sambanova?: string
  gemini?: string
  nvidia?: string
  openrouter?: string
}

export class LlmOrchestrator {
  private ollamaService: OllamaService
  private chain: ProviderChain
  private router: OllamaProvider
  private cloudProviders: LlmProvider[] = []

  constructor(keys: ProviderKeys) {
    this.ollamaService = new OllamaService()
    this.router = new OllamaProvider(this.ollamaService)

    this.chain = new ProviderChain()

    const providerConfigs: { key: string | undefined; Provider: new (k: string) => LlmProvider }[] = [
      { key: keys.groq, Provider: GroqProvider },
      { key: keys.cerebras, Provider: CerebrasProvider },
      { key: keys.sambanova, Provider: SambaNovaProvider },
      { key: keys.gemini, Provider: GeminiProvider },
      { key: keys.nvidia, Provider: NVIDIAProvider },
      { key: keys.openrouter, Provider: OpenRouterProvider }
    ]

    for (const { key, Provider } of providerConfigs) {
      if (key) {
        const provider = new Provider(key)
        this.cloudProviders.push(provider)
        this.chain.addProvider(provider, 3, 5000)
      }
    }

    // Local Ollama is the final backstop — high failure tolerance, longer timeout
    this.chain.addProvider(
      new OllamaProvider(this.ollamaService, 'qwen2.5-coder:1.5b'),
      10,
      15000
    )
  }

  async initialize(): Promise<void> {
    await this.ollamaService.start()
    this.prewarmCloudProviders()
    console.log('Ollama ready, models preloaded')
  }

  private prewarmCloudProviders(): void {
    for (const provider of this.cloudProviders) {
      provider.healthCheck().catch(() => {})
    }
  }

  getRouter(): OllamaProvider {
    return this.router
  }

  getGenerationChain(): ProviderChain {
    return this.chain
  }

  async healthCheck(): Promise<{
    ollama: boolean
    routerReady: boolean
    chainHealthy: boolean
    loadedModels: string[]
  }> {
    const ollamaHealth = await this.ollamaService.healthCheck()
    return {
      ollama: ollamaHealth.ok,
      routerReady: await this.router.healthCheck(),
      chainHealthy: await this.chain.healthCheck(),
      loadedModels: ollamaHealth.models
    }
  }

  async stop(): Promise<void> {
    this.ollamaService.stop()
  }
}
