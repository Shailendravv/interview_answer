// LLM latency benchmark: TTFT / tokens-per-second / totals for the two
// generation paths used by the app (Ollama qwen2.5-coder:1.5b, Groq GROQ_MODEL).
// Usage: node scripts/bench-llm.mjs [--runs 3] [--only ollama|groq]
import 'dotenv/config'

const OLLAMA_URL = 'http://127.0.0.1:11434'
const OLLAMA_MODEL = 'qwen2.5-coder:1.5b'
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
const SYSTEM_PROMPT = 'You are a senior software engineer answering interview questions in real time. Answer in first person with ## headings: Answer, Explanation, Example, Best Practice.'

const QUESTIONS = {
  A_short: 'What time is it?',
  B_normal: 'Explain the difference between let, const, and var in JavaScript.',
  C_longer: 'Walk me through how you would design a rate limiter for a public REST API, considering both client-side and server-side approaches.',
  D_coding: 'Implement a function that finds the longest palindromic substring of a given string and explain its time complexity.',
  E_context: [
    { role: 'user', content: 'I built an e-commerce platform with Node.js microservices.' },
    { role: 'assistant', content: 'Understood — an e-commerce platform on Node.js microservices.' },
    { role: 'user', content: 'How did you handle authentication between those services?' }
  ],
  F_rag: [
    { role: 'system', content: SYSTEM_PROMPT + '\n\n[PROJECT CONTEXT]\nPROJECT: Real-Time AI Interview Assistant\nTECH: Electron, TypeScript, whisper.cpp, Ollama, Groq, SQLite\nARCHITECTURE: renderer mic capture -> VAD worker -> whisper-server HTTP -> orchestrator -> provider chain -> streaming IPC' },
    { role: 'user', content: 'Describe the architecture of your AI interview assistant project and why you chose local speech recognition.' }
  ]
}

const args = process.argv.slice(2)
const runsArg = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

function now() { return performance.now() }

async function benchOllama(messages) {
  const t0 = now()
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true })
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  const tHeaders = now()
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', tokens = 0, chars = 0, tFirst = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        const tok = j.message?.content ?? ''
        if (tok) {
          if (tFirst === null) tFirst = now()
          tokens++
          chars += tok.length
        }
      } catch { /* partial */ }
    }
  }
  return { headersMs: tHeaders - t0, ttftMs: tFirst !== null ? tFirst - t0 : null, tokens, chars, totalMs: now() - t0 }
}

async function benchGroq(messages) {
  const body = {
    model: GROQ_MODEL,
    messages,
    stream: true,
    max_tokens: 512,
    temperature: 0.7,
    ...( /qwen/i.test(GROQ_MODEL) ? { reasoning_effort: 'none' } : {} )
  }
  const t0 = now()
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const tHeaders = now()
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', tokens = 0, chars = 0, tFirst = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const j = JSON.parse(data)
        const tok = j.choices?.[0]?.delta?.content || ''
        if (tok) {
          if (tFirst === null) tFirst = now()
          tokens++
          chars += tok.length
        }
      } catch { /* partial line handled next read via buf */ }
    }
  }
  return { headersMs: tHeaders - t0, ttftMs: tFirst !== null ? tFirst - t0 : null, tokens, chars, totalMs: now() - t0 }
}

function toMessages(q) {
  if (typeof q === 'string') return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: q }]
  return q
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function runProvider(name, fn) {
  console.log(`\n=== ${name} (${name === 'groq' ? GROQ_MODEL : OLLAMA_MODEL}) ===`)
  const rows = {}
  for (const [key, q] of Object.entries(QUESTIONS)) {
    const attempts = []
    for (let i = 0; i < runsArg; i++) {
      try {
        const r = await fn(toMessages(q))
        r.tps = r.ttftMs ? ((r.tokens - 1) / ((r.totalMs - r.ttftMs) / 1000)).toFixed(1) : 'n/a'
        attempts.push(r)
        process.stdout.write('.')
      } catch (e) {
        if (i === 0) console.error(`\n  [${name}/${key}] ${e.message}`)
        process.stdout.write('x')
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    const ok = attempts.filter(Boolean)
    rows[key] = ok.length ? {
      ttft: med(ok.map((r) => Math.round(r.ttftMs))),
      headers: med(ok.map((r) => Math.round(r.headersMs))),
      tps: med(ok.map((r) => Number(r.tps) || 0)),
      total: med(ok.map((r) => Math.round(r.totalMs))),
      tokens: med(ok.map((r) => r.tokens)),
      chars: med(ok.map((r) => r.chars)),
      n: ok.length
    } : null
    console.log(` ${key}${rows[key] ? '' : ' FAILED'}`)
  }
  return rows
}

function printTable(name, rows) {
  console.log(`\n#### ${name} (median of successful runs)`)
  console.log('| Question | connect ms | TTFT ms | tok/s | total ms | out tokens | out chars | runs |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [k, r] of Object.entries(rows)) {
    if (!r) { console.log(`| ${k} | - | - | - | - | - | - | 0 |`); continue }
    console.log(`| ${k} | ${r.headers} | ${r.ttft} | ${r.tps} | ${r.total} | ${r.tokens} | ${r.chars} | ${r.n} |`)
  }
}

const results = {}
if (!only || only === 'ollama') results.ollama = await runProvider('ollama', benchOllama)
if (!only || only === 'groq' && process.env.GROQ_API_KEY) results.groq = await runProvider('groq', benchGroq)
else if (only === 'groq') { console.error('GROQ_API_KEY missing'); process.exit(1) }

console.log('\n\n================ BASELINE SUMMARY ================')
for (const [name, rows] of Object.entries(results)) printTable(name.toUpperCase(), rows)
