// STT engine-chain smoke test against real binaries: which engine ends up
// serving, and how long startup takes, when the CUDA and Vulkan builds can
// and cannot load.
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => {
  const m = await import('./lib/electronStub')
  return { ...m.electronModule, default: m.electronModule }
})

import { copyFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSttService, FallbackSTTEngine } from '../src/main/stt/SttService'
import { evalSttConfig } from './lib/sttConfig'
import { captureConsole, createRunDir, out } from './lib/report'
import { loadPcm16, SAMPLE_RATE } from './lib/wav'
import { appRoot } from './lib/electronStub'

async function startChain(gpu: { cuda?: string; vulkan?: string }, port: number) {
  const { config } = evalSttConfig()
  const chain = createSttService({
    ...config,
    whisperCudaServerBinaryPath: gpu.cuda,
    whisperVulkanServerBinaryPath: gpu.vulkan,
    whisperServerPort: port
  }) as FallbackSTTEngine
  const t0 = performance.now()
  await chain.start()
  const startupMs = Math.round(performance.now() - t0)
  // Prove the serving engine actually transcribes.
  const clip = join(appRoot, '..', 'whisper.cpp', 'samples', 'jfk.wav')
  const pcm = loadPcm16(clip).slice(0, SAMPLE_RATE * 3)
  const text = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('(timeout)'), 60_000)
    chain.on('transcript', (t: string, isFinal: boolean) => {
      if (isFinal) {
        clearTimeout(timer)
        resolve(t)
      }
    })
    chain.feedAudioChunk(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    chain.finalize()
  })
  const engine = chain.currentEngineName
  chain.stop()
  return { engine, startupMs, text }
}

describe('STT engine fallback (real binaries)', () => {
  it('serves from CUDA, then Vulkan, then the CPU build, as each can load', async () => {
    const run = createRunDir('fallback')
    const capture = captureConsole(`${run.dir}/app.log`)
    try {
      const gpuExe = (build: string): string => join(appRoot, '..', 'whisper.cpp', build, 'bin', 'Release', 'whisper-server.exe')
      // The exe without its DLLs behaves like a machine without that GPU runtime.
      const broken = (exe: string): string => {
        const copy = join(mkdtempSync(join(tmpdir(), 'gpu-broken-')), 'whisper-server.exe')
        copyFileSync(exe, copy)
        return copy
      }
      const realCuda = gpuExe('build-cuda')
      const realVulkan = gpuExe('build-vulkan')
      const cases: { label: string; gpu: { cuda?: string; vulkan?: string }; expected: string }[] = [
        { label: 'CUDA and Vulkan cannot load (no DLLs)', gpu: { cuda: broken(realCuda), vulkan: broken(realVulkan) }, expected: 'whisper-server' },
        { label: 'CUDA cannot load, Vulkan available', gpu: { cuda: broken(realCuda), vulkan: realVulkan }, expected: 'whisper-server-vulkan' },
        { label: 'CUDA and Vulkan available', gpu: { cuda: realCuda, vulkan: realVulkan }, expected: 'whisper-server-cuda' }
      ]
      const results = []
      for (const [i, c] of cases.entries()) {
        const res = await startChain(c.gpu, 18091 + i)
        results.push({ ...c, ...res })
        expect(res.engine, c.label).toBe(c.expected)
      }

      const md = [
        '# STT engine fallback',
        '',
        '| Case | Serving engine | Chain startup | Transcript of jfk.wav (3 s) |',
        '|---|---|---|---|',
        ...results.map((r) => `| ${r.label} | ${r.engine} | ${r.startupMs} ms | ${r.text} |`)
      ].join('\n')
      run.writeJson('results.json', { results })
      run.writeText('summary.md', md)
      out(md)
    } finally {
      capture.restore()
    }
  })
})
