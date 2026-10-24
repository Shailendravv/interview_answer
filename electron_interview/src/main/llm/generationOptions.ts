function positive(value: string | undefined): number | undefined {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : undefined
}

function finite(value: string | undefined): number | undefined {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : undefined
}

/**
 * Optional overrides (Orchestrator defaults: 768 tokens, temperature 0.7, and
 * 0.3 for answers grounded in [PROJECT CONTEXT]).
 */
export function generationOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  maxTokens?: number
  temperature?: number
  groundedTemperature?: number
} {
  return {
    maxTokens: positive(env.LLM_MAX_TOKENS),
    temperature: finite(env.LLM_TEMPERATURE),
    groundedTemperature: finite(env.LLM_GROUNDED_TEMPERATURE)
  }
}
