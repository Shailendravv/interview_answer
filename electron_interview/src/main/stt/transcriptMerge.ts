/** Words shared across a segment boundary that whisper may repeat on both sides. */
const MAX_OVERLAP_WORDS = 8

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.,!?;:]+/g, '')
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim()
}

/**
 * Joins two transcripts of the same utterance.
 *
 * Providers disagree about what a second transcript means, so this cannot be a
 * plain append:
 *  - whisper (server and cli) clears its buffer per inference, so consecutive
 *    transcripts cover DISJOINT audio -- appending is right, replacing loses
 *    the first half of the question.
 *  - Deepgram sends CUMULATIVE interim results for one utterance
 *    ("how" -> "how does" -> "how does node"), where appending would produce
 *    "how how does how does node".
 *
 * Detecting which case applies from the text itself keeps this provider-
 * agnostic, and also absorbs the word or two whisper tends to repeat either
 * side of a segment boundary.
 */
export function mergeTranscript(prev: string, next: string): string {
  const a = prev?.trim() ?? ''
  const b = next?.trim() ?? ''
  if (!a) return tidy(b)
  if (!b) return tidy(a)

  // Cumulative provider: the new transcript already contains the old one.
  if (normalize(b).startsWith(normalize(a))) return tidy(b)

  const prevWords = words(a)
  const nextWords = words(b)

  // Disjoint provider: drop any tail of `prev` that `next` repeats.
  const maxOverlap = Math.min(MAX_OVERLAP_WORDS, prevWords.length, nextWords.length)
  for (let n = maxOverlap; n > 0; n--) {
    const tail = prevWords.slice(prevWords.length - n).map(normalize).join(' ')
    const head = nextWords.slice(0, n).map(normalize).join(' ')
    if (tail && tail === head) {
      return tidy([...prevWords, ...nextWords.slice(n)].join(' '))
    }
  }

  return tidy(`${a} ${b}`)
}
