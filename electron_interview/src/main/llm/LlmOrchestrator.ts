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
  groqModel?: string
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
  private groqProvider: GroqProvider | null = null
  private generationModel: 'ollama' | 'groq' = 'ollama'

  constructor(keys: ProviderKeys) {
    this.ollamaService = new OllamaService()
    this.router = new OllamaProvider(this.ollamaService)

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
      }
    }

    if (keys.groq) {
      this.groqProvider = new GroqProvider(keys.groq, keys.groqModel)
    }

    this.chain = this.buildGenerationChain(this.generationModel)
  }

  private buildGenerationChain(model: 'ollama' | 'groq'): ProviderChain {
    const chain = new ProviderChain()
    if (model === 'groq' && this.groqProvider) {
      chain.addProvider(this.groqProvider, 3, 5000)
    } else {
      // Local Ollama is the default generator — high failure tolerance, longer timeout
      chain.addProvider(
        new OllamaProvider(this.ollamaService, 'qwen2.5-coder:1.5b'),
        10,
        15000
      )
    }
    return chain
  }

  setGenerationModel(model: 'ollama' | 'groq'): void {
    if (model === 'groq' && !this.groqProvider) {
      console.warn('[llm] GROQ_API_KEY not set; staying on local Ollama')
      return
    }
    if (model !== this.generationModel) {
      this.generationModel = model
      this.chain = this.buildGenerationChain(model)
      console.log(`[llm] generation model -> ${model}`)
    }
  }

  getGenerationModel(): 'ollama' | 'groq' {
    return this.generationModel
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
