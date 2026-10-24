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
| `WHISPER_GPU` | No | `1` | GPU transcription when present: `build-cuda`, then `build-vulkan`, then the CPU build. A GPU build that fails its start-up self-test is skipped. `0` = CPU only; `cuda` / `vulkan` = only that one |
| `WHISPER_CUDA_SERVER_BINARY_PATH` | No | auto | Explicit path to a CUDA whisper-server build |
| `WHISPER_VULKAN_SERVER_BINARY_PATH` | No | auto | Explicit path to a Vulkan whisper-server build |
| `STT_LANGUAGE` | No | `en` | Whisper decode language (`hi`, `auto`, …). Needs a multilingual model such as `ggml-large-v3-turbo.bin`; `*.en` models force `en` |
| `LLM_MAX_TOKENS` | No | `768` | Answer length cap sent to the model (Ollama and Groq) |
| `LLM_TEMPERATURE` | No | `0.7` | Answer sampling temperature |
| `LLM_GROUNDED_TEMPERATURE` | No | `0.3` | Temperature for answers built on a project's context (your own work: invented details cost most) |
| `OLLAMA_NUM_CTX` | No | `8192` | Ollama context window for every request (Ollama 0.30 defaults to 32768, ~0.75 GB more VRAM) |
| `GROQ_API_KEY` | No | — | Groq API key (free tier) |
| `GROQ_MODEL` | No | `qwen/qwen3.8-27b` | Groq model ID — **the single place to change** if Groq deprecates the model; no code edits needed. Qwen models are sent `reasoning_effort: none`. On a 429 (free tier: ~8K tokens/min) Groq is parked for its `Retry-After` and Ollama answers meanwhile |
| `CEREBRAS_API_KEY` | No | — | Cerebras API key |
| `SAMBANOVA_API_KEY` | No | — | SambaNova API key |
| `GEMINI_API_KEY` | No | — | Google Gemini API key |
| `NVIDIA_API_KEY` | No | — | NVIDIA API key |
| `OPENROUTER_API_KEY` | No | — | OpenRouter API key |

At minimum, no API keys are required — the app runs with:
- **whisper.cpp** for STT (or browser mic capture via getUserMedia)
- **Ollama** with `qwen2.5-coder:1.5b` for both routing and generation fallback

For better quality generation, add at least one cloud provider API key. **Answer generation defaults to local Ollama** (`qwen2.5-coder:1.5b`). Use the model dropdown in the UI (bottom status bar) to switch answers to **Groq** (default model: `qwen/qwen3.8-27b`) when you want a bigger model for coding questions. Routing, summarization, and project-doc retrieval always stay on local Ollama.

> **Groq Qwen 3.6 27B**: free on the Groq free plan (no credit card), rate-limited to 30 RPM / 1K req/day / 200K tokens/day. It is a **preview** model — if Groq deprecates it, just update `GROQ_MODEL` in `.env` and restart.

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

**GPU transcription:** the app tries `build-cuda`, then `build-vulkan`, then the CPU `build`, using the first one that starts and passes a one-second self-test. Measured on an RTX 3050 laptop (synthetic set, `bench/`): CPU ~8.2 s per question, CUDA 213 ms, Vulkan 173 ms (Vulkan on the Iris Xe iGPU: 1.7 s); WER is the same on all of them.

- **CUDA** (NVIDIA, needs CUDA 13 cuBLAS on `PATH` at run time): `cmake -B build-cuda -DGGML_CUDA=1 && cmake --build build-cuda --config Release --target whisper-server`.
- **Vulkan** (any GPU with a Vulkan driver; nothing extra at run time): needs `glslc`, the Vulkan headers and `vulkan-1.lib` at build time. Either install the LunarG Vulkan SDK (admin), or unpack these conda-forge packages into `whisper.cpp/.toolchains/vulkan/root` without admin: `shaderc`, `glslang`, `spirv-tools`, `spirv-headers`, `libvulkan-loader`, `libvulkan-headers`. Then, with `T=whisper.cpp/.toolchains/vulkan/root/Library`:
  `cmake -B build-vulkan -DGGML_VULKAN=ON -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DCMAKE_PREFIX_PATH=$T -DVulkan_INCLUDE_DIR=$T/include -DVulkan_LIBRARY=$T/lib/vulkan-1.lib -DVulkan_GLSLC_EXECUTABLE=$T/bin/glslc.exe && cmake --build build-vulkan --config Release --target whisper-server`.
  On hybrid laptops the app picks the discrete GPU itself (ggml-vulkan lists the integrated one first).
- `npm run dist` bundles all three builds (`electron-builder.yml`); build the GPU ones first.

**Packaged builds** ship `config/app.env` (secret-free defaults) as `resources/.env`. Put API keys and personal overrides in `%APPDATA%\<app>\.env`; they override the bundled defaults key by key.

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
