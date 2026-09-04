import { config as dotenvConfig } from "dotenv";
import { resolve, join } from "path";
import { existsSync } from "fs";
import {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
  Menu,
  screen,
  shell,
} from "electron";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import { AudioService } from "./audio/AudioService";
import { LlmOrchestrator } from "./llm/LlmOrchestrator";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { HistoryService } from "./history/HistoryService";
import { TrayService } from "./tray/TrayService";
import { ProjectCatalogService } from "./docs/ProjectCatalogService";
import { IPC } from "../shared/ipcChannels";
import { latencyTracer } from "./telemetry/LatencyTracer";

function loadDotEnv(): void {
  // `resolve(__dirname, "../../.env")` only exists in dev (project root). In the
  // packaged app __dirname lives inside app.asar, so also probe the per-user
  // config dir and the unpacked resources dir next to the executable.
  const candidates = [
    resolve(__dirname, "../../.env"),
    resolve(app.getPath("userData"), ".env"),
    resolve(process.resourcesPath, ".env"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      dotenvConfig({ path });
      console.log("[env] Loaded config from", path);
      return;
    }
  }
  console.warn(
    "[env] No .env found — cloud providers (Groq/Cerebras/...) will be unavailable",
  );
}

loadDotEnv();

interface WhisperPaths {
  modelPath: string;
  cliBinaryPath: string;
  serverBinaryPath: string;
}

function resolveWhisperPaths(): WhisperPaths {
  const envModel = process.env.WHISPER_MODEL_PATH;
  const envCli = process.env.WHISPER_BINARY_PATH;
  const envServer = process.env.WHISPER_SERVER_BINARY_PATH;

  if (envModel && envCli && envServer) {
    console.log("[whisper] Using env paths:", envModel, envCli, envServer);
    return {
      modelPath: envModel,
      cliBinaryPath: envCli,
      serverBinaryPath: envServer,
    };
  }

  const cwd = process.cwd();
  const appPath = app.getAppPath();

  const candidates: string[] = [
    cwd,
    appPath,
    resolve(cwd, ".."),
    resolve(appPath, ".."),
    resolve(__dirname, "..", "..", "..", ".."),
    resolve(__dirname, "..", "..", ".."),
    resolve(__dirname, "..", ".."),
  ];

  for (const base of candidates) {
    const whisperDir = resolve(base, "whisper.cpp");
    const model = resolve(whisperDir, "models", "ggml-small.en.bin");
    const cliBin = resolve(
      whisperDir,
      "build",
      "bin",
      "Release",
      "whisper-cli.exe",
    );
    const serverBin = resolve(
      whisperDir,
      "build",
      "bin",
      "Release",
      "whisper-server.exe",
    );
    if (existsSync(model)) {
      console.log("[whisper] Found model at:", model);
      console.log(
        "[whisper] CLI binary:",
        existsSync(cliBin) ? cliBin : "not found",
      );
      console.log(
        "[whisper] Server binary:",
        existsSync(serverBin) ? serverBin : "not found",
      );
      return {
        modelPath: envModel || model,
        cliBinaryPath: envCli || cliBin,
        serverBinaryPath: envServer || serverBin,
      };
    }
  }

  console.warn(
    "[whisper] Could not find whisper.cpp model in any candidate dir",
  );
  return {
    modelPath: envModel || "whisper.cpp/models/ggml-small.en.bin",
    cliBinaryPath: envCli || "whisper-cli",
    serverBinaryPath: envServer || "whisper-server",
  };
}

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const STT_MODE = process.env.STT_MODE || "whisper";
const MIC_FALLBACK_ENABLED =
  process.env.AUDIO_MIC_FALLBACK === "1" ||
  process.env.AUDIO_MIC_FALLBACK === "true";

const whisperPaths = resolveWhisperPaths();
console.log("[whisper] Resolved model:", whisperPaths.modelPath);
console.log("[whisper] Resolved CLI binary:", whisperPaths.cliBinaryPath);
console.log("[whisper] Resolved server binary:", whisperPaths.serverBinaryPath);

// VAD_PAD_FRAMES counted whatever chunk the capture layer happened to send
// (85ms @48kHz, 256ms @16kHz-native), so "10 frames" meant anywhere from 853ms
// to 2.5s of hangover depending on the sound card -- not the 320ms it claimed.
// The VAD now works in ms of audio. Honour the legacy var at its documented
// 32ms/frame so existing .env files keep meaning what they said.
function resolveVadHangoverMs(): number {
  const explicit = Number(process.env.VAD_HANGOVER_MS);
  if (explicit > 0) return explicit;

  const legacyFrames = Number(process.env.VAD_PAD_FRAMES);
  if (legacyFrames > 0) {
    const ms = legacyFrames * 32;
    console.warn(
      `[vad] VAD_PAD_FRAMES is deprecated; using VAD_HANGOVER_MS=${ms}. ` +
        "Set VAD_HANGOVER_MS directly (default 350)."
    );
    return ms;
  }

  return 350;
}

const sttConfig = {
  mode: (DEEPGRAM_API_KEY ? "deepgram" : STT_MODE) as
    | "whisper"
    | "parakeet"
    | "deepgram",
  deepgramApiKey: DEEPGRAM_API_KEY || undefined,
  parakeetServerUrl: process.env.PARAKEET_SERVER_URL || undefined,
  whisperModelPath: whisperPaths.modelPath,
  whisperBinaryPath: whisperPaths.cliBinaryPath,
  whisperServerBinaryPath: whisperPaths.serverBinaryPath,
  whisperServerHost: process.env.WHISPER_SERVER_HOST || "127.0.0.1",
  whisperServerPort: Number(process.env.WHISPER_SERVER_PORT) || 8080,
  whisperInitialPrompt:
    process.env.STT_PROMPT ||
    process.env.WHISPER_INITIAL_PROMPT ||
    // Style cue only — NO vocabulary. Listing tech terms ("React", "Node.js")
    // biases short-utterance decoding: whisper injects those tokens into the
    // transcript and skips low-content lead-ins ("What is …").
    "Interview question and answer conversation, clear English speech.",
  whisperNoSpeechThreshold:
    Number(process.env.WHISPER_NO_SPEECH_THRESHOLD) || 0.6,
  silenceTimeoutMs: Number(process.env.SILENCE_TIMEOUT_MS) || 750,
  vadHangoverMs: resolveVadHangoverMs(),
  vadPreRollMs: Number(process.env.VAD_PREROLL_MS) || 300,
  vadMaxSegmentMs: Number(process.env.VAD_MAX_SEGMENT_MS) || 8000,
  continuationGraceMs: Number(process.env.CONTINUATION_GRACE_MS) || 900,
};

// A keyword-list STT prompt biases decoding: whisper injects those tokens into
// short-utterance transcripts ("React is AI agent") and drops lead-ins
// ("What is …"). Surface the misconfiguration at startup instead of in QA.
if (/keywords?\s*:/i.test(sttConfig.whisperInitialPrompt ?? "")) {
  console.warn(
    "[whisper] STT prompt lists keywords — known to leak terms into transcripts " +
      "of short questions. Prefer a vocabulary-free style cue (see .env.example)."
  );
}

const llmKeys = {
  groq: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL,
  cerebras: process.env.CEREBRAS_API_KEY,
  sambanova: process.env.SAMBANOVA_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  nvidia: process.env.NVIDIA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
};

let mainWindow: BrowserWindow | null = null;
let audioService: AudioService | null = null;
let orchestrator: Orchestrator | null = null;
const historyService = new HistoryService();
let trayService: TrayService | null = null;
const projectCatalog = new ProjectCatalogService();

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 670;
const COMPACT_WIDTH = 380;
const COMPACT_HEIGHT = 500;
const SNAP_COMPACT_SIZE = { width: COMPACT_WIDTH, height: COMPACT_HEIGHT };

type SnapPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "left-half"
  | "right-half";

// Register IPC handlers at module scope (before window renders)
ipcMain.on("text:process", (_event, text: string) => {
  // Typed input pre-empts a streaming answer; a spoken one queues behind it.
  orchestrator?.processTranscript(text, "user");
});
ipcMain.on("session:start", () => {
  historyService.startSession();
  console.log("[index] Session started");
});
let pendingGenerationModel: "ollama" | "groq" | null = null;
ipcMain.on("session:set-model", (_event, model: string) => {
  if (model !== "ollama" && model !== "groq") return;
  if (orchestrator) {
    orchestrator.setGenerationModel(model);
  } else {
    pendingGenerationModel = model;
  }
});
ipcMain.on("history:append", (_event, qa: unknown) => {
  historyService.append(
    qa as { id: string; question: string; answer: string; timestamp: number },
  );
});
ipcMain.handle("history:load", async () => {
  return historyService.load();
});
ipcMain.handle("desktop:sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});
ipcMain.handle("app:config", () => ({
  micFallbackEnabled: MIC_FALLBACK_ENABLED,
  groqModel: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  groqAvailable: Boolean(process.env.GROQ_API_KEY),
}));

// Project catalog (invoke)
ipcMain.handle(IPC.PROJECTS_LIST, () => {
  return projectCatalog.getBundleForRenderer();
});
ipcMain.handle(IPC.PROJECTS_OPEN, async () => {
  try {
    const err = await shell.openPath(projectCatalog.getProjectsJsonPath());
    return err || null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});
ipcMain.handle(IPC.WINDOW_GET_STATE, () => ({
  isAlwaysOnTop: Boolean(mainWindow?.isAlwaysOnTop()),
}));

// Latency telemetry: renderer acknowledges first token receipt (T8)
ipcMain.handle(IPC.LATENCY_UI, () => {
  latencyTracer.mark(latencyTracer.getActive(), "T8");
});

// Pinned project selection (renderer → main). The window is interactive while
// the orchestrator is still being built behind LLM warmup, so a selection made
// in that gap has nowhere to go — buffer it instead of dropping it, or the UI
// shows a pinned project the answer path never received. `undefined` (not
// `null`) is the empty sentinel: `null` is what "Clear project" sends.
let pendingProjectId: string | null | undefined = undefined;
ipcMain.on(IPC.SESSION_SET_PROJECT, (_event, projectId: string | null) => {
  const id = typeof projectId === "string" ? projectId : null;
  if (orchestrator) {
    orchestrator.setActiveProject(id);
  } else {
    pendingProjectId = id;
  }
});

// Window snapping (renderer → main)
ipcMain.on(IPC.WINDOW_SNAP, (_event, position: SnapPosition) => {
  const win = mainWindow;
  if (!win) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const isHalf = position === "left-half" || position === "right-half";
  const w = isHalf ? Math.floor(width / 2) : SNAP_COMPACT_SIZE.width;
  const h = isHalf ? height : SNAP_COMPACT_SIZE.height;

  let px = x;
  let py = y;
  if (
    position === "top-right" ||
    position === "right-half" ||
    position === "bottom-right"
  ) {
    px = isHalf ? x + Math.floor(width / 2) : x + width - w;
  }
  if (position === "bottom-left" || position === "bottom-right") {
    py = y + height - h;
  }
  win.setBounds({ x: px, y: py, width: w, height: h });
});

// Compact overlay toggle (renderer → main)
ipcMain.on(IPC.WINDOW_TOGGLE_COMPACT, () => {
  const win = mainWindow;
  if (!win) return;
  const bounds = win.getBounds();
  const isCompact =
    bounds.width <= COMPACT_WIDTH && bounds.height <= COMPACT_HEIGHT;
  win.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: isCompact ? DEFAULT_WIDTH : COMPACT_WIDTH,
    height: isCompact ? DEFAULT_HEIGHT : COMPACT_HEIGHT,
  });
});

// Always-on-top toggle (renderer → main)
ipcMain.on(IPC.WINDOW_TOGGLE_ALWAYS_ON_TOP, () => {
  const win = mainWindow;
  if (!win) return;
  win.setAlwaysOnTop(!win.isAlwaysOnTop());
  trayService?.refreshMenu();
});

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    transparent: true,
    frame: false,
    icon: join(__dirname, "../../build/app-icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;

  // Window control IPC handlers
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.on("window:close", () => mainWindow?.close());

  // Remove default menu bar (File, Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  // Screen-share protection: invisible to screen recording/sharing
  win.setContentProtection(true);
  // Hide taskbar icon — access only via tray icon or Ctrl+Alt+I
  win.setSkipTaskbar(true);

  // Minimize → system tray instead of taskbar
  win.on("minimize", () => {
    win.hide();
    trayService?.refreshMenu();
  });

  win.on("show", () => {
    trayService?.refreshMenu();
  });

  win.on("hide", () => {
    trayService?.refreshMenu();
  });

  win.on("ready-to-show", () => {
    // Launch hidden to tray; reveal via tray icon or Ctrl+Alt+I
    win.show();
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Initialize LLM infrastructure
  const llmOrchestrator = new LlmOrchestrator(llmKeys);
  try {
    await llmOrchestrator.initialize();
    console.log("LLM infrastructure ready");
  } catch (err) {
    console.error("LLM init failed (degraded mode):", err);
  }

  // Initialize orchestrator (LLM classifier router is opt-in: ROUTER_LLM_ENABLED=1)
  orchestrator = new Orchestrator(llmOrchestrator, projectCatalog, {
    routerLlmEnabled: process.env.ROUTER_LLM_ENABLED === "1",
  });
  orchestrator.setWindow(win);
  if (pendingGenerationModel) {
    orchestrator.setGenerationModel(pendingGenerationModel);
    pendingGenerationModel = null;
  }
  // Apply a project pinned while the orchestrator was still starting up.
  if (pendingProjectId !== undefined) {
    orchestrator.setActiveProject(pendingProjectId);
    pendingProjectId = undefined;
  }

  await orchestrator.startInterview("Interview Session");

  // Forward projects.json hot-reload to the renderer
  projectCatalog.onUpdate(() => {
    win.webContents.send(IPC.PROJECTS_UPDATED);
  });

  // Initialize audio service
  const sttDebug =
    process.env.STT_DEBUG === "1" || process.env.STT_DEBUG === "true";
  audioService = new AudioService(sttConfig, sttDebug);
  audioService.setWindow(win);

  // Wire: final transcript → orchestrator processing
  audioService.setOnFinalTranscript((text) => {
    orchestrator?.processTranscript(text);
  });

  // Wire: speech onset → warm the cloud socket while the question is still
  // being asked, so the TLS handshake is off the critical path.
  audioService.setOnSpeechStart(() => {
    llmOrchestrator.preconnect();
  });

  // Preload STT engine in the background so capture sessions start instantly.
  audioService.initStt().catch((err) => {
    console.warn("[stt] Failed to initialize STT engine:", err);
  });

  // Initialize system tray
  trayService = new TrayService(win);
  console.log("[tray] System tray initialized");
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.interview-answer");

  // Auto-grant getDisplayMedia requests (no picker) for system audio capture
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      callback({
        audio: "loopback",
        video: sources[0]
          ? { id: sources[0].id, name: sources[0].name }
          : undefined,
      });
    },
  );

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  await createWindow();

  // Register global shortcut: Ctrl+Alt+I to toggle visibility
  const registered = globalShortcut.register("CommandOrControl+Alt+I", () => {
    trayService?.toggleVisibility();
  });
  if (registered) {
    console.log("[tray] Global shortcut Ctrl+Alt+I registered");
  } else {
    console.warn("[tray] Failed to register global shortcut");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  trayService?.destroy();
  projectCatalog.destroy();
});

app.on("window-all-closed", () => {
  audioService?.destroy();
  orchestrator?.destroy();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
