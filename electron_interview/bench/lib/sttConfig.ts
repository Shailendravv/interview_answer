// Mirrors the STT configuration src/main/index.ts builds at startup. index.ts
// cannot be imported (it boots the app), so the defaults are duplicated here
// and `checkConfigDrift()` verifies each one still appears in index.ts.
import { config as loadEnv } from 'dotenv'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { appRoot } from './electronStub'
import type { SttServiceConfig } from '../../src/main/stt/SttService'

export const DEFAULT_STT_PROMPT = 'Interview question and answer conversation, clear English speech.'

const DRIFT_MARKERS = [
  `"${DEFAULT_STT_PROMPT}"`,
  'Number(process.env.WHISPER_NO_SPEECH_THRESHOLD) || 0.6',
  'Number(process.env.SILENCE_TIMEOUT_MS) || 750',
  'return 350;',
  'Number(process.env.VAD_PREROLL_MS) || 300',
  'Number(process.env.VAD_MAX_SEGMENT_MS) || 8000',
  'Number(process.env.CONTINUATION_GRACE_MS) || 900',
  '"ggml-small.en.bin"',
  'binSubdir = isWindows ? ["build", "bin", "Release"]',
  'const dir = `build-${build}`;',
  'resolveGpuServerPath("cuda")',
  'resolveGpuServerPath("vulkan")',
  'if (process.env.WHISPER_SERVER_BINARY_PATH) return undefined;',
  'gpu === "0" || gpu === "false"',
  'whisperLanguage: process.env.STT_LANGUAGE || undefined'
]

/** Markers of index.ts defaults that are no longer present (empty = in sync). */
export function checkConfigDrift(): string[] {
  const src = readFileSync(join(appRoot, 'src', 'main', 'index.ts'), 'utf8')
  return DRIFT_MARKERS.filter((m) => !src.includes(m))
}

let envLoaded = false
/** Same .env the app loads in dev (`resolve(__dirname, '../../.env')`). */
export function loadAppEnv(): void {
  if (envLoaded) return
  envLoaded = true
  const path = join(appRoot, '.env')
  if (existsSync(path)) loadEnv({ path, quiet: true })
}

export type Engine = 'cpu' | 'cuda' | 'vulkan'

export interface EvalSttConfig {
  engine: Engine
  config: SttServiceConfig
  /** Human-readable note on where each value came from (no secrets). */
  provenance: Record<string, string>
}

/**
 * The production STT config, except for:
 *  - port: 18090, so a running app on 8080 is never reused or disturbed;
 *  - EVAL_ENGINE=cpu | cuda | vulkan: force one server build, with the CPU
 *    build as its fallback (default 'auto' mirrors the app: CUDA, then Vulkan,
 *    then CPU, each when present);
 *  - EVAL_WHISPER_MODEL: evaluate another model file without touching .env.
 */
export function evalSttConfig(): EvalSttConfig {
  loadAppEnv()
  const forced = (['cpu', 'cuda', 'vulkan'] as const).find((e) => e === process.env.EVAL_ENGINE) ?? null
  const whisperDir = resolve(appRoot, '..', 'whisper.cpp')
  const exe = process.platform === 'win32' ? '.exe' : ''
  const binSubdir = process.platform === 'win32' ? ['bin', 'Release'] : ['bin']
  const cpuBin = (name: string): string => join(whisperDir, 'build', ...binSubdir, name + exe)
  const gpuBin = (build: 'cuda' | 'vulkan'): string => join(whisperDir, `build-${build}`, ...binSubdir, 'whisper-server' + exe)

  const modelPath =
    process.env.EVAL_WHISPER_MODEL || process.env.WHISPER_MODEL_PATH || join(whisperDir, 'models', 'ggml-small.en.bin')
  const serverBinary = process.env.WHISPER_SERVER_BINARY_PATH || cpuBin('whisper-server')
  // Mirrors resolveGpuServerPath() in src/main/index.ts.
  const gpu = (process.env.WHISPER_GPU || '').toLowerCase()
  const autoGpu = (build: 'cuda' | 'vulkan'): string | undefined => {
    if (gpu === '0' || gpu === 'false' || process.platform === 'darwin') return undefined
    if ((gpu === 'cuda' || gpu === 'vulkan') && gpu !== build) return undefined
    const override = build === 'cuda' ? process.env.WHISPER_CUDA_SERVER_BINARY_PATH : process.env.WHISPER_VULKAN_SERVER_BINARY_PATH
    if (override) return override
    if (process.env.WHISPER_SERVER_BINARY_PATH) return undefined
    return existsSync(gpuBin(build)) ? gpuBin(build) : undefined
  }
  const gpuServer = (build: 'cuda' | 'vulkan'): string | undefined =>
    forced ? (forced === build ? gpuBin(build) : undefined) : autoGpu(build)
  const cudaServer = gpuServer('cuda')
  const vulkanServer = gpuServer('vulkan')
  const engine: Engine = cudaServer ? 'cuda' : vulkanServer ? 'vulkan' : 'cpu'
  const cliBinary = process.env.WHISPER_BINARY_PATH || cpuBin('whisper-cli')
  const prompt = process.env.STT_PROMPT || process.env.WHISPER_INITIAL_PROMPT || DEFAULT_STT_PROMPT

  const hangover = (() => {
    const explicit = Number(process.env.VAD_HANGOVER_MS)
    if (explicit > 0) return explicit
    const frames = Number(process.env.VAD_PAD_FRAMES)
    return frames > 0 ? frames * 32 : 350
  })()

  const config: SttServiceConfig = {
    mode: 'whisper',
    whisperModelPath: modelPath,
    whisperBinaryPath: cliBinary,
    whisperServerBinaryPath: serverBinary,
    whisperCudaServerBinaryPath: cudaServer,
    whisperVulkanServerBinaryPath: vulkanServer,
    whisperServerHost: '127.0.0.1',
    whisperServerPort: 18090,
    whisperInitialPrompt: prompt,
    whisperLanguage: process.env.EVAL_WHISPER_LANG || process.env.STT_LANGUAGE || undefined,
    whisperNoSpeechThreshold: Number(process.env.WHISPER_NO_SPEECH_THRESHOLD) || 0.6,
    silenceTimeoutMs: Number(process.env.SILENCE_TIMEOUT_MS) || 750,
    vadHangoverMs: hangover,
    vadPreRollMs: Number(process.env.VAD_PREROLL_MS) || 300,
    vadMaxSegmentMs: Number(process.env.VAD_MAX_SEGMENT_MS) || 8000,
    continuationGraceMs: Number(process.env.CONTINUATION_GRACE_MS) || 900
  }

  return {
    engine,
    config,
    provenance: {
      engine: forced ? `EVAL_ENGINE=${forced} (evaluation override)` : `${engine} (production auto: CUDA, then Vulkan, then CPU, each if present)`,
      model: process.env.EVAL_WHISPER_MODEL ? 'EVAL_WHISPER_MODEL (evaluation override)' : process.env.WHISPER_MODEL_PATH ? '.env WHISPER_MODEL_PATH' : 'production default',
      sttPrompt: process.env.STT_PROMPT ? '.env STT_PROMPT' : process.env.WHISPER_INITIAL_PROMPT ? '.env WHISPER_INITIAL_PROMPT' : 'production default',
      port: '18090 (evaluation; app uses 8080)'
    }
  }
}
