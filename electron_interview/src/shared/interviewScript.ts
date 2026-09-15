// Shape of the "how do I explain this project" cue cards shown in the
// project script panel. Lives in shared/ because both tsconfig.node and
// tsconfig.web include src/shared/**/* — the builder runs in main, the
// renderer only draws the result.

export type InterviewScriptCardId =
  | 'how'
  | 'what'
  | 'hard'
  | 'impact'
  | 'followups'

export interface InterviewScriptCard {
  id: InterviewScriptCardId
  /** Card heading, e.g. "How it works". */
  label: string
  /** Rough speaking time, e.g. "~90s". Omitted where timing is meaningless. */
  timing?: string
  /** Every line for this card. The panel shows previewCount of them first. */
  lines: string[]
  /** How many lines to show before "Show all N"; >= lines.length means all. */
  previewCount: number
  /** Render lines as an ordered walkthrough rather than bullets. */
  numbered?: boolean
}

// The opening is not a card: it is always visible, has no chevron, and is
// built from the fields below rather than from a bullet list.
export interface InterviewScript {
  /** One or two sentences to open with. */
  pitch: string
  /** body.role — empty string when unset. */
  role: string
  /** body.duration — empty string when unset (true for every project today). */
  duration: string
  /** Headline technologies to name in the opening. */
  techStack: string[]
  cards: InterviewScriptCard[]
}
