import { spawn, ChildProcess } from 'child_process'
import { createIdleAbortSignal } from './idleSignal'

/**
 * Context window every request to a generation model uses. Ollama 0.30
 * defaults to 32768, which loads qwen2.5-coder:1.5b at 2.1 GB of VRAM; 8192
 * needs 1.36 GB (measured) and still fits the largest prompt seen in the
 * bench/ answer suite (1,879 tokens) several times over. Every request to the
 * same model must use the same value -- a different num_ctx forces a reload.
 */
export const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192

export interface OllamaGenerationOptions {
  /** Max tokens to generate. Without it Ollama runs until the context fills. */
  num_predict?: number
  temperature?: number
}

/**
 * A streaming response plus its stall watchdog. The watchdog must stay armed
 * while the body is read -- the caller calls progress() per chunk and
 * dispose() when done -- or a stalled stream would hang forever.
 */
export interface OllamaStream {
  response: Response
  progress: () => void
  dispose: () => void
}


export interface OllamaModel {
  name: string
  loaded: boolean
}

function stripUndefined(options?: OllamaGenerationOptions): OllamaGenerationOptions {
  const out: OllamaGenerationOptions = {}
  if (options?.num_predict !== undefined) out.num_predict = options.num_predict
  if (options?.temperature !== undefined) out.temperature = options.temperature
  return out
}

export class OllamaService {
  private process: ChildProcess | null = null
  private baseUrl = 'http://127.0.0.1:11434'
  private ready = false
  private models: Map<string, boolean> = new Map()

  constructor(private modelNames: string[] = ['qwen2.5-coder:1.5b', 'nomic-embed-text']) {}

  async start(): Promise<void> {
    if (await this.isOllamaRunning()) {
      this.ready = true
    } else {
      this.killStaleServers()
      await this.spawnOllama()
    }

    for (const model of this.modelNames) {
      await this.ensureModel(model)
    }

    this.preloadModels()
  }

  private async isOllamaRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  private spawnOllama(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cmd = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
      this.process = spawn(cmd, ['serve'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      })

      let settled = false
      const succeed = (): void => {
        if (settled) return
        settled = true
        this.ready = true
        resolve()
      }
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        this.ready = false
        reject(new Error(message))
      }

      this.process.on('error', (err) => {
        fail(`Failed to start Ollama: ${err.message}`)
      })

      this.process.on('exit', (code) => {
        this.ready = false
        if (code !== 0) {
          fail(`Ollama exited with code ${code}`)
        }
      })

      // Poll the server until it actually accepts requests. A blind timer would
      // let the app think Ollama is "ready" while it is still starting (or never
      // started), turning every first question into a connection error.
      const startedAt = Date.now()
      const poll = async (): Promise<void> => {
        try {
          const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
          if (res.ok) {
            succeed()
            return
          }
        } catch { /* not up yet */ }
        if (settled) return
        if (Date.now() - startedAt > 10000) {
          fail(`Ollama did not become reachable at ${this.baseUrl} within 10s after starting`)
          return
        }
        setTimeout(() => { void poll() }, 500)
      }
      void poll()
    })
  }

  private killStaleServers(): void {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/f', '/im', 'llama-server.exe'], { stdio: 'ignore' })
      } else {
        spawn('pkill', ['-f', 'llama-server'], { stdio: 'ignore' })
      }
    } catch { /* no orphaned servers */ }
  }

  private async ensureModel(model: string): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      const data = (await res.json()) as { models?: { name: string }[] }
      const exists = data.models?.some((m) => m.name === model || m.name.startsWith(model))

      if (!exists) {
        console.log(`Pulling model ${model}...`)
        await this.pullModel(model)
      }

      this.models.set(model, false)
    } catch (err) {
      console.error(`Failed to ensure model ${model}:`, err)
    }
  }

  private async pullModel(model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
      signal: AbortSignal.timeout(300000)
    })

    if (!res.ok) throw new Error(`Failed to pull model ${model}: ${res.status}`)
  }

  private async preloadModels(): Promise<void> {
    for (const model of this.modelNames) {
      try {
        const res = await fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Same num_ctx as real requests, or the first question reloads the model.
          body: JSON.stringify({ model, prompt: 'Hello', stream: false, keep_alive: -1, options: { num_ctx: OLLAMA_NUM_CTX, num_predict: 1 } }),
          signal: AbortSignal.timeout(120000)
        })

        if (res.ok) {
          this.models.set(model, true)
          console.log(`Model ${model} preloaded into VRAM`)
        }
      } catch (err) {
        console.warn(`Model ${model} not yet loaded (will load on first use):`, err)
      }
    }
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  isReady(): boolean {
    return this.ready
  }

  isModelLoaded(model: string): boolean {
    return this.models.get(model) ?? false
  }

  async chat(
    model: string,
    messages: { role: string; content: string }[],
    stream = true,
    signal?: AbortSignal,
    timeouts?: { connectMs: number; idleMs: number },
    options?: OllamaGenerationOptions
  ): Promise<OllamaStream> {
    return this.streamRequest(`${this.baseUrl}/api/chat`, { model, messages, stream }, signal, timeouts, options)
  }

  async generate(
    model: string,
    prompt: string,
    stream = true,
    signal?: AbortSignal,
    timeouts?: { connectMs: number; idleMs: number },
    options?: OllamaGenerationOptions
  ): Promise<OllamaStream> {
    return this.streamRequest(`${this.baseUrl}/api/generate`, { model, prompt, stream }, signal, timeouts, options)
  }

  /**
   * Streams are bounded by connect/idle windows instead of a total-duration
   * timer: a long but steadily-producing answer must never be cut off, while
   * a stalled server is dropped quickly. The watchdog (and the caller's abort
   * signal) stay attached until the caller disposes the returned stream.
   */
  private async streamRequest(
    url: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeouts?: { connectMs: number; idleMs: number },
    options?: OllamaGenerationOptions
  ): Promise<OllamaStream> {
    const connectMs = timeouts?.connectMs ?? 10000
    const idleMs = timeouts?.idleMs ?? 30000
    const idle = createIdleAbortSignal(connectMs, idleMs, signal)
    const body = {
      ...payload,
      keep_alive: -1,
      options: { num_ctx: OLLAMA_NUM_CTX, ...stripUndefined(options) }
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: idle.signal
      })
      if (res.ok) {
        this.models.set(String(payload.model), true)
      }
      idle.progress() // headers arrived -- switch to the idle window
      return { response: res, progress: idle.progress, dispose: idle.dispose }
    } catch (err) {
      idle.dispose()
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(`Ollama stream stalled at ${url} (${connectMs}/${idleMs}ms connect/idle)`)
      }
      throw err
    }
  }

  async healthCheck(): Promise<{ ok: boolean; models: string[]; vramWarning?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
      const data = (await res.json()) as { models?: { name: string; size?: number }[] }
      return {
        ok: res.ok,
        models: data.models?.map((m) => m.name) || []
      }
    } catch {
      return { ok: false, models: [] }
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
    this.ready = false
  }
}
