// Observes the app's own fetch() calls to Ollama and whisper-server without
// altering them: the response body is tee'd, the app reads one branch
// untouched, and the harness parses the other for server-side statistics.

export interface OllamaStats {
  prompt_eval_count?: number
  eval_count?: number
  done_reason?: string
  prompt_eval_duration?: number
  eval_duration?: number
  load_duration?: number
  total_duration?: number
}

export interface TappedCall {
  kind: 'ollama-chat' | 'ollama-generate' | 'ollama-other' | 'whisper-inference' | 'cloud-chat'
  url: string
  startedAt: number
  headersAt?: number
  firstChunkAt?: number
  endedAt?: number
  status?: number
  error?: string
  /** Request fields that matter for evaluation (never headers: they may carry keys). */
  request?: { model?: string; messages?: { role: string; content: string }[]; options?: unknown; hasOptions: boolean; promptChars: number }
  stats?: OllamaStats
  whisperText?: string
}

function classify(url: string): TappedCall['kind'] | null {
  if (url.includes(':11434/api/chat')) return 'ollama-chat'
  if (url.includes(':11434/api/generate')) return 'ollama-generate'
  if (url.includes(':11434/')) return 'ollama-other'
  if (url.endsWith('/inference')) return 'whisper-inference'
  if (url.endsWith('/chat/completions')) return 'cloud-chat'
  return null
}

export class HttpTap {
  readonly calls: TappedCall[] = []
  private original: typeof fetch | null = null

  install(): void {
    if (this.original) return
    const original = globalThis.fetch
    this.original = original
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const kind = classify(url)
      if (!kind) return original(input, init)

      const call: TappedCall = { kind, url, startedAt: performance.now() }
      if (typeof init?.body === 'string') {
        try {
          const body = JSON.parse(init.body)
          const messages = Array.isArray(body.messages) ? body.messages : undefined
          call.request = {
            model: body.model,
            messages,
            options: body.options,
            hasOptions: 'options' in body,
            promptChars: messages
              ? messages.reduce((s: number, m: { content: string }) => s + m.content.length, 0)
              : String(body.prompt ?? '').length
          }
        } catch { /* non-JSON body */ }
      }
      this.calls.push(call)

      let res: Response
      try {
        res = await original(input, init)
      } catch (err) {
        call.endedAt = performance.now()
        call.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        throw err
      }
      call.headersAt = performance.now()
      call.status = res.status
      if (!res.body) {
        call.endedAt = performance.now()
        return res
      }
      const [forApp, forTap] = res.body.tee()
      void this.consume(call, forTap)
      return new Response(forApp, { status: res.status, statusText: res.statusText, headers: res.headers })
    }) as typeof fetch
  }

  uninstall(): void {
    if (this.original) globalThis.fetch = this.original
    this.original = null
  }

  inFlight(kind?: TappedCall['kind']): number {
    return this.calls.filter((c) => c.endedAt === undefined && (!kind || c.kind === kind)).length
  }

  callsSince(t: number, kind?: TappedCall['kind']): TappedCall[] {
    return this.calls.filter((c) => c.startedAt >= t && (!kind || c.kind === kind))
  }

  private async consume(call: TappedCall, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (call.firstChunkAt === undefined) call.firstChunkAt = performance.now()
        text += decoder.decode(value, { stream: true })
      }
    } catch (err) {
      call.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    } finally {
      call.endedAt = performance.now()
    }
    if (call.kind === 'ollama-chat' || call.kind === 'ollama-generate') {
      const last = text.trim().split('\n').reverse().find((l) => l.includes('"done":true'))
      if (last) {
        try {
          const j = JSON.parse(last)
          call.stats = {
            prompt_eval_count: j.prompt_eval_count,
            eval_count: j.eval_count,
            done_reason: j.done_reason,
            prompt_eval_duration: j.prompt_eval_duration,
            eval_duration: j.eval_duration,
            load_duration: j.load_duration,
            total_duration: j.total_duration
          }
        } catch { /* partial stream */ }
      }
    } else if (call.kind === 'whisper-inference') {
      try {
        call.whisperText = JSON.parse(text).text
      } catch { /* non-JSON */ }
    }
  }
}
