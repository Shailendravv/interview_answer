export interface Introduction {
  name: string
  title: string
  summary: string
  skills: string[]
}

export interface ProjectBody {
  role: string
  duration: string
  techStack: string[]
  architecture: string[]
  features: string[]
  challenges: string[]
  accomplishments: string[]
}

export interface ProjectConcept {
  id: string
  type: string
  title: string
  description: string
  tags: string[]
  keywords: string[]
  body: ProjectBody
}

export interface ProjectBundle {
  introduction: Introduction
  projects: ProjectConcept[]
}

export interface ProjectCardData {
  id: string
  title: string
  description: string
  tags: string[]
  role: string
  duration: string
  techStack: string[]
  architecture: string[]
  features: string[]
  challenges: string[]
  accomplishments: string[]
  notes: string
}

export interface ProjectListPayload {
  introduction: Introduction
  projects: ProjectCardData[]
}
