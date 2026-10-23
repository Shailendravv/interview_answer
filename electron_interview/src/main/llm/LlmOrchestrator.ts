import { OllamaService } from './OllamaService'
import { OllamaProvider } from './OllamaProvider'
import { ProviderChain, FallbackEvent } from './ProviderChain'
import { GroqProvider } from './cloud/GroqProvider'

// A socket stays pooled for only a few seconds, but re-handshaking on every
// utterance in a rapid back-and-forth is wasteful. One warm-up per window.
const PRECONNECT_THROTTLE_MS = 3000

interface ProviderKeys {
  groq?: string
  groqModel?: string
}

export type GenerationModel = 'ollama' | 'groq'

export class LlmOrchestrator {
  private ollamaService: OllamaService
  private chain: ProviderChain
  private router: OllamaProvider
  private groqProvider: GroqProvider | null = null
  private generationModel: GenerationModel = 'ollama'
  private fallbackListeners: ((event: FallbackEvent) => void)[] = []

  private lastPreconnectAt = 0

  constructor(keys: ProviderKeys) {
    this.ollamaService = new OllamaService()
    this.router = new OllamaProvider(this.ollamaService)

    if (keys.groq) {
      this.groqProvider = new GroqProvider(keys.groq, keys.groqModel)
    }

    this.chain = this.buildGenerationChain(this.generationModel)
  }

  private buildGenerationChain(model: GenerationModel): ProviderChain {
    const chain = new ProviderChain()
    if (model === 'groq' && this.groqProvider) {
      // Groq TTFT ≈0.1-0.3s and chunk gaps are ms-scale: tight idle window.
      // A 5s connect window caps how long a hung Groq delays the Ollama
      // fallback. Three failures open its circuit, so later questions skip
      // straight to Ollama instead of paying a timeout each time.
      chain.addProvider(this.groqProvider, 3, 5000, 8000)
    }
    // Local Ollama is the default generator and the fallback when Groq is
    // selected but fails before streaming. High failure tolerance; generous
    // idle window because a cold model load can pause output for seconds.
    chain.addProvider(
      new OllamaProvider(this.ollamaService, 'qwen2.5-coder:1.5b'),
      10,
      10000,
      30000
    )
    chain.on('fallback', (event: FallbackEvent) => {
      console.warn(`[llm] ${event.from} failed (${event.reason}); falling back to ${event.to}`)
      for (const listener of this.fallbackListeners) listener(event)
    })
    return chain
  }

  /** Called whenever a generation falls back to the next provider. */
  onFallback(listener: (event: FallbackEvent) => void): void {
    this.fallbackListeners.push(listener)
  }

  setGenerationModel(model: GenerationModel): void {
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

  getGenerationModel(): GenerationModel {
    return this.generationModel
  }

  async initialize(): Promise<void> {
    // Warm the Groq connection in parallel; a dead Ollama must not block it.
    this.groqProvider?.healthCheck().catch(() => {})
    await this.ollamaService.start()
    console.log('Ollama ready, models preloaded')
  }

  /**
   * Opens a socket to the active cloud provider so the request that follows
   * does not pay for one. Node's fetch keeps pooled sockets for only ~4s, and
   * questions in an interview are tens of seconds apart, so without this every
   * single answer pays a fresh DNS + TCP + TLS handshake (~100-300ms) before
   * the model has even seen the prompt.
   *
   * Called on VAD speech onset -- while the speaker is still talking -- so the
   * handshake overlaps time that was being spent anyway. This is a connection
   * warm-up, not an inference: no tokens are generated and no prompt is sent.
   */
  preconnect(): void {
    if (this.generationModel !== 'groq' || !this.groqProvider) return

    const now = Date.now()
    if (now - this.lastPreconnectAt < PRECONNECT_THROTTLE_MS) return
    this.lastPreconnectAt = now

    this.groqProvider.healthCheck().catch(() => {})
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
