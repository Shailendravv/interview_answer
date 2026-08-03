import { OllamaProvider } from './OllamaProvider'

export interface RouterOutput {
  is_question: boolean
  category: 'coding' | 'system_design' | 'behavioral' | 'project_specific' | 'general'
  project_id: string | null
  refined_query: string
}

const QUESTION_KEYWORDS = /\b(what|how|why|explain|describe|tell|can|could|would|should|do|did|does|is|are|was|were|define|compare|contrast|list|write|implement|solve|find|show|demonstrate|walk me through)\b/i

const PROJECT_KEYWORDS: { project: string; patterns: RegExp[] }[] = []

export function configureProjectKeywords(entries: { project: string; patterns: RegExp[] }[]): void {
  PROJECT_KEYWORDS.length = 0
  PROJECT_KEYWORDS.push(...entries)
}

let routerProjectList = 'project_a through project_f'
export function setRouterProjectList(list: string): void {
  routerProjectList = list
}

const CATEGORY_KEYWORDS: { category: RouterOutput['category']; patterns: RegExp[] }[] = [
  {
    category: 'coding',
    patterns: [
      /implement|write code|function|algorithm|leetcode|complexity|bug|debug|error|syntax|compile|refactor|optimize|test|deploy|config|async|promise|callback|event loop|hoisting|closure|prototype|oop|solid|rest|graphql|sql|nosql|docker|kubernetes|aws/i
    ]
  },
  {
    category: 'system_design',
    patterns: [
      /design|architecture|scale|distributed|microservice|database choice|load balancer|cache|cache.*strategy|cd(?:n|ns)?|system design|cap theorem|consistency|availability|partition|sharding|replication|consistent hashing|message queue|event driven|stream processing|throughput|latency/i
    ]
  },
  {
    category: 'behavioral',
    patterns: [
      /behavioral|tell me about yourself|conflict|challenge|teamwork|leadership|failure|achievement|experience|tell me a time|strength|weakness|situation|task|action|result|star method|why do you want|where do you see/i
    ]
  },
  {
    category: 'project_specific',
    patterns: [
      /project|what i worked on|my project|contribution|role in|built a|developed|designed|architected|implemented a/i
    ]
  }
]

function buildRouterPrompt(): string {
  return `You are a classifier. Given a user query, respond with ONLY a JSON object (no other text).

Rules:
- "is_question": true if the user is asking something or seeking information.
- "category": one of "coding", "system_design", "behavioral", "project_specific", "general".
- "project_id": if the query references a specific project, include the matching id from this list: ${routerProjectList}. Otherwise null.
- "refined_query": rewrite the query to be clear and standalone. Fix any grammar errors. Remove filler words (um, uh, like, you know).

Examples:
Input: "how does the ecommerce platform handle auth"
Output: {"is_question":true,"category":"project_specific","project_id":"ecommerce-platform","refined_query":"How does the ecommerce platform handle authentication?"}

Input: "implement a binary search tree"
Output: {"is_question":true,"category":"coding","project_id":null,"refined_query":"Implement a binary search tree in code"}

Input: "tell me about yourself"
Output: {"is_question":true,"category":"behavioral","project_id":null,"refined_query":"Tell me about yourself"}

Input: "I like your shirt"
Output: {"is_question":false,"category":"general","project_id":null,"refined_query":""}

Input: "uh like design a distributed cache"
Output: {"is_question":true,"category":"system_design","project_id":null,"refined_query":"Design a distributed cache system"}

Query:`
}

const ROUTER_CACHE_SIZE = 10
const ROUTER_CB_FAILURES = 3
const ROUTER_CB_COOLDOWN_MS = 120000

export class RouterService {
  private router: OllamaProvider
  private routeCache = new Map<string, RouterOutput>()
  private llmRouteFailures = 0
  private llmRouteCooldownUntil = 0

  constructor(router: OllamaProvider) {
    this.router = router
  }

  static detectProject(text: string): string | null {
    for (const { project, patterns } of PROJECT_KEYWORDS) {
      if (patterns.some((p) => p.test(text))) return project
    }
    return null
  }

  static fastRoute(transcript: string): RouterOutput | null {
    const trimmed = transcript.trim()
    if (!trimmed) return null

    if (trimmed.endsWith('?')) {
      return {
        is_question: true,
        category: RouterService.detectCategory(trimmed),
        project_id: RouterService.detectProject(trimmed),
        refined_query: RouterService.refine(trimmed)
      }
    }

    if (QUESTION_KEYWORDS.test(trimmed)) {
      return {
        is_question: true,
        category: RouterService.detectCategory(trimmed),
        project_id: RouterService.detectProject(trimmed),
        refined_query: RouterService.refine(trimmed)
      }
    }

    return null
  }

  async route(transcript: string): Promise<RouterOutput> {
    const trimmed = transcript.trim()
    if (trimmed.length < 5 && !trimmed.endsWith('?')) {
      return RouterService.regexFallback(transcript)
    }

    // Router circuit breaker: if LLM route failed too many times, skip it
    if (this.llmRouteFailures >= ROUTER_CB_FAILURES) {
      if (Date.now() < this.llmRouteCooldownUntil) {
        const fastResult = RouterService.fastRoute(transcript)
        return fastResult || RouterService.regexFallback(transcript)
      }
      this.llmRouteFailures = 0
    }

    // Check cache for near-duplicate queries
    const cacheKey = trimmed.toLowerCase().replace(/\s+/g, ' ')
    const cached = this.routeCache.get(cacheKey)
    if (cached) return cached

    const fastResult = RouterService.fastRoute(transcript)
    if (fastResult) return fastResult

    try {
      const result = await this.llmRoute(transcript)
      this.llmRouteFailures = 0

      if (result.refined_query && result.refined_query.length > trimmed.length * 3) {
        result.refined_query = trimmed
      }

      // Cache the result
      if (this.routeCache.size >= ROUTER_CACHE_SIZE) {
        const firstKey = this.routeCache.keys().next().value
        if (firstKey) this.routeCache.delete(firstKey)
      }
      this.routeCache.set(cacheKey, result)

      return result
    } catch (err) {
      this.llmRouteFailures++
      if (this.llmRouteFailures >= ROUTER_CB_FAILURES) {
        this.llmRouteCooldownUntil = Date.now() + ROUTER_CB_COOLDOWN_MS
      }
      return RouterService.regexFallback(transcript)
    }
  }

  private async llmRoute(transcript: string): Promise<RouterOutput> {
    const req = {
      model: 'qwen2.5-coder:0.5b',
      messages: [{ role: 'user', content: buildRouterPrompt() + '\n' + transcript }],
      stream: false,
      maxTokens: 150,
      temperature: 0.1
    }

    const gen = this.router.generate({
      model: req.model,
      messages: req.messages,
      stream: false,
      maxTokens: req.maxTokens,
      temperature: req.temperature
    })

    let fullText = ''
    for await (const token of gen) {
      fullText += token
    }

    return RouterService.parseJson(fullText)
  }

  private static parseJson(text: string): RouterOutput {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          is_question: parsed.is_question ?? true,
          category: parsed.category || 'general',
          project_id: parsed.project_id || null,
          refined_query: parsed.refined_query || ''
        }
      } catch { /* fall through */ }
    }
    return RouterService.regexFallback(text)
  }

  private static regexFallback(text: string): RouterOutput {
    return {
      is_question: true,
      category: RouterService.detectCategory(text),
      project_id: RouterService.detectProject(text),
      refined_query: RouterService.refine(text)
    }
  }

  static detectCategory(text: string): RouterOutput['category'] {
    for (const { category, patterns } of CATEGORY_KEYWORDS) {
      if (patterns.some((p) => p.test(text))) return category
    }
    return 'general'
  }

  static refine(text: string): string {
    return text
      .replace(/\b(?:um|uh|like|you know|sort of|kind of)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[a-z]/, (c) => c.toUpperCase())
      + (text.endsWith('?') ? '' : '.')
  }
}
