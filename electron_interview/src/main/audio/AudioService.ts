import { BrowserWindow, ipcMain } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { IPC } from '../../shared/ipcChannels'
import { STTEngine } from '../../shared/stt/sttProvider'
import { createSttService, SttServiceConfig } from '../stt/SttService'
import { SentenceDetector } from '../stt/SentenceDetector'
import { cleanTranscript } from '../stt/transcriptFilter'
import { mergeTranscript } from '../stt/transcriptMerge'
import { latencyTracer } from '../telemetry/LatencyTracer'
import type { SegmentMeta } from '../../audio/audioWorker'

export type TranscriptCallback = (text: string) => void

interface WorkerMessage {
  type: string
  data?: ArrayBuffer
  meta?: SegmentMeta
}

// A transcript arrives ~250-600ms after its segment closed (whisper RTT), by
// which time the VAD has usually already told us whether the speaker carried
// on. If they did, the transcript in hand is only half a question, so hold it
// and merge it with what follows rather than answering the fragment.
const CONTINUATION_TIMEOUT_MS = 4000
// How long after end-of-speech a continuation is still considered part of the
// same question. Must exceed the speaker's natural mid-sentence pause: measured
// on a real interview recording, intra-question pauses reached 736ms while gaps
// BETWEEN questions were never below 1792ms, so the boundary sits in between.
// Whisper's round-trip runs inside this window rather than after it, so the
// wait is mostly free.
const DEFAULT_CONTINUATION_GRACE_MS = 900
// Keep a joined utterance under whisper's MAX_CHUNK_BYTES (256KB) so it is
// transcribed in one request rather than split into serialized ones.
const MAX_JOINED_BYTES = 250 * 1024
// Bound the hold so a long monologue cannot defer an answer indefinitely.
const MAX_CONTINUATION_SEGMENTS = 4
// The VAD confirms resumed speech only after minSpeechMs (96ms) of loud
// frames, plus up to one capture chunk (~85ms) and a soft onset ("a process
// ..."), so a speaker resuming after a 600-800ms pause could lose the race
// against the commit timer: on exact synthetic pauses, 3 of 4 questions with an
// 800ms pause were answered as two fragments despite the 900ms grace. When the
// first loud frame of a possible onset arrives while a commit is pending, the
// commit waits this long (once per utterance) for speech-start to confirm it.
// Silence after a finished question never triggers it, so latency is unchanged.
const ACTIVITY_HOLD_MS = 300

export class AudioService {
  private isCapturing = false
  private window: BrowserWindow | null = null
  private worker: Worker | null = null
  private workerReady = false
  private stt: STTEngine
  private sentenceDetector: SentenceDetector
  private onFinalTranscript: TranscriptCallback | null = null
  private onSpeechStart: (() => void) | null = null
  /** True between a VAD speech onset and the segment close that ends it. */
  private speechInProgress = false
  private pendingUtterance: string | null = null
  private continuationCount = 0
  private continuationTimer: ReturnType<typeof setTimeout> | null = null
  private commitTimer: ReturnType<typeof setTimeout> | null = null
  /** Wall-clock time the pending commit is due (valid while commitTimer is set). */
  private commitDueAt = 0
  /** Last first-loud-frame hint from the VAD (a possible speech onset). */
  private lastActivityAt = 0
  private activityHoldUsed = false
  /** Wall-clock estimate of when the speaker actually stopped talking. */
  private lastEndOfSpeechAt = 0
  /** Audio of the utterance in progress, across continuation segments. */
  private utteranceAudio: Buffer[] = []
  private awaitingJoinedTranscript = false
  private sttInit: Promise<void> | null = null
  private lastRestartAt = 0
  private muted = false

  private get continuationGraceMs(): number {
    return this.sttConfig.continuationGraceMs ?? DEFAULT_CONTINUATION_GRACE_MS
  }

  constructor(private sttConfig: SttServiceConfig, private debug = false) {
    this.stt = createSttService(this.sttConfig)
    this.sentenceDetector = new SentenceDetector(this.sttConfig.silenceTimeoutMs)
    this.registerHandlers()
    this.setupSttListeners()
    this.sentenceDetector.setOnComplete((text) => {
      this.handleUtteranceComplete(text)
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

  /** Fired when the VAD detects speech, before any transcript exists. */
  setOnSpeechStart(cb: () => void): void {
    this.onSpeechStart = cb
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

    ipcMain.on(IPC.AUDIO_MUTE, (_event, muted: boolean) => {
      this.muted = Boolean(muted)
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

    this.isCapturing = true
    this.workerReady = false
    this.sentenceDetector.reset()
    this.clearContinuationTimeout()
    this.clearCommitTimer()
    this.pendingUtterance = null
    this.continuationCount = 0
    this.speechInProgress = false
    this.utteranceAudio = []
    this.awaitingJoinedTranscript = false

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
      if (this.muted) return

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
        hangoverMs: this.sttConfig.vadHangoverMs ?? 350,
        preRollMs: this.sttConfig.vadPreRollMs ?? 300,
        maxSegmentMs: this.sttConfig.vadMaxSegmentMs ?? 8000
      }
    })

    this.worker.on('message', (msg: WorkerMessage) => this.handleWorkerMessage(msg))

    this.worker.on('error', (err) => {
      console.error('Audio worker thread error:', err)
      this.workerReady = false
    })
  }

  private handleWorkerMessage(msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      this.workerReady = true
      return
    }

    if (msg.type === 'activity') {
      this.lastActivityAt = Date.now()
      if (this.commitTimer && !this.activityHoldUsed) {
        this.activityHoldUsed = true
        this.scheduleCommit(Math.max(this.commitDueAt - Date.now(), ACTIVITY_HOLD_MS))
      }
      return
    }

    if (msg.type === 'speech-start') {
      this.speechInProgress = true
      // The speaker resumed inside the grace window, so a transcript waiting to
      // commit is only half a question. Keep holding it and merge what follows.
      if (this.commitTimer) {
        this.clearCommitTimer()
        this.continuationCount++
        this.armContinuationTimeout()
      }
      this.onSpeechStart?.()
      return
    }

    if (msg.type === 'segment' && msg.data) {
      // Only a hangover close means the speaker actually stopped; a cap split
      // happens mid-sentence with speech still running.
      if (msg.meta?.reason === 'silence') this.speechInProgress = false
      this.lastEndOfSpeechAt = Date.now() - (msg.meta?.trailingSilenceMs ?? 0)
      // A new pause starts: it gets its own onset-hint hold.
      this.activityHoldUsed = false

      // The VAD reports how much trailing silence it actually included, so T0
      // (end-of-speech) is measured rather than estimated -- and it differs by
      // close reason, which the old fixed back-dating could not express.
      const now = performance.now()
      latencyTracer.beginSegment(now - (msg.meta?.trailingSilenceMs ?? 0), now)

      const buf = Buffer.from(msg.data)
      this.feedSegment(buf)
      return
    }

    if (msg.type === 'error') {
      console.error('Audio worker error:', msg)
    }
  }

  private stopCapture(): void {
    this.isCapturing = false
    this.worker?.postMessage({ type: 'flush' })

    this.stt?.finalize()

    this.speechInProgress = false
    const leftover = this.sentenceDetector.flush()
    const held = this.pendingUtterance
    const finalText = leftover && held ? mergeTranscript(held, leftover) : leftover || held
    if (finalText) {
      this.window?.webContents.send(IPC.TRANSCRIPT_FINAL, finalText)
      this.commitUtterance(finalText)
    } else {
      this.clearContinuationTimeout()
      this.clearCommitTimer()
      this.pendingUtterance = null
      this.continuationCount = 0
    }

    this.worker?.terminate()
    this.worker = null
    this.workerReady = false

    this.sendStatus('idle')
  }

  /**
   * Decides whether a completed transcript is a whole question or the first
   * half of one still being spoken.
   *
   * Without this, a mid-question pause longer than the VAD hangover splits the
   * utterance into two segments, and the second transcript aborts the answer
   * already streaming for the first -- so the model ends up answering only the
   * tail of the question, and the user sees the first answer vanish.
   */
  /**
   * Sends a closed segment to STT. While a fragment is being held for a
   * continuation, the WHOLE utterance so far is re-transcribed instead of just
   * the new segment: whisper decoding a 300ms fragment in isolation produces
   * nonsense ("For what?" for the word "What"), whereas the joined audio
   * decodes correctly ("what do you understand with Gen AI?"). Text-level
   * merging cannot recover what a bad decode already threw away.
   */
  private feedSegment(buf: Buffer): void {
    if (this.pendingUtterance !== null) {
      const joined = Buffer.concat([...this.utteranceAudio, buf])
      if (joined.length <= MAX_JOINED_BYTES) {
        this.utteranceAudio.push(buf)
        this.awaitingJoinedTranscript = true
        this.stt?.feedAudioChunk(joined)
        this.stt?.finalize()
        return
      }
      // Too long to re-decode in one request; fall back to merging the text.
    }

    this.utteranceAudio = [buf]
    this.awaitingJoinedTranscript = false
    this.stt?.feedAudioChunk(buf)
    this.stt?.finalize()
  }

  private handleUtteranceComplete(text: string): void {
    // A joined re-transcription already covers the whole utterance, so it
    // supersedes the held fragment rather than being appended to it.
    const merged = this.awaitingJoinedTranscript
      ? text
      : this.pendingUtterance
        ? mergeTranscript(this.pendingUtterance, text)
        : text
    this.awaitingJoinedTranscript = false
    this.pendingUtterance = merged

    // Always show the full question so far, even while holding.
    this.window?.webContents.send(IPC.TRANSCRIPT_FINAL, merged)

    this.clearCommitTimer()

    const graceExhausted = this.continuationCount >= MAX_CONTINUATION_SEGMENTS

    // The speaker is already talking again: certainly a continuation.
    if (this.speechInProgress && !graceExhausted) {
      this.continuationCount++
      if (this.debug) console.log(`[stt] continuation in progress, holding: "${merged}"`)
      this.armContinuationTimeout()
      return
    }

    // They appear to have stopped -- but a mid-question pause can outlast the
    // VAD hangover, and whisper's round-trip is shorter than that pause, so
    // "no speech yet" at this moment proves nothing. Wait out the rest of the
    // grace window measured from end-of-speech, not from now.
    const now = Date.now()
    const waited = now - this.lastEndOfSpeechAt
    let remaining = this.continuationGraceMs - waited
    // An onset hint already arrived since the speaker stopped: give
    // speech-start the chance to confirm it before committing a fragment.
    if (!graceExhausted && !this.activityHoldUsed && this.lastActivityAt > this.lastEndOfSpeechAt) {
      this.activityHoldUsed = true
      remaining = Math.max(remaining, this.lastActivityAt + ACTIVITY_HOLD_MS - now)
    }
    if (graceExhausted || remaining <= 0) {
      this.commitUtterance(merged)
      return
    }

    if (this.debug) console.log(`[stt] holding ${remaining}ms for a possible continuation`)
    this.scheduleCommit(remaining)
  }

  private scheduleCommit(delayMs: number): void {
    this.clearCommitTimer()
    this.commitDueAt = Date.now() + delayMs
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null
      if (this.pendingUtterance) this.commitUtterance(this.pendingUtterance)
    }, delayMs)
  }

  private clearCommitTimer(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer)
      this.commitTimer = null
    }
  }

  private commitUtterance(text: string): void {
    this.activityHoldUsed = false
    this.utteranceAudio = []
    this.awaitingJoinedTranscript = false
    this.clearCommitTimer()
    this.clearContinuationTimeout()
    this.pendingUtterance = null
    this.continuationCount = 0
    this.onFinalTranscript?.(text)
  }

  /**
   * A held utterance is released even if no further transcript arrives -- the
   * next segment can be filtered out as non-speech, which would otherwise
   * strand the question forever.
   */
  private armContinuationTimeout(): void {
    this.clearContinuationTimeout()
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = null
      const pending = this.pendingUtterance
      if (pending) this.commitUtterance(pending)
    }, CONTINUATION_TIMEOUT_MS)
  }

  private clearContinuationTimeout(): void {
    if (this.continuationTimer) {
      clearTimeout(this.continuationTimer)
      this.continuationTimer = null
    }
  }

  private sendStatus(status: string): void {
    this.window?.webContents.send(IPC.STATUS_UPDATE, { status })
  }

  destroy(): void {
    this.isCapturing = false
    this.worker?.terminate()
    this.worker = null
    this.stt?.stop()
  }
}
