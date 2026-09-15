// Turns a catalog project into the cue cards you glance at while explaining
// it out loud. Pure and Electron-free so it can be unit-tested directly.
//
// Nothing here invents content: every line comes from projects.json. The
// bullets there are already written as full sentences and body.architecture
// is already ordered as a walkthrough (source -> processing -> backend ->
// frontend -> AI), so the cards mostly re-frame and cap what exists.

import type { InterviewScript, InterviewScriptCard, InterviewScriptCardId } from '../../shared/interviewScript'
import type { ProjectConcept } from './projectsTypes'

// Preview sizes keep each card glanceable mid-sentence. Every line is still
// sent — the panel reveals the rest on "Show all N".
const HOW_PREVIEW = 5
const WHAT_PREVIEW = 5
const HARD_PREVIEW = 3
const IMPACT_PREVIEW = 3
const TECH_HEADLINE_LIMIT = 5
const FOLLOWUP_TECH_LIMIT = 4
const FOLLOWUP_CHALLENGE_LIMIT = 2
const FOLLOWUP_SNIPPET_CHARS = 72

function clean(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter(Boolean)
}

function buildCard(
  id: InterviewScriptCardId,
  label: string,
  timing: string | undefined,
  items: string[] | undefined,
  previewCount: number,
  numbered = false
): InterviewScriptCard | null {
  const lines = clean(items)
  if (lines.length === 0) return null
  const card: InterviewScriptCard = {
    id,
    label,
    lines,
    previewCount
  }
  if (timing) card.timing = timing
  if (numbered) card.numbered = true
  return card
}

// Challenges run 120-190 characters, far too long to read as a question stem.
// Cut at a word boundary rather than mid-word.
function snippet(text: string, max = FOLLOWUP_SNIPPET_CHARS): string {
  const trimmed = text.trim().replace(/\.$/, '')
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// "Walk me through:" rather than a verb that has to agree with whatever the
// challenge happens to start with — those are gerund phrases of every shape.
function buildFollowups(project: ProjectConcept): string[] {
  const tech = clean(project.body?.techStack).slice(0, FOLLOWUP_TECH_LIMIT)
  const challenges = clean(project.body?.challenges).slice(0, FOLLOWUP_CHALLENGE_LIMIT)
  return [
    ...tech.map((item) => `Why ${item}?`),
    ...challenges.map((item) => `Walk me through: ${snippet(item)}`)
  ]
}

export function buildInterviewScript(project: ProjectConcept): InterviewScript {
  const body = project.body
  const followups = buildFollowups(project)

  const cards = [
    buildCard('how', 'How it works', '~90s', body?.architecture, HOW_PREVIEW, true),
    buildCard('what', 'What it does', '~45s', body?.features, WHAT_PREVIEW),
    // These state the problem only — projects.json carries no matching fix, so
    // the card cues the challenge and you narrate the solution.
    buildCard('hard', 'Hard parts', '~60s', body?.challenges, HARD_PREVIEW),
    buildCard('impact', 'Impact', '~30s', body?.accomplishments, IMPACT_PREVIEW),
    buildCard('followups', "They'll likely ask", undefined, followups, followups.length)
  ].filter((card): card is InterviewScriptCard => card !== null)

  return {
    pitch: (project.description || project.title || '').trim(),
    role: (body?.role ?? '').trim(),
    duration: (body?.duration ?? '').trim(),
    techStack: clean(body?.techStack).slice(0, TECH_HEADLINE_LIMIT),
    cards
  }
}
