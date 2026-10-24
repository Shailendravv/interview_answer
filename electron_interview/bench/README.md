# Evaluation harness

Measures the app as it ships. It drives the real main-process modules
(`AudioService`, the VAD worker, `WhisperServerProvider`, `Orchestrator`,
`ProviderChain`, `OllamaProvider`) headless, so before/after numbers come from
production code paths, not re-implementations. It changes no app behaviour,
defaults or models.

## Tracks

| Track | Suite | Input | Answers |
|---|---|---|---|
| A — STT accuracy | `stt` (model level) | audio + verified transcripts | WER, CER, term recall, lead-in kept, false transcripts on non-speech |
| B — transcription latency & segmentation | `stt` (pipeline level) | audio with known speech boundaries | whisper time, real-time factor, VAD close, speech end → commit, split / merged / missed questions |
| C — end-to-end latency | `e2e` | audio | speech end → commit → first visible token → answer complete; queue wait; app tracer accuracy |
| D — understanding | `routing` | labelled text | question detection, category, project resolution, context injection, follow-up history |
| E — answer quality | `answers` | fixed questions | heading compliance, first person, grounding, length, `done_reason`, latency, a human review sheet |
| STT engine fallback | `fallback` | `jfk.wav` | which engine serves (CUDA vs CPU) and startup time, including a CUDA build that cannot load |

Every suite also samples GPU memory/utilisation and the memory/CPU of
`whisper-server`, `ollama` and `llama-server`. Local inference costs $0; no cloud
calls are made unless `GROQ_API_KEY` is set and Groq is selected.

## Running

Prerequisites: `npm install`, Ollama already running (`ollama serve`; the
harness refuses to start or kill it), whisper.cpp built as the app expects, and
for synthetic audio Windows + `ffmpeg` on PATH.

```sh
npm run eval:audio                  # once: build the synthetic TTS clip set
npm run eval:routing                # ~2 s, no models needed
npm run eval:answers                # ~10 min (5 runs per question)
npm run eval:stt                    # ~20 min on the CPU engine
npm run eval:e2e                    # ~5 min
node bench/run.mjs fallback         # ~10 s, real binaries
npm run eval                        # all suites
```

Options (passed after `--`, e.g. `npm run eval:stt -- --engine=cuda`):

| Flag | Effect |
|---|---|
| `--runs=N` | answers: runs per question (default 5; answers vary run to run) |
| `--capture=legacy` / `--capture=sinc` | stt/e2e: decode each clip at 48 kHz and pass it through the renderer's resampler (old linear decimator / current sinc filter) in 4096-sample blocks, as live capture does. Default feeds ffmpeg's 16 kHz conversion directly, which hides capture-path losses |
| `--model=groq` | answers: generate with Groq (`GROQ_API_KEY`, `GROQ_MODEL`), Ollama fallback as in the app. A 429 on a fixed question is re-asked after the hold; the session keeps fallbacks (real-pace measurement). Use `--runs=2`: free tier is ~200K tokens/day and a 5-run suite needs ~130K |
| `--engine=cuda` / `--engine=vulkan` | stt/e2e: force `whisper.cpp/build-cuda` or `build-vulkan` (CPU build as its fallback) |
| `--whisper-model=<path>` | stt/e2e: evaluate another ggml model |
| `--whisper-lang=<code>` | stt/e2e: decode language, as `STT_LANGUAGE` (needs a multilingual model) |
| `--manifest=<path>` | stt/e2e: audio manifest (default: `audio/local/manifest.json`, else synthetic) |
| `--scenarios=a,b` | stt/e2e: only these scenarios (`single`, `paused`, `sequence`, `non-speech`) |
| `--stt-mode=model` | stt: recognition only, skip the real-time pipeline replay (fast model/prompt comparisons) |
| `--engine=cpu` | stt/e2e: force the CPU build (the app tries CUDA, then Vulkan, then CPU, each when present) |
| `--limit=N` | e2e: number of single-question clips (default 8) |
| `--verbose` | echo app logs to the console (always written to `app.log`) |

Each run writes `bench/results/<timestamp>_<suite>/` (git-ignored):
`summary.md`, `results.json` (every raw measurement), `app.log`, and for
answers `answers-for-review.md`.

Suites run under Electron's Node (`bench/run.mjs` sets `ELECTRON_RUN_AS_NODE=1`)
because `better-sqlite3` is built for Electron's ABI.

## Adding real recordings

Accuracy claims need real interview audio. Synthetic TTS clips have exact
references and boundaries, so they suit latency and segmentation, but they are
marked `representative: false` and must not be read as accuracy.

1. Put recordings in `bench/audio/local/` (git-ignored; never commit interview
   audio). WAV, any rate or channel count: they are converted to 16 kHz mono.
   Capture them on the path the app uses (system/loopback audio from
   Teams/Meet/Zoom), not a phone recording of a speaker.
2. Copy `audio/manifest.example.json` to `audio/local/manifest.json` and list
   each file with a **human-verified** reference transcript.
   - `language`: `en` | `hi` | `hinglish`; `referenceScript`: `latin` |
     `devanagari` | `mixed`. Write Hinglish the way you want it scored (usually
     Latin script). WER across mismatched scripts is flagged, not scored.
   - `questions[].startMs/endMs` (optional): speech boundaries. They enable
     endpoint latency and split/merge detection. Leave them out if unknown.
   - `terms`: names, numbers and technical words that must survive.
   - `scenario: "non-speech"` with `questions: []` for noise/silence clips.
3. Suggested starting set: 20–30 interviewer questions, at least 2 speakers
   (including Indian English), some natural mid-question pauses, a few
   back-to-back questions, numbers and tech terms, 3–5 minutes of non-speech,
   and Hindi/Hinglish clips if those languages are in scope.

## Known limitations

- **Renderer capture path not exercised.** The harness feeds 16 kHz PCM
  straight into `AudioService`. The renderer's 100 Hz high-pass and its linear
  48→16 kHz resampler (`src/renderer/src/services/audioCapture.ts`) don't run,
  and recordings are converted by ffmpeg's higher-quality resampler. Measured
  accuracy may therefore be slightly optimistic for 48 kHz devices. Covering this
  would need that resampler extracted into a pure function, which is a
  production change and out of scope for measurement-only work.
- **No renderer paint (T8).** "First visible token" is the moment the token IPC
  message is sent to the renderer.
- **Heuristic quality checks.** Heading, first-person and "unsupported tech"
  checks are regex heuristics for tracking trends. The review sheet is the
  ground truth for relevance and correctness.
- **Draft routing labels.** `fixtures/routing-cases.json` labels are
  `verified: false` until a human reviews them.
- **STT config is mirrored.** `src/main/index.ts` boots the app and can't be
  imported, so `lib/sttConfig.ts` duplicates its defaults. Each STT/e2e run
  reports drift if those defaults change.
- **Language** follows `STT_LANGUAGE` / `--whisper-lang` in both modes.
