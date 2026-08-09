import { spawn, ChildProcess } from 'child_process'


export interface OllamaModel {
  name: string
  loaded: boolean
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
          body: JSON.stringify({ model, prompt: 'Hello', stream: false, keep_alive: -1 }),
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
    signal?: AbortSignal
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('Ollama generation timed out after 15s', 'TimeoutError')), 15000)
    const onAbort = (): void => {
      clearTimeout(timer)
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream, keep_alive: -1 }),
        signal: controller.signal
      })
      if (res.ok) {
        this.models.set(model, true)
      }
      return res
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async generate(model: string, prompt: string, stream = true, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('Ollama generation timed out after 15s', 'TimeoutError')), 15000)
    const onAbort = (): void => {
      clearTimeout(timer)
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream, keep_alive: -1 }),
        signal: controller.signal
      })
      if (res.ok) {
        this.models.set(model, true)
      }
      return res
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
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
