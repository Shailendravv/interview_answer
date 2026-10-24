// Interviewer remarks that carry nothing to answer. Every committed transcript
// used to be answered -- "Okay, great." replaced the answer the candidate was
// reading, and could even supersede a real question waiting in the
// single-slot queue. Patterns match the WHOLE utterance and are deliberately
// narrow: answering a stray remark is a nuisance, dropping a real question is
// a failure, so anything with more content ("Okay, so what is a closure?")
// falls through.

const ACK =
  "(?:ok(?:ay)?|great|good|nice|cool|right|alright|all right|sure|yes|yeah|yep|no|nope|hmm+|h?m+|uh+|um+|mhm|uh-huh|" +
  'perfect|got it|i see|makes sense|interesting|awesome|fine|sounds good|excellent|wonderful|thanks|thank you(?: so much| very much)?)'

const ACK_ONLY = new RegExp(`^(?:${ACK})(?:[\\s,.!]+(?:${ACK}|so|then|now))*[\\s.!]*$`, 'i')

const META =
  /^(?:(?:can|could) you (?:hear|see) me(?: (?:now|okay|ok|clearly|properly))?|(?:is|am) (?:my|i) (?:audio|voice|sound|mic|audible)(?: (?:clear|okay|ok|fine|working))?|can you see my screen)[\s?.!]*$/i

const TRANSITION =
  /^(?:(?:okay|ok|alright|great|so)[,\s]+)?(?:(?:let'?s|we can|we'll)\s+(?:move on|continue|proceed|start|begin|get started)(?:\s+(?:to|with)\s+(?:the\s+)?next\s+(?:topic|question|one|section|round))?|moving on|next question)[\s.!]*$/i

const CLOSING =
  /^(?:(?:okay|ok|great|alright)[,\s]+)?(?:(?:thank you|thanks)(?: (?:so|very) much)?[,.!\s]*)?(?:that'?s (?:all|it)(?: (?:for|from) (?:today|now|me|my side))?|that is all(?: for today)?|we are done|we're done)[\s.!]*$/i

const MAX_WORDS = 10

export function isChitChat(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.split(/\s+/).length > MAX_WORDS) return false
  return ACK_ONLY.test(t) || META.test(t) || TRANSITION.test(t) || CLOSING.test(t)
}
