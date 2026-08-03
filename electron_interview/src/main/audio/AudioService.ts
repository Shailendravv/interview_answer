import { BrowserWindow, ipcMain } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { IPC } from '../../shared/ipcChannels'
import { STTEngine } from '../../shared/stt/sttProvider'
import { createSttService, SttServiceConfig } from '../stt/SttService'
import { SentenceDetector } from '../stt/SentenceDetector'
import { cleanTranscript } from '../stt/transcriptFilter'

export type TranscriptCallback = (text: string) => void

export class AudioService {
  private isCapturing = false
  private window: BrowserWindow | null = null
  private worker: Worker | null = null
  private segments: Buffer[] = []
  private workerReady = false
  private stt: STTEngine
  private sentenceDetector: SentenceDetector
  private onFinalTranscript: TranscriptCallback | null = null
  private sttInit: Promise<void> | null = null
  private lastRestartAt = 0

  constructor(private sttConfig: SttServiceConfig, private debug = false) {
    this.stt = createSttService(this.sttConfig)
    this.sentenceDetector = new SentenceDetector(this.sttConfig.silenceTimeoutMs)
    this.registerHandlers()
    this.setupSttListeners()
    this.sentenceDetector.setOnComplete((text) => {
      this.window?.webContents.send(IPC.TRANSCRIPT_FINAL, text)
      this.onFinalTranscript?.(text)
    })
  }

  async initStt(): Promise<void> {
    if (this.sttInit) return this.sttInit
    this.sttInit = this.stt.start().finally(() => {
      this.sttInit = null
    })
    return this.sttInit
  }

  setOnFinalTranscript(cb: TranscriptCallback): void {
    this.onFinalTranscript = cb
  }

  setWindow(win: BrowserWindow): void {
    this.window = win
  }

  private registerHandlers(): void {
    ipcMain.on(IPC.AUDIO_START, () => {
      this.startCapture()
    })

    ipcMain.on(IPC.AUDIO_CHUNK, (_event, buffer: ArrayBuffer) => {
      if (!this.isCapturing || !this.workerReady) return
      this.worker?.postMessage({ type: 'chunk', data: buffer })
    })

    ipcMain.on(IPC.AUDIO_STOP, () => {
      this.stopCapture()
    })
  }

  private async startCapture(): Promise<void> {
    // A previous session may have died with an /inference request still hanging
    // (busy stuck). Force-reset so the new session can't queue behind it.
    try {
      if (this.isCapturing) {
        console.warn('[audio] startCapture called while capturing. Forcing reset.')
        this.stopCapture()
      }
      this.stt?.cancel()
    } catch (err) {
      console.warn('[audio] Failed to reset previous capture state; continuing.', err)
    }

    this.segments = []
    this.isCapturing = true
    this.workerReady = false
    this.sentenceDetector.reset()

    // If the engine is still loading (started at launch), wait for it before feeding audio.
    try {
      await this.sttInit
    } catch { /* engine failed to start; Noop/fallback path still runs */ }

    this.spawnWorker()
    this.sendStatus('listening')
  }

  private setupSttListeners(): void {
    if (!this.stt) return

    this.stt.on('transcript', (text, isFinal) => {
      if (this.debug) {
        console.log(`[stt] transcript final=${isFinal} text="${text}"`)
      }

      const cleaned = cleanTranscript(text)
      if (!cleaned) {
        if (this.debug) {
          console.log(`[stt] filtered transcript="${text}"`)
        }
        return
      }

      const completed = this.sentenceDetector.feedChunk(cleaned, isFinal)
      if (!completed) {
        this.window?.webContents.send(IPC.TRANSCRIPT_INTERIM, text)
        if (text.includes('?')) {
          this.onFinalTranscript?.(text)
        }
      }
    })

    this.stt.on('error', async (err) => {
      this.window?.webContents.send(IPC.ERROR_OCCURRED, err.message)
      this.window?.webContents.send(IPC.STT_STATUS, { engine: 'none', error: err.message })

      if (this.isCapturing) {
        const now = Date.now()
        if (now - this.lastRestartAt < 5000) return
        this.lastRestartAt = now
        try {
          await this.stt?.start()
        } catch { /* ignore rebuild failures */ }
      }
    })

    this.stt.on('status', (info: { engine: string; error: string | null }) => {
      this.window?.webContents.send(IPC.STT_STATUS, info)
    })
  }

  private spawnWorker(): void {
    if (this.worker) {
      this.worker.terminate()
    }

    this.worker = new Worker(join(__dirname, 'audioWorker.js'))

    this.worker.postMessage({
      type: 'config',
      config: {
        padFrames: this.sttConfig.vadPadFrames ?? 10,
        maxSegmentFrames: this.maxSegmentFrames()
      }
    })

    this.worker.on('message', (msg: { type: string; data?: ArrayBuffer }) => {
      if (msg.type === 'ready') {
        this.workerReady = true
      } else if (msg.type === 'segment' && msg.data) {
        const buf = Buffer.from(msg.data)
        this.segments.push(buf)
        this.stt?.feedAudioChunk(buf)
        this.stt?.finalize()
      } else if (msg.type === 'error') {
        console.error('Audio worker error:', msg)
      }
    })

    this.worker.on('error', (err) => {
      console.error('Audio worker thread error:', err)
      this.workerReady = false
    })
  }

  private stopCapture(): void {
    this.isCapturing = false
    this.worker?.postMessage({ type: 'flush' })

    this.stt?.finalize()

    const leftover = this.sentenceDetector.flush()
    if (leftover) {
      this.window?.webContents.send(IPC.TRANSCRIPT_FINAL, leftover)
      this.onFinalTranscript?.(leftover)
    }

    this.worker?.terminate()
    this.worker = null
    this.workerReady = false

    this.sendStatus('idle')
  }

  private sendStatus(status: string): void {
    this.window?.webContents.send(IPC.STATUS_UPDATE, { status })
  }

  private maxSegmentFrames(): number {
    const ms = this.sttConfig.vadMaxSegmentMs ?? 8000
    const frames = Math.round((ms / 1000) * 16000 / 512)
    return Math.max(1, frames)
  }

  destroy(): void {
    this.isCapturing = false
    this.worker?.terminate()
    this.worker = null
    this.stt?.stop()
    this.segments = []
  }
}
