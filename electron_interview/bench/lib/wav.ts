import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { captureMode, simulateCapture } from './captureSim'

export const SAMPLE_RATE = 16000

interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  format: number
  data: Buffer
}

function parseWav(buf: Buffer): WavInfo {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let pos = 12
  let fmt: Omit<WavInfo, 'data'> | null = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      }
    } else if (id === 'data' && fmt) {
      return { ...fmt, data: buf.subarray(body, Math.min(buf.length, body + size)) }
    }
    pos = body + size + (size % 2)
  }
  throw new Error('WAV has no fmt/data chunk')
}

function ffmpegTo16kMono(path: string): Buffer {
  const out = join(mkdtempSync(join(tmpdir(), 'eval-wav-')), 'converted.wav')
  const res = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path, '-ac', '1', '-ar', String(SAMPLE_RATE), '-sample_fmt', 's16', out])
  if (res.error || res.status !== 0) {
    throw new Error(
      `"${path}" is not 16 kHz mono PCM16 and ffmpeg could not convert it ` +
        `(${res.error?.message ?? res.stderr?.toString().trim()}). Install ffmpeg or convert it first.`
    )
  }
  return readFileSync(out)
}

/**
 * Loads any audio file as 16 kHz mono PCM16 -- the format the renderer hands
 * the main process. Non-conforming files are converted with ffmpeg.
 */
export function loadPcm16(path: string): Int16Array {
  // --capture=legacy|sinc: route the clip through the renderer's 48 kHz path.
  const mode = captureMode()
  if (mode) return simulateCapture(path, mode, SAMPLE_RATE)
  let info = parseWav(readFileSync(path))
  if (info.format !== 1 || info.bitsPerSample !== 16 || info.channels !== 1 || info.sampleRate !== SAMPLE_RATE) {
    info = parseWav(ffmpegTo16kMono(path))
  }
  const samples = new Int16Array(info.data.length / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = info.data.readInt16LE(i * 2)
  return samples
}

export function writePcm16(path: string, samples: Int16Array, sampleRate = SAMPLE_RATE): void {
  const header = Buffer.alloc(44)
  const dataSize = samples.length * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  const body = Buffer.alloc(dataSize)
  for (let i = 0; i < samples.length; i++) body.writeInt16LE(samples[i], i * 2)
  writeFileSync(path, Buffer.concat([header, body]))
}

export function msToSamples(ms: number): number {
  return Math.round((ms / 1000) * SAMPLE_RATE)
}
