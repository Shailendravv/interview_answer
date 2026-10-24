// Samples GPU memory/utilisation (nvidia-smi, one long-running process) and the
// memory/CPU of the external engines (whisper-server, ollama). Sampling is kept
// light so it does not perturb the latencies being measured.
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { summarize, Summary } from './stats'

// Ollama 0.30 runs models in a separate llama-server process.
const WATCHED = ['whisper-server', 'whisper-cli', 'ollama', 'llama-server']

interface ProcSnapshot {
  name: string
  id: number
  workingSetMB: number
  cpuSeconds: number
}

function snapshotProcesses(): ProcSnapshot[] {
  if (process.platform !== 'win32') return []
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-Process -Name ${WATCHED.join(',')} -ErrorAction SilentlyContinue | ` +
        `Select-Object Name,Id,WorkingSet64,CPU | ConvertTo-Json -Compress`
    ],
    { encoding: 'utf8' }
  )
  const raw = ps.stdout?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((p: { Name: string; Id: number; WorkingSet64: number; CPU: number | null }) => ({
      name: p.Name,
      id: p.Id,
      workingSetMB: Math.round(p.WorkingSet64 / 1048576),
      cpuSeconds: p.CPU ?? 0
    }))
  } catch {
    return []
  }
}

export interface ResourceReport {
  wallSeconds: number
  gpu: { memoryUsedMB: Summary | null; utilizationPct: Summary | null; totalMB: number | null } | null
  harnessRssMB: Summary | null
  processes: { name: string; peakWorkingSetMB: number; avgCpuCores: number | null }[]
}

export class ResourceSampler {
  private smi: ChildProcess | null = null
  private gpuMem: number[] = []
  private gpuUtil: number[] = []
  private gpuTotal: number | null = null
  private rss: number[] = []
  private peakWs = new Map<string, number>()
  private timers: ReturnType<typeof setInterval>[] = []
  private startSnap: ProcSnapshot[] = []
  private startedAt = 0

  start(): void {
    this.startedAt = performance.now()
    this.startSnap = snapshotProcesses()
    for (const p of this.startSnap) this.peakWs.set(p.name, Math.max(this.peakWs.get(p.name) ?? 0, p.workingSetMB))
    try {
      const smi = spawn('nvidia-smi', [
        '--query-gpu=memory.used,utilization.gpu,memory.total',
        '--format=csv,noheader,nounits',
        '-lms',
        '500'
      ])
      smi.on('error', () => { this.smi = null })
      // stdout chunks do not align with lines; only parse complete ones.
      let pending = ''
      smi.stdout?.on('data', (d: Buffer) => {
        pending += d.toString()
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const fields = line.split(',').map((x) => Number(x.trim()))
          if (fields.length !== 3 || !fields.every(Number.isFinite)) continue
          this.gpuMem.push(fields[0])
          this.gpuUtil.push(fields[1])
          this.gpuTotal = fields[2]
        }
      })
      this.smi = smi
    } catch {
      this.smi = null
    }
    this.timers.push(setInterval(() => this.rss.push(process.memoryUsage().rss / 1048576), 500))
    this.timers.push(
      setInterval(() => {
        for (const p of snapshotProcesses()) {
          this.peakWs.set(p.name, Math.max(this.peakWs.get(p.name) ?? 0, p.workingSetMB))
        }
      }, 3000)
    )
  }

  stop(): ResourceReport {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.smi?.kill()
    const end = snapshotProcesses()
    const wallSeconds = (performance.now() - this.startedAt) / 1000
    const names = new Set([...this.peakWs.keys(), ...end.map((p) => p.name)])
    const processes = [...names].map((name) => {
      for (const p of end.filter((e) => e.name === name)) {
        this.peakWs.set(name, Math.max(this.peakWs.get(name) ?? 0, p.workingSetMB))
      }
      // A process alive at both ends contributes its CPU delta; one started
      // inside the window spent all of its CPU time inside it.
      let cpu = 0
      let matched = false
      for (const e of end.filter((x) => x.name === name)) {
        const s = this.startSnap.find((x) => x.id === e.id)
        cpu += s ? e.cpuSeconds - s.cpuSeconds : e.cpuSeconds
        matched = true
      }
      return {
        name,
        peakWorkingSetMB: this.peakWs.get(name) ?? 0,
        avgCpuCores: matched && wallSeconds > 0 ? Math.round((cpu / wallSeconds) * 100) / 100 : null
      }
    })
    return {
      wallSeconds: Math.round(wallSeconds),
      gpu: this.gpuMem.length
        ? { memoryUsedMB: summarize(this.gpuMem), utilizationPct: summarize(this.gpuUtil), totalMB: this.gpuTotal }
        : null,
      harnessRssMB: summarize(this.rss),
      processes
    }
  }
}
