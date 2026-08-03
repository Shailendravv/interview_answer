const TARGET_RATE = 16000
const CHANNELS = 1
const SILENCE_TIMEOUT_MS = 3000
const SILENCE_RMS_THRESHOLD = 0.005

let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let highpass: BiquadFilterNode | null = null
let processor: ScriptProcessorNode | null = null
let captureRate = TARGET_RATE
let logTimer = 0
let silentSince: number | null = null
let silentWarningSent = false
let audioTrack: MediaStreamTrack | null = null
let muteTimer = 0

function handleTrackEnded(): void {
  window.dispatchEvent(new CustomEvent('audio:track-lost'))
}

function handleTrackMuted(): void {
  clearTimeout(muteTimer)
  // Debounce: transient muting (device toggle) resolves via 'unmute' before the timer fires.
  muteTimer = window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('audio:track-lost'))
  }, 1500)
}

function handleTrackUnmuted(): void {
  clearTimeout(muteTimer)
}

async function initFromStream(stream: MediaStream, captureSource: 'system' | 'mic'): Promise<void> {
  mediaStream = stream
  audioContext = new AudioContext()
  source = audioContext.createMediaStreamSource(stream)
  captureRate = audioContext.sampleRate
  console.log(`[audio] Capture rate: ${captureRate} Hz`)
  console.log(`[audio] Capture path: ${captureSource === 'system' ? 'system-loopback' : 'mic'}`)
  window.dispatchEvent(new CustomEvent('audio:source', { detail: captureSource }))

  highpass = audioContext.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 100

  const bufferSize = 4096
  processor = audioContext.createScriptProcessor(bufferSize, CHANNELS, CHANNELS)

  processor.onaudioprocess = (event): void => {
    let input = event.inputBuffer.getChannelData(0)

    if (captureRate !== TARGET_RATE) {
      const ratio = captureRate / TARGET_RATE
      const outputLen = Math.floor(input.length / ratio)
      const out = new Float32Array(outputLen)
      for (let i = 0; i < outputLen; i++) {
        const pos = i * ratio
        const idx = Math.floor(pos)
        const frac = pos - idx
        out[i] = idx + 1 < input.length
          ? input[idx] * (1 - frac) + input[idx + 1] * frac
          : input[idx]
      }
      input = out
    }

    const rms = computeRms(input)
    logTimer++
    if (logTimer % 10 === 0) {
      console.log(`[audio] RMS: ${rms.toFixed(5)} (speech > 0.02)`)
    }

    // Silent detection for headphone warning
    if (rms < SILENCE_RMS_THRESHOLD) {
      if (silentSince === null) silentSince = Date.now()
      else if (Date.now() - silentSince >= SILENCE_TIMEOUT_MS && !silentWarningSent) {
        silentWarningSent = true
        window.dispatchEvent(new CustomEvent('audio:silent'))
      }
    } else {
      silentSince = null
    }

    const pcm16 = encodePcm16(input)
    window.api.send('audio:chunk', pcm16.buffer)
  }

  source.connect(highpass)
  highpass.connect(processor)
  processor.connect(audioContext.destination)

  const track = stream.getAudioTracks()[0]
  if (track) {
    audioTrack = track
    track.addEventListener('ended', handleTrackEnded)
    track.addEventListener('mute', handleTrackMuted)
    track.addEventListener('unmute', handleTrackUnmuted)
  }

  window.api.send('audio:start')
}

// A re-Start while a capture is still active must tear the old one down first;
// otherwise a second AudioContext/ScriptProcessor leaks and both send audio:chunk.
function teardownActiveCapture(): void {
  if (processor || mediaStream) {
    stopCapture()
  }
}

export async function startCapture(): Promise<void> {
  teardownActiveCapture()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: { ideal: TARGET_RATE },
      channelCount: CHANNELS
    }
  })
  await initFromStream(stream, 'mic')
}

export async function startSystemCapture(): Promise<void> {
  teardownActiveCapture()
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  stream.getVideoTracks().forEach((t) => t.stop())

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('getDisplayMedia returned no audio track')
  }

  console.log('[audio] Using getDisplayMedia for system audio capture')
  await initFromStream(stream, 'system')
}

function computeRms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }
  return Math.sqrt(sum / samples.length)
}

export function stopCapture(): void {
  if (processor && audioContext && highpass && source) {
    source.disconnect(highpass)
    highpass.disconnect(processor)
    processor.disconnect(audioContext.destination)
  }
  if (audioTrack) {
    audioTrack.removeEventListener('ended', handleTrackEnded)
    audioTrack.removeEventListener('mute', handleTrackMuted)
    audioTrack.removeEventListener('unmute', handleTrackUnmuted)
    audioTrack = null
  }
  clearTimeout(muteTimer)
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop())
  }
  if (audioContext) {
    audioContext.close()
  }

  mediaStream = null
  audioContext = null
  source = null
  highpass = null
  processor = null
  silentSince = null
  silentWarningSent = false

  window.api.send('audio:stop')
}

function encodePcm16(float32Array: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return pcm16
}
