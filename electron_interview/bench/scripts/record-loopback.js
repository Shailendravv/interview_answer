// Live A/B: plays a clip through the speakers and records it back through the
// app's loopback capture path (getDisplayMedia + ScriptProcessor 4096 at the
// context rate), once with Chromium's default audio processing and once with
// it disabled. Writes 48 kHz mono float WAVs for the bench to transcribe.
// Usage (from electron_interview/, with ELECTRON_RUN_AS_NODE unset):
//   electron bench/scripts/record-loopback.js <clip> <outDir>
// Needs bench/scripts/probe.html next to it. Plays the clip aloud twice.
const { app, BrowserWindow, session, desktopCapturer } = require('electron')
const { spawn } = require('child_process')
const { writeFileSync } = require('fs')
const path = require('path')

const [clip, outDir] = process.argv.slice(-2)
const SECONDS = 18

function writeFloatWav(file, samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([h, data]))
}

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    callback({ audio: 'loopback', video: { id: sources[0].id, name: sources[0].name } })
  })
  const win = new BrowserWindow({ show: false })
  await win.loadFile(path.join(__dirname, 'probe.html'))

  const modes = [
    ['processing-default', 'true'],
    ['processing-off', '{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }']
  ]
  for (const [name, audio] of modes) {
    const recording = win.webContents.executeJavaScript(`(async () => {
      const s = await navigator.mediaDevices.getDisplayMedia({ audio: ${audio}, video: true })
      s.getVideoTracks().forEach((t) => t.stop())
      const settings = s.getAudioTracks()[0].getSettings()
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(s)
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 100
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      const blocks = []
      proc.onaudioprocess = (e) => blocks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      src.connect(hp); hp.connect(proc); proc.connect(ctx.destination)
      await new Promise((r) => setTimeout(r, ${SECONDS * 1000}))
      proc.disconnect(); s.getTracks().forEach((t) => t.stop())
      const n = blocks.reduce((a, b) => a + b.length, 0)
      const all = new Float32Array(n); let o = 0
      for (const b of blocks) { all.set(b, o); o += b.length }
      const bytes = new Uint8Array(all.buffer); let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      const rate = ctx.sampleRate; ctx.close()
      return { rate, settings, b64: btoa(bin) }
    })()`)
    // Give capture a moment to start, then play the clip through the speakers.
    await new Promise((r) => setTimeout(r, 700))
    spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', clip], { stdio: 'ignore' })
    const res = await recording
    const buf = Buffer.from(res.b64, 'base64')
    const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    const file = path.join(outDir, `live-${name}.wav`)
    writeFloatWav(file, samples, res.rate)
    console.log('RECORDED', name, JSON.stringify(res.settings), `${(samples.length / res.rate).toFixed(1)}s`, file)
    await new Promise((r) => setTimeout(r, 1500))
  }
  app.exit(0)
})
