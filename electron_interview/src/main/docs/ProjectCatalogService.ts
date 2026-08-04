import { app } from 'electron'
import { readFileSync, watch, existsSync, copyFileSync, FSWatcher } from 'fs'
import { join } from 'path'
import {
  ProjectBundle,
  ProjectConcept,
  ProjectListPayload,
  ProjectCardData
} from './projectsTypes'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface ProjectKeywordEntry {
  project: string
  patterns: RegExp[]
}

const REFRESH_DEBOUNCE_MS = 300

export class ProjectCatalogService {
  private bundle: ProjectBundle = { introduction: { name: '', title: '', summary: '', skills: [] }, projects: [] }
  private index = new Map<string, ProjectConcept>()
  private promptBlocks = new Map<string, string>()
  private keywordEntries: ProjectKeywordEntry[] = []
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private listeners = new Set<() => void>()
  private jsonPath: string

  constructor() {
    this.jsonPath = this.resolveJsonPath()
    this.load()
    this.startWatching()
  }

  private resolveJsonPath(): string {
    if (app.isPackaged) {
      const userDataPath = join(app.getPath('userData'), 'projects.json')
      if (existsSync(userDataPath)) return userDataPath
      const bundledPath = join(process.resourcesPath, 'projects.json')
      if (existsSync(bundledPath)) {
        try {
          copyFileSync(bundledPath, userDataPath)
          return userDataPath
        } catch { /* fall through to bundled (read-only) */ }
      }
      return userDataPath
    }

    const candidates = [
      join(app.getAppPath(), 'projects.json'),
      join(__dirname, '../../projects.json'),
      join(__dirname, '../../../projects.json'),
      join(process.cwd(), 'projects.json')
    ]
    for (const candidate of candidates) {
      try {
        readFileSync(candidate, 'utf-8')
        return candidate
      } catch { /* try next */ }
    }
    return candidates[0]
  }

  private load(): void {
    try {
      const raw = readFileSync(this.jsonPath, 'utf-8')
      const parsed = JSON.parse(raw) as ProjectBundle
      if (parsed && Array.isArray(parsed.projects) && parsed.introduction) {
        this.bundle = parsed
      } else {
        console.warn('[projects] projects.json missing "introduction" or "projects" — using empty catalog')
      }
    } catch (err) {
      console.error('[projects] Failed to parse projects.json:', err)
    }
    this.rebuildIndexes()
  }

  private rebuildIndexes(): void {
    this.index.clear()
    this.promptBlocks.clear()
    this.keywordEntries = []

    for (const project of this.bundle.projects) {
      this.index.set(project.id, project)
      this.promptBlocks.set(project.id, this.buildPromptBlock(project))
      this.keywordEntries.push({ project: project.id, patterns: this.buildPatterns(project) })
    }
  }

  private buildPatterns(project: ProjectConcept): RegExp[] {
    const sources = [project.id, project.title, project.description, ...project.tags, ...project.keywords]
    const patterns: RegExp[] = []
    const seen = new Set<string>()
    for (const source of sources) {
      const words = normalizeText(source).split(' ').filter((w) => w.length > 0)
      for (const word of words) {
        const key = word.toLowerCase()
        if (seen.has(key) || word.length < 2) continue
        seen.add(key)
        patterns.push(new RegExp(`\\b${escapeRegExp(key)}\\b`, 'i'))
      }
    }
    return patterns
  }

  private buildPromptBlock(project: ProjectConcept): string {
    const b = project.body
    const lines: string[] = [
      `PROJECT: ${project.title}`,
      `DESCRIPTION: ${project.description}`
    ]
    if (b.role) lines.push(`ROLE: ${b.role}`)
    if (b.duration) lines.push(`DURATION: ${b.duration}`)
    if (b.techStack.length > 0) lines.push(`TECH: ${b.techStack.join(', ')}`)
    lines.push('ARCHITECTURE:', ...b.architecture.map((x) => `- ${x}`))
    lines.push('FEATURES:', ...b.features.map((x) => `- ${x}`))
    lines.push('CHALLENGES:', ...b.challenges.map((x) => `- ${x}`))
    lines.push('ACCOMPLISHMENTS:', ...b.accomplishments.map((x) => `- ${x}`))
    return lines.join('\n')
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.jsonPath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          this.load()
          for (const listener of this.listeners) listener()
        }, REFRESH_DEBOUNCE_MS)
      })
    } catch (err) {
      console.warn('[projects] fs.watch unavailable for projects.json:', err)
    }
  }

  onUpdate(listener: () => void): void {
    this.listeners.add(listener)
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  getIntroduction() {
    return this.bundle.introduction
  }

  getAllProjects(): ProjectConcept[] {
    return this.bundle.projects
  }

  getById(id: string): ProjectConcept | undefined {
    return this.index.get(id)
  }

  getPromptBlock(id: string): string | undefined {
    return this.promptBlocks.get(id)
  }

  getKeywordEntries(): ProjectKeywordEntry[] {
    return this.keywordEntries
  }

  detectProject(text: string): string | null {
    const normalized = normalizeText(text)
    if (!normalized) return null
    for (const entry of this.keywordEntries) {
      if (entry.patterns.some((p) => p.test(normalized))) return entry.project
    }
    return null
  }

  listProjectsForPrompt(): string {
    if (this.bundle.projects.length === 0) {
      return 'project_a through project_f'
    }
    return this.bundle.projects
      .map((p) => `${p.id} (${p.title}${p.description ? ': ' + p.description : ''})`)
      .join(', ')
  }

  buildClarifyBlock(): string {
    const titles = this.bundle.projects.map((p) => `- ${p.id} — ${p.title}`).join('\n')
    return `AVAILABLE PROJECTS:\n${titles || '- none'}\n\nAsk the user which project they are referring to before answering.`
  }

  getBundleForRenderer(): ProjectListPayload {
    const cards: ProjectCardData[] = this.bundle.projects.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      tags: p.tags,
      role: p.body.role,
      duration: p.body.duration,
      techStack: p.body.techStack,
      architecture: p.body.architecture,
      features: p.body.features,
      challenges: p.body.challenges,
      accomplishments: p.body.accomplishments,
      notes: this.promptBlocks.get(p.id) ?? ''
    }))
    return { introduction: this.bundle.introduction, projects: cards }
  }

  getProjectsJsonPath(): string {
    return this.jsonPath
  }

  destroy(): void {
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }
}
