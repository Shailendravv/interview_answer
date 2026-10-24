// Audio manifest format shared by the STT and end-to-end suites (bench/README.md).
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { appRoot } from './electronStub'

export interface ManifestQuestion {
  reference: string
  startMs?: number
  endMs?: number
  terms?: string[]
}

export interface ManifestItem {
  id: string
  file: string
  scenario?: string
  language: 'en' | 'hi' | 'hinglish'
  referenceScript?: 'latin' | 'devanagari' | 'mixed'
  speaker?: string
  accent?: string
  condition?: string
  verified: boolean
  pauseMs?: number
  questions: ManifestQuestion[]
}

export interface Manifest {
  version: number
  source: string
  representative: boolean
  items: ManifestItem[]
}

export function loadManifest(): { manifest: Manifest; path: string } {
  const local = join(appRoot, 'bench', 'audio', 'local', 'manifest.json')
  const synthetic = join(appRoot, 'bench', 'audio', 'synthetic', 'manifest.json')
  const path = process.env.EVAL_MANIFEST ? resolve(process.env.EVAL_MANIFEST) : existsSync(local) ? local : synthetic
  if (!existsSync(path)) {
    throw new Error(`No audio manifest at ${path}. Run \`node bench/scripts/make-synthetic-audio.mjs\` or add recordings (bench/README.md).`)
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  const scenarios = process.env.EVAL_SCENARIOS?.split(',').map((s) => s.trim())
  if (scenarios) manifest.items = manifest.items.filter((i) => scenarios.includes(i.scenario ?? 'single'))
  return { manifest, path }
}

export { matchCommits } from './textMetrics'
