import { useEffect, useState, useCallback, useRef } from "react";
import { useAppStore } from "./store/appStore";
import {
  startCapture,
  startSystemCapture,
  stopCapture,
} from "./services/audioCapture";
import { ChatView } from "./components/ChatView";
import { TopBar } from "./components/TopBar";
import { NotesPopover } from "./components/NotesPopover";
import { ProjectsView, ProjectListPayload } from "./components/ProjectsView";
import { initStealth } from "./stealth";

const EMPTY_PAYLOAD: ProjectListPayload = {
  introduction: { name: "", title: "", summary: "", skills: [] },
  projects: [],
};

function App(): JSX.Element {
  const currentQuestion = useAppStore((s) => s.currentQuestion);
  const currentAnswer = useAppStore((s) => s.currentAnswer);
  const history = useAppStore((s) => s.history);
  const isListening = useAppStore((s) => s.isListening);
  const status = useAppStore((s) => s.status);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const setTranscript = useAppStore((s) => s.setTranscript);
  const appendAnswerToken = useAppStore((s) => s.appendAnswerToken);
  const resetAnswer = useAppStore((s) => s.resetAnswer);
  const pushToHistory = useAppStore((s) => s.pushToHistory);
  const loadHistory = useAppStore((s) => s.loadHistory);
  const clearSession = useAppStore((s) => s.clearSession);
  const setIsListening = useAppStore((s) => s.setIsListening);
  const setStatus = useAppStore((s) => s.setStatus);
  const setActiveProjectId = useAppStore((s) => s.setActiveProjectId);
  const reset = useAppStore((s) => s.reset);

  const [sttEngine, setSttEngine] = useState("");
  const [sttError, setSttError] = useState<string | null>(null);
  const [codingInput, setCodingInput] = useState("");
  const [audioSilentWarning, setAudioSilentWarning] = useState(false);
  const [captureSource, setCaptureSource] = useState<"system" | "mic" | null>(
    null,
  );
  const [liveTranscript, setLiveTranscript] = useState("");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [deviceRecoveredNotice, setDeviceRecoveredNotice] = useState(false);
  const [deviceSwitchWarning, setDeviceSwitchWarning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [view, setView] = useState<"chat" | "projects">("chat");
  const [notesOpen, setNotesOpen] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [projectsPayload, setProjectsPayload] =
    useState<ProjectListPayload>(EMPTY_PAYLOAD);
  const interimDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micFallbackRef = useRef(false);
  const startingRef = useRef(false);
  const recoveryCooldownRef = useRef(false);
  const recoveryAttemptsRef = useRef(0);
  const codingInputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the coding textarea to fit multi-line content (Shift+Enter)
  useEffect(() => {
    const el = codingInputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [codingInput]);

  // Screen-share stealth: strip DOM tooltips app-wide (incl. future nodes)
  useEffect(() => initStealth(), []);

  // Load persisted history + project catalog + window state on mount
  useEffect(() => {
    window.api
      .invoke("history:load")
      .then((pairs) => {
        if (Array.isArray(pairs) && pairs.length > 0) {
          loadHistory(pairs as never[]);
        }
      })
      .catch(() => {});
    window.api
      .invoke("app:config")
      .then((cfg) => {
        micFallbackRef.current = Boolean(
          (cfg as { micFallbackEnabled?: boolean })?.micFallbackEnabled,
        );
      })
      .catch(() => {});
    window.api
      .invoke("window:get-state")
      .then((state) => {
        setIsAlwaysOnTop(Boolean((state as { isAlwaysOnTop?: boolean })?.isAlwaysOnTop));
      })
      .catch(() => {});
    window.api
      .invoke("projects:list")
      .then((payload) => {
        if (payload) setProjectsPayload(payload as ProjectListPayload);
      })
      .catch(() => {});
  }, []);

  // Hot-reload projects.json changes into the UI
  useEffect(() => {
    const handler = (): void => {
      window.api
        .invoke("projects:list")
        .then((payload) => {
          if (payload) setProjectsPayload(payload as ProjectListPayload);
        })
        .catch(() => {});
    };
    window.api.on("projects:updated", handler);
    return () => window.api.removeAllListeners("projects:updated");
  }, []);

  // Global keyboard shortcuts for window snapping / layout
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      const snapMap: Record<string, string> = {
        "1": "top-left",
        "2": "top-right",
        "3": "bottom-left",
        "4": "bottom-right",
      };
      if (snapMap[key]) {
        e.preventDefault();
        window.api.send("window:snap", snapMap[key]);
        return;
      }
      if (key === "arrowup") {
        e.preventDefault();
        window.api.send("window:maximize");
        return;
      }
      if (key === "arrowleft") {
        e.preventDefault();
        window.api.send("window:snap", "left-half");
        return;
      }
      if (key === "arrowright") {
        e.preventDefault();
        window.api.send("window:snap", "right-half");
        return;
      }
      if (key === "m") {
        e.preventDefault();
        window.api.send("window:minimize");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    const api = window.api;

    api.on("transcript:interim", (text) => {
      if (interimDebounceRef.current) clearTimeout(interimDebounceRef.current);
      interimDebounceRef.current = setTimeout(() => {
        setLiveTranscript(text as string);
      }, 200);
    });
    api.on("transcript:final", (text) => {
      if (interimDebounceRef.current) clearTimeout(interimDebounceRef.current);
      setTranscript(text as string);
      setLiveTranscript("");
    });
    api.on("answer:token", (token) => {
      appendAnswerToken(token as string);
    });
    api.on("answer:reset", () => {
      resetAnswer();
    });
    api.on("answer:done", (data) => {
      const state = useAppStore.getState();
      const payload = data as { question?: string };
      const q = payload?.question || state.currentQuestion;
      const a = state.currentAnswer;
      if (q && a) {
        const pair = {
          id: `qa_${Date.now()}`,
          question: q,
          answer: a,
          timestamp: Date.now(),
        };
        state.pushToHistory(q, a);
        window.api.send("history:append", pair);
      }
      setLiveTranscript("");
      setIsListening(true);
      setStatus("idle");
    });
    api.on("answer:error", (err) => {
      console.error("Generation error:", err);
      setGenerationError(String(err));
      setStatus("error");
    });
    api.on("status:update", (data) => {
      const payload = data as { status: string };
      if (payload.status === "listening") {
        setIsListening(true);
        setStatus("listening");
      } else if (payload.status === "processing") {
        setStatus("processing");
      } else if (payload.status === "idle") {
        // Orchestrator also sends 'idle' after an answer finishes, but capture
        // is still running - so don't clear isListening here. Only a manual
        // Stop (or a failed capture start) ends listening.
        setStatus("idle");
      }
    });

    api.on("stt:status", (data) => {
      const payload = data as { engine: string; error: string | null };
      setSttEngine(payload.engine);
      setSttError(payload.error);
    });

    const onAudioSilent = (): void => setAudioSilentWarning(true);
    window.addEventListener("audio:silent", onAudioSilent);
    const onAudioSource = (e: Event): void => {
      setCaptureSource((e as CustomEvent<"system" | "mic">).detail);
    };
    window.addEventListener("audio:source", onAudioSource);
    const onTrackLost = (): void => {
      if (!useAppStore.getState().isListening) return;
      if (recoveryCooldownRef.current) return;
      if (recoveryAttemptsRef.current >= 1) {
        setDeviceSwitchWarning(true);
        return;
      }
      recoveryCooldownRef.current = true;
      recoveryAttemptsRef.current += 1;
      stopCapture();
      startSystemCapture()
        .then(() => {
          recoveryAttemptsRef.current = 0;
          setDeviceRecoveredNotice(true);
          setTimeout(() => setDeviceRecoveredNotice(false), 4000);
        })
        .catch(() => {
          if (micFallbackRef.current) {
            startCapture()
              .then(() => {
                recoveryAttemptsRef.current = 0;
                setDeviceRecoveredNotice(true);
                setTimeout(() => setDeviceRecoveredNotice(false), 4000);
              })
              .catch(() => {
                setAudioSilentWarning(true);
              });
          } else {
            setDeviceSwitchWarning(true);
          }
        })
        .finally(() => {
          setTimeout(() => {
            recoveryCooldownRef.current = false;
          }, 5000);
        });
    };
    window.addEventListener("audio:track-lost", onTrackLost);

    return () => {
      window.removeEventListener("audio:silent", onAudioSilent);
      window.removeEventListener("audio:source", onAudioSource);
      window.removeEventListener("audio:track-lost", onTrackLost);
      (
        [
          "transcript:interim",
          "transcript:final",
          "answer:token",
          "answer:reset",
          "answer:done",
          "answer:error",
          "status:update",
          "stt:status",
        ] as const
      ).forEach((ch) => api.removeAllListeners(ch));
    };
  }, []);

  const handleStart = useCallback(async (): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true;
    recoveryAttemptsRef.current = 0;
    setIsStarting(true);
    setGenerationError(null);
    resetAnswer();
    setTranscript("");
    setLiveTranscript("");
    clearSession();
    window.api.send("session:start");
    setAudioSilentWarning(false);
    setCaptureSource(null);
    try {
      await startSystemCapture();
    } catch (err) {
      console.error("System audio capture failed:", err);
      const cfg = (await window.api.invoke("app:config")) as {
        micFallbackEnabled?: boolean;
      };
      if (cfg?.micFallbackEnabled) {
        try {
          await startCapture();
        } catch (micErr) {
          console.error("Mic access denied:", micErr);
          setIsListening(false);
          setStatus("error");
        }
      } else {
        setIsListening(false);
        setStatus("idle");
        setAudioSilentWarning(true);
      }
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, []);

  const handleStop = (): void => {
    stopCapture();
    setIsListening(false);
    setAudioSilentWarning(false);
    setLiveTranscript("");
    setCaptureSource(null);
    setGenerationError(null);
  };

  const handleAnswerCoding = (): void => {
    if (!codingInput.trim()) return;
    resetAnswer();
    setTranscript(codingInput.trim());
    window.api.send("text:process", codingInput.trim());
    setCodingInput("");
  };

  const handleSelectProject = (id: string | null): void => {
    setActiveProjectId(id);
    window.api.send("session:set-project", id);
  };

  const handleToggleProjects = (): void => {
    setView((v) => (v === "projects" ? "chat" : "projects"));
    setNotesOpen(false);
  };

  const handleToggleAlwaysOnTop = (): void => {
    setIsAlwaysOnTop((v) => !v);
    window.api.send("window:toggle-always-on-top");
  };

  const handleEditProjects = (): void => {
    window.api.invoke("projects:open").catch(() => {});
  };

  const statusColor =
    status === "listening"
      ? "bg-green-800 text-green-300 animate-pulse"
      : status === "processing"
        ? "bg-yellow-800 text-yellow-300 animate-pulse"
        : status === "error"
          ? "bg-red-800 text-red-300"
          : "bg-white/10 text-gray-400";

  // Build messages for ChatView: history + current in-flight
  const questionBubble = currentQuestion || liveTranscript;
  const chatMessages = [
    ...history.flatMap((qa) => [
      { role: "user" as const, content: qa.question },
      { role: "assistant" as const, content: qa.answer },
    ]),
    ...(questionBubble
      ? [{ role: "user" as const, content: questionBubble }]
      : []),
    ...(currentAnswer || status === "processing"
      ? [
          {
            role: "assistant" as const,
            content: currentAnswer,
            isStreaming: status === "processing",
          },
        ]
      : []),
  ];

  const activeProject = projectsPayload.projects.find(
    (p) => p.id === activeProjectId,
  );

  return (
    <>
      <div className="h-screen bg-black/30 backdrop-blur-xl text-gray-100 p-2 flex flex-col border border-white/30 rounded-lg overflow-hidden">
        <div className="max-w-4xl mx-auto w-full flex-1 flex flex-col min-h-0">
          <TopBar
            view={view}
            onToggleProjects={handleToggleProjects}
            notesOpen={notesOpen}
            onToggleNotes={() => setNotesOpen((o) => !o)}
            isAlwaysOnTop={isAlwaysOnTop}
            onToggleAlwaysOnTop={handleToggleAlwaysOnTop}
          />

          {view === "projects" ? (
            <ProjectsView
              payload={projectsPayload}
              activeProjectId={activeProjectId}
              onUseProject={handleSelectProject}
              onEditProjects={handleEditProjects}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="relative flex-1 min-h-0">
                <div className="absolute inset-0 overflow-y-auto space-y-3 px-1">
                  {captureSource && (
                    <div className="flex justify-center">
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded ${
                          captureSource === "system"
                            ? "bg-blue-500/20 text-blue-300"
                            : "bg-purple-500/20 text-purple-300"
                        }`}
                      >
                        Input: {captureSource === "system" ? "System" : "Mic"}
                      </span>
                    </div>
                  )}
                  {chatMessages.length === 0 &&
                    status === "idle" &&
                    !isListening && (
                      <div className="flex justify-center pt-12">
                        <div className="text-center">
                          <p className="text-gray-500 text-sm">
                            Click{" "}
                            <span className="text-emerald-400 font-medium">
                              Start
                            </span>{" "}
                            to begin
                          </p>
                          <p className="text-gray-600 text-xs mt-1">
                            The assistant will listen and answer your interview
                            questions
                          </p>
                        </div>
                      </div>
                    )}
                  {chatMessages.length === 0 && isListening && (
                    <div className="flex justify-start">
                      <div className="bg-white/10 backdrop-blur-xl rounded-2xl rounded-bl-md px-3 py-2 border border-white/20">
                        <p className="text-gray-400 text-xs italic">
                          Listening...
                        </p>
                      </div>
                    </div>
                  )}
                  <ChatView messages={chatMessages} />
                </div>
                <NotesPopover
                  open={notesOpen}
                  title={activeProject?.title ?? ""}
                  content={activeProject?.notes ?? ""}
                  onClose={() => setNotesOpen(false)}
                />
              </div>

              <div className="space-y-2 shrink-0 pt-2">
                <div className="flex gap-2">
                  <button
                    onClick={handleStart}
                    disabled={isListening || isStarting}
                    className="px-4 py-1.5 bg-emerald-600/30 hover:bg-emerald-500/50 disabled:bg-white/5 disabled:text-gray-500 backdrop-blur-md rounded-lg transition-colors font-medium text-sm"
                  >
                    {isListening
                      ? "Listening..."
                      : isStarting
                        ? "Starting..."
                        : "Start"}
                  </button>
                  <button
                    onClick={handleStop}
                    disabled={!isListening}
                    className="px-4 py-1.5 bg-red-600/30 hover:bg-red-500/50 disabled:bg-white/5 disabled:text-gray-500 backdrop-blur-md rounded-lg transition-colors font-medium text-sm"
                  >
                    Stop
                  </button>
                  {status === "error" && (
                    <button
                      onClick={reset}
                      className="px-4 py-1.5 bg-blue-600/30 hover:bg-blue-500/50 backdrop-blur-md rounded-lg transition-colors font-medium text-sm"
                    >
                      Reset
                    </button>
                  )}
                </div>

                <div className="flex gap-2">
                  <textarea
                    ref={codingInputRef}
                    value={codingInput}
                    onChange={(e) => setCodingInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleAnswerCoding();
                      }
                    }}
                    placeholder="Paste the coding question... (Enter to submit)"
                    className="flex-1 bg-white/10 backdrop-blur-xl border border-white/20 rounded-lg p-2 text-xs text-gray-100 resize-none min-h-12 max-h-28 overflow-y-auto focus:outline-none focus:border-emerald-500"
                  />
                  <button
                    onClick={handleAnswerCoding}
                    disabled={!codingInput.trim() || status === "processing"}
                    className="px-4 py-1.5 bg-emerald-600/30 hover:bg-emerald-500/50 disabled:bg-white/5 disabled:text-gray-500 backdrop-blur-md rounded-lg transition-colors font-medium text-sm self-end"
                  >
                    Answer
                  </button>
                </div>

                {audioSilentWarning && (
                  <div className="flex items-center gap-2 bg-yellow-500/10 backdrop-blur-md text-yellow-300 text-xs px-3 py-2 rounded-lg border border-yellow-500/30">
                    <span>
                      No audio captured. Switch to speakers or set
                      AUDIO_MIC_FALLBACK=1.
                    </span>
                    <button
                      onClick={() => setAudioSilentWarning(false)}
                      className="ml-auto text-yellow-400 hover:text-yellow-200 font-medium"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {deviceSwitchWarning && (
                  <div className="flex items-center gap-2 bg-yellow-500/10 backdrop-blur-md text-yellow-300 text-xs px-3 py-2 rounded-lg border border-yellow-500/30">
                    <span>
                      Audio output changed. Please click Start to share audio
                      again.
                    </span>
                    <button
                      onClick={() => setDeviceSwitchWarning(false)}
                      className="ml-auto text-yellow-400 hover:text-yellow-200 font-medium"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {deviceRecoveredNotice && (
                  <div className="flex items-center gap-2 bg-emerald-500/10 backdrop-blur-md text-emerald-300 text-xs px-3 py-2 rounded-lg border border-emerald-500/30">
                    <span>Audio device changed. Recovered.</span>
                  </div>
                )}

                {generationError && (
                  <div className="bg-red-500/10 backdrop-blur-md text-red-300 text-xs px-3 py-2 rounded-lg border border-red-500/30">
                    {generationError}
                  </div>
                )}

                <div className="flex items-center gap-3 text-xs pt-1">
                  <span
                    className={`px-2 py-0.5 rounded ${statusColor}`}
                  >
                    {status}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded ${
                      sttEngine === "none"
                        ? "bg-red-500/20 text-red-300"
                        : sttEngine
                          ? "bg-green-500/20 text-green-300"
                          : "bg-white/10 text-gray-500"
                    }`}
                  >
                    STT: {sttEngine || "..."}
                  </span>
                  {sttError && (
                    <span className="text-red-400 font-medium">{sttError}</span>
                  )}
                  {history.length === 0 &&
                    !sttError &&
                    !isListening &&
                    status === "idle" && (
                      <span className="text-gray-500">
                        Click Start and the app will listen to your speaker
                      </span>
                    )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default App;
