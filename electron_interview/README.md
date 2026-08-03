# Real-Time AI Interview Assistant

An Electron-based desktop application that provides real-time AI-powered answers during technical interviews. Uses local speech-to-text, a local router model for instant classification, and a configurable fallback chain of free-tier cloud LLM providers for generation.

**Goal**: Sub-500ms time-to-first-token on 4GB VRAM hardware.

---

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Ollama** — [Download & Install](https://ollama.com/download)
- **whisper.cpp** (optional, for local STT) — or a microphone for browser-based capture
- **API Keys** (optional) — for cloud LLM providers (free tiers available)

---

## Quick Start

```bash
# Clone / enter the project
cd interview_answer

# Install dependencies
npm install

# Start in development mode
npm run dev
```

The Electron app will open. Click **Start** and speak into your microphone.

---

## Configuration

Copy the example env file and fill in your API keys:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STT_MODE` | No | `whisper` | STT engine: `whisper`, `parakeet`, or `deepgram` |
| `DEEPGRAM_API_KEY` | For Deepgram | — | Deepgram Nova-2 API key. If set, overrides `STT_MODE` to `deepgram` |
| `PARAKEET_SERVER_URL` | For Parakeet | `http://localhost:5000/transcribe` | URL of your local Parakeet Flask server |
| `WHISPER_MODEL_PATH` | No | `whisper.cpp/models/ggml-small.en.bin` | Path to whisper.cpp model file (auto-resolved to sibling `whisper.cpp/`) |
| `WHISPER_BINARY_PATH` | No | `whisper.cpp/build/bin/Release/whisper-cli.exe` | Path to whisper-cli.exe (batch fallback) (auto-resolved to sibling `whisper.cpp/`) |
| `WHISPER_SERVER_BINARY_PATH` | No | `whisper.cpp/build/bin/Release/whisper-server.exe` | Path to whisper-server.exe (persistent HTTP engine, lower latency) |
| `WHISPER_SERVER_HOST` | No | `127.0.0.1` | whisper-server host |
| `WHISPER_SERVER_PORT` | No | `8080` | whisper-server port |
| `GROQ_API_KEY` | No | — | Groq API key (free tier: `llama-3.1-8b-instant`) |
| `CEREBRAS_API_KEY` | No | — | Cerebras API key |
| `SAMBANOVA_API_KEY` | No | — | SambaNova API key |
| `GEMINI_API_KEY` | No | — | Google Gemini API key |
| `NVIDIA_API_KEY` | No | — | NVIDIA API key |
| `OPENROUTER_API_KEY` | No | — | OpenRouter API key |

At minimum, no API keys are required — the app runs with:
- **whisper.cpp** for STT (or browser mic capture via getUserMedia)
- **Ollama** with `qwen2.5-coder:1.5b` for both routing and generation fallback

For better quality generation, add at least one cloud provider API key. The chain tries providers in order: **Groq → Cerebras → SambaNova → Gemini → NVIDIA → OpenRouter → local Ollama**.

---

## LLM Provider Setup

### Local (Ollama)

Required models (auto-pulled on first run):

```bash
ollama pull qwen2.5-coder:1.5b
ollama pull nomic-embed-text
```

Ensure the Ollama service is running:

```bash
ollama serve
```

### Cloud Providers (Free Tier)

Each provider has a free tier. Get API keys from:

| Provider | Sign Up | Free Tier Limit |
|----------|---------|-----------------|
| **Groq** | [console.groq.com](https://console.groq.com) | 30 req/min, 14400 req/day |
| **Cerebras** | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Free tier available |
| **SambaNova** | [cloud.sambanova.ai](https://cloud.sambanova.ai) | Free tier available |
| **Gemini** | [aistudio.google.com](https://aistudio.google.com) | 60 req/min (free) |
| **NVIDIA** | [build.nvidia.com](https://build.nvidia.com) | Free tier available |
| **OpenRouter** | [openrouter.ai](https://openrouter.ai) | Free models available |

Add the key to `.env`:

```env
GROQ_API_KEY=gsk_your_key_here
```

---

## STT Setup

The app tries STT engines in a **fallback chain**: whisper.cpp → Deepgram (if API key set) → Parakeet (if server URL set). It auto-skips engines that aren't configured or have missing binaries/models.

### Option 1: whisper.cpp (Default, local, free)

The app uses two whisper.cpp engines in a fallback chain:

1. **whisper-server** (persistent HTTP engine, lower latency) — spawns `whisper-server.exe` once and keeps it running, POSTing audio segments to `/inference`
2. **whisper-cli** (batch fallback) — spawns `whisper-cli -f chunk.wav` per segment, used if the server fails

Both are auto-resolved from the sibling `whisper.cpp/` folder.

To build whisper.cpp:

```bash
# From the whisper.cpp directory
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

Download a model (e.g., `small.en`):

```bash
bash models/download-ggml-model.sh small.en
```

If placed elsewhere, set paths in `.env`:

```env
WHISPER_SERVER_BINARY_PATH=D:\path\to\whisper.cpp\build\bin\Release\whisper-server.exe
WHISPER_BINARY_PATH=D:\path\to\whisper.cpp\build\bin\Release\whisper-cli.exe
WHISPER_MODEL_PATH=D:\path\to\whisper.cpp\models\ggml-small.en.bin
```

If no binary or model is found, whisper is automatically skipped — no crash.

> **VRAM note**: `ggml-small.en` (~240 MB) + Ollama `qwen2.5-coder:1.5b` (~1.2 GB) fit on 4 GB VRAM. If you hit OOM, switch to `ggml-base.en.bin` (lighter, faster).

### Option 2: Deepgram (Cloud, instant setup)

Get a [Deepgram API key](https://console.deepgram.com) and set:

```env
DEEPGRAM_API_KEY=your_deepgram_key
```

Deepgram auto-joins the fallback chain when the key is present.

### Option 3: Parakeet Server (Local, GPU)

Run a local Flask server with your Hugging Face Parakeet model:

```bash
# Install requirements (Python 3.10+)
pip install flask torch transformers

# Start the server
python parakeet_server.py  # You need to create this script
```

Set the URL in `.env`:

```env
PARAKEET_SERVER_URL=http://localhost:5000/transcribe
```

---

## Running

### Development

```bash
npm run dev
```

Launches the Electron app with hot-reload for the renderer and auto-restart for the main process.

### Production Build

```bash
npm run build
```

Output goes to `out/`:
- `out/main/index.js` — Electron main process
- `out/main/audioWorker.js` — Audio VAD worker
- `out/preload/index.js` — Secure IPC bridge
- `out/renderer/` — React frontend

### Type Checking

```bash
npm run typecheck
```

---

## Architecture Overview

```
                   ┌──────────────────────┐
                   │   Audio Capture (UI)  │
                   │  (getUserMedia @16kHz)│
                   └──────────┬───────────┘
                              │ PCM16 chunks (IPC)
                              ▼
                   ┌──────────────────────┐
                   │   AudioService +     │
                   │   VAD Worker Thread  │
                   └──────────┬───────────┘
                              │ Speech segments
                              ▼
                   ┌──────────────────────┐
                   │  STT Engine          │
                   │  (whisper/parakeet/  │
                   │   deepgram)          │
                   └──────────┬───────────┘
                              │ Final transcript
                              ▼
    ┌─────────────────────────────────────────────┐
    │              Orchestrator                    │
    │                                              │
    │   ┌──────────┐  ┌──────────┐  ┌──────────┐  │
    │   │  Router  │  │  Cache   │  │ Context  │  │
    │   │ (local   │  │ (SQLite  │  │ (sliding │  │
    │   │  1.5b)   │  │  vector) │  │  window) │  │
    │   └────┬─────┘  └────┬─────┘  └────┬─────┘  │
    │        └─────────────┼──────────────┘        │
    │                      ▼                       │
    │           ┌──────────────────────┐            │
    │           │  Generation Chain    │            │
    │           │ Groq→Cerebras→...→  │            │
    │           │ Local Ollama (last)  │            │
    │           └──────────┬───────────┘            │
    └──────────────────────┼────────────────────────┘
                           │ Streamed tokens (IPC)
                           ▼
                   ┌──────────────────────┐
                   │   React UI (streaming │
                   │   text renderer)      │
                   └──────────────────────┘
```

### Key Design Decisions

- **Router always local**: `qwen2.5-coder:1.5b` via Ollama, <80ms, no network dependency
- **Generation fallback chain**: Free cloud providers (6) tried in order; local Ollama is the backstop
- **Circuit breaker per provider**: After 3 failures, provider is skipped for 5 minutes (auto-reset)
- **Cache-first**: Semantic cosine similarity >0.92 returns instantly, bypasses LLM
- **Speculative parallelism**: On transcript emit, router, context fetch, and cache search run concurrently
- **Prompt capped at ~2500 tokens**: Sliding window (last 3 Q&A) + rolling summary + retrieved context

---

## Usage

1. Click **Start** — the app begins listening through your microphone
2. Speak your interview question naturally
3. The app transcribes in real-time (interim results shown)
4. Once you finish speaking, the transcript is finalized and sent to the AI pipeline
5. The answer streams token-by-token into the UI
6. Click **Stop** to end the session
7. Use **Clear Cache** to invalidate all cached answers
8. Use **Refresh** to bypass the cache for the next question

### Status Indicators

- **`idle`** — Waiting for you to click Start
- **`listening`** — Mic is active, transcribing audio
- **`processing`** — Generating answer via LLM chain
- **`error`** — Something went wrong (check console)

---

## Project Structure

```
├── documents/
│   └── DECISIONED_ARCHITECTURE.md   # Architecture decisions
├── src/
│   ├── audio/           # VAD processing worker thread
│   ├── main/
│   │   ├── audio/       # Audio capture + STT pipeline
│   │   ├── cache/       # Embedding + semantic cache
│   │   ├── context/     # Sliding window + summarizer
│   │   ├── db/          # SQLite database service
│   │   ├── docs/        # Project docs ingestion + retrieval
│   │   ├── llm/         # LLM providers, chain, router, circuit breaker
│   │   │   └── cloud/   # Cloud provider implementations
│   │   ├── orchestrator/# Central orchestrator
│   │   └── stt/         # STT providers (whisper, parakeet, deepgram)
│   ├── preload/         # Secure IPC bridge
│   ├── renderer/        # React UI
│   └── shared/          # Types, IPC channels, STT interface
├── .env.example         # Environment variable template
├── electron.vite.config.ts
├── tsconfig.json
├── tailwind.config.js
└── package.json
```

---

## Troubleshooting

### "Ollama is not running"
Ensure Ollama is installed and running: `ollama serve`. The app tries to auto-start it, but on Windows you may need to start it manually.

### "No API keys configured"
The app falls back to local Ollama for generation. For better results, add at least one cloud provider API key.

### "Microphone not working"
- Ensure microphone permissions are granted in the OS
- On Windows, check that the mic isn't muted
- The app uses browser `getUserMedia` API — check Electron's media permissions

### "Build errors with better-sqlite3"
If `better-sqlite3` fails to compile, install build tools:
```bash
npm install -g windows-build-tools  # Windows
# or
apt install build-essential python3  # Linux
```

### "STT engine: none" / "No STT engine is available"
No STT engine could start. Either:
- **whisper.cpp**: install the binary and download a model (see STT Setup), or point `WHISPER_BINARY_PATH`/`WHISPER_MODEL_PATH` in `.env`
- **Deepgram**: set `DEEPGRAM_API_KEY` in `.env` (works immediately, no binary needed)
- **Parakeet**: run your Flask server and set `PARAKEET_SERVER_URL` in `.env`

The app gracefully shows this status in the UI — it won't crash or spam errors.

---


## License

MIT
