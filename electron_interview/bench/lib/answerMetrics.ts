// Automated answer-quality checks. These are heuristics for trend tracking,
// not a substitute for the human review sheet the answers suite also writes.
import { SYSTEM_PROMPTS } from '../../src/main/orchestrator/SystemPrompts'

export const CLARIFY_MESSAGE =
  'No project is currently selected. Please select a project from the Projects tab first.'

/** Headings each category's production template mandates, read from the live prompt (no drift). */
export function expectedHeadings(category: string): string[] {
  const prompt = SYSTEM_PROMPTS[category] ?? SYSTEM_PROMPTS.general
  return [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
}

// Technologies a model might claim to have used. Ambiguous English words
// ("go", "spring", "express", "spark") are deliberately excluded.
const TECH_LEXICON = [
  'React', 'Angular', 'Vue', 'Next.js', 'Node.js', 'Django', 'Flask', 'FastAPI', 'Java', 'Kotlin',
  'Golang', 'Rust', 'C#', '.NET', 'Ruby on Rails', 'PHP', 'Python', 'TypeScript', 'JavaScript',
  'Kafka', 'RabbitMQ', 'Redis', 'Memcached', 'PostgreSQL', 'Postgres', 'MySQL', 'MongoDB',
  'Cassandra', 'DynamoDB', 'Elasticsearch', 'Snowflake', 'BigQuery', 'Hadoop', 'Airflow',
  'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'GitHub Actions', 'AWS', 'Azure', 'GCP',
  'S3', 'EC2', 'GraphQL', 'gRPC', 'LangChain', 'LlamaIndex', 'Pinecone', 'FAISS', 'ChromaDB',
  'OpenAI', 'Hugging Face', 'TensorFlow', 'PyTorch', 'Tableau', 'Power BI', 'Salesforce',
  'Celery', 'Nginx'
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentions(text: string, term: string): boolean {
  return new RegExp(`(?<![\\w.])${escapeRegExp(term)}(?![\\w])`, 'i').test(text)
}

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ')
}

function headingLines(text: string): { strict: string[]; loose: string[] } {
  const strict: string[] = []
  const loose: string[] = []
  for (const line of stripCode(text).split('\n')) {
    const h2 = line.match(/^\s{0,3}##\s+(.+?)\s*#*\s*$/)
    if (h2) strict.push(h2[1].trim().toLowerCase())
    const any =
      line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/) ??
      line.match(/^\s*\*\*(.+?)\*\*\s*:?/) // "**Explanation**:" pseudo-heading
    if (any) loose.push(any[1].replace(/[:*]+$/g, '').trim().toLowerCase())
  }
  return { strict, loose }
}

export interface AnswerChecks {
  chars: number
  words: number
  expectedHeadings: string[]
  /** Every mandated "## Heading" present, in order. */
  headingsStrict: boolean
  /** Fraction of mandated headings present as any heading or bold label. */
  headingsLooseFraction: number
  firstPerson: boolean
  saysTheCandidate: boolean
  markerLeak: boolean
  clarifyExact: boolean
  /** Project answers only: tech named in the answer but absent from [PROJECT CONTEXT] and the question. */
  unsupportedTech: string[]
  /** Follow-up questions only: whether any expected earlier-turn term is mentioned. */
  mentionsExpected: boolean | null
}

export function checkAnswer(
  answer: string,
  opts: { category: string; question: string; projectBlock?: string; expectMentions?: string[] }
): AnswerChecks {
  const expected = expectedHeadings(opts.category)
  const { strict, loose } = headingLines(answer)
  let cursor = 0
  for (const h of strict) {
    if (cursor < expected.length && h === expected[cursor].toLowerCase()) cursor++
  }
  const looseHits = expected.filter((h) => loose.some((l) => l.includes(h.toLowerCase()))).length
  const prose = stripCode(answer)
  const unsupportedTech = opts.projectBlock
    ? TECH_LEXICON.filter(
        (t) => mentions(answer, t) && !mentions(opts.projectBlock!, t) && !mentions(opts.question, t)
      )
    : []
  return {
    chars: answer.length,
    words: answer.split(/\s+/).filter(Boolean).length,
    expectedHeadings: expected,
    headingsStrict: expected.length > 0 && cursor === expected.length,
    headingsLooseFraction: expected.length ? looseHits / expected.length : 0,
    firstPerson: /\b(I|I'm|I've|I'd|I'll|my|me)\b/.test(prose),
    saysTheCandidate: /\bthe candidate\b/i.test(answer),
    markerLeak: /\[(CURRENT QUESTION|PROJECT CONTEXT|CONVERSATION HISTORY SUMMARY|RECENT CONVERSATION HISTORY)|^\s*Past [QA]:/im.test(answer),
    clarifyExact: answer.includes(CLARIFY_MESSAGE),
    unsupportedTech,
    mentionsExpected: opts.expectMentions
      ? opts.expectMentions.some((m) => answer.toLowerCase().includes(m.toLowerCase()))
      : null
  }
}
