import { mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { appRoot } from './electronStub'

export interface RunDir {
  dir: string
  writeJson(name: string, data: unknown): void
  writeText(name: string, text: string): void
}

export function createRunDir(track: string): RunDir {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(appRoot, 'bench', 'results', `${stamp}_${track}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    writeJson: (name, data) => writeFileSync(join(dir, name), JSON.stringify(data, null, 2)),
    writeText: (name, text) => writeFileSync(join(dir, name), text)
  }
}

export interface ConsoleCapture {
  lines: { t: number; level: string; args: unknown[] }[]
  restore(): void
}

/**
 * Routes the app's console output to a log file in the run directory (and
 * keeps it in memory for parsing, e.g. the orchestrator's "[route]" lines).
 * Harness output goes through `out()` so it stays readable.
 */
export function captureConsole(logPath: string): ConsoleCapture {
  const verbose = process.env.EVAL_VERBOSE === '1'
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
  const lines: ConsoleCapture['lines'] = []
  for (const level of Object.keys(original) as (keyof typeof original)[]) {
    console[level] = (...args: unknown[]): void => {
      lines.push({ t: performance.now(), level, args })
      const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack : JSON.stringify(a))).join(' ')
      appendFileSync(logPath, `[${level}] ${text}\n`)
      if (verbose) original[level](...args)
    }
  }
  return {
    lines,
    restore: () => Object.assign(console, original)
  }
}

export function out(text: string): void {
  process.stdout.write(text + '\n')
}

export function routeLogs(capture: ConsoleCapture, since = 0): Record<string, unknown>[] {
  return capture.lines
    .filter((l) => l.t >= since && l.args[0] === '[route]' && typeof l.args[1] === 'string')
    .map((l) => JSON.parse(l.args[1] as string))
}
