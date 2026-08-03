// Drop whisper hallucinations that are safe to route away from the LLM.
// Pure non-speech tags and pathological repetition loops ("What? What? What?...")
// carry no interview content; forwarding them pollutes the prompt.

const BRACKETED_TAG = /\[[^\]]*\]/g
const PAREN_ANNOTATION = /\([^)]*(?:music|applause|laughter|sfx|sound|tone|ringing|noise|static|beep|instrumental)[^)]*\)/gi
const MUSIC_NOTES = /♪/g

const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*/gu

function stripNonSpeechTags(text: string): string {
  return text
    .replace(BRACKETED_TAG, ' ')
    .replace(PAREN_ANNOTATION, ' ')
    .replace(MUSIC_NOTES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasDominantRepetition(text: string): boolean {
  const tokens = (text.match(TOKEN_PATTERN) || []).map((t) => t.toLowerCase())
  if (tokens.length < 3) return false

  let bestRun = 1
  let run = 1
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) {
      run++
      if (run > bestRun) bestRun = run
    } else {
      run = 1
    }
  }

  return bestRun >= 3 && bestRun / tokens.length >= 0.5
}

export function cleanTranscript(text: string): string | null {
  if (!text) return null

  const cleaned = stripNonSpeechTags(text)
  if (!cleaned) return null
  if (hasDominantRepetition(cleaned)) return null

  return cleaned
}
