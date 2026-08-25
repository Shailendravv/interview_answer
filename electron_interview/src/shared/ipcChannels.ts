export const IPC = {
  // Audio (renderer → main)
  AUDIO_START: 'audio:start',
  AUDIO_STOP: 'audio:stop',
  AUDIO_CHUNK: 'audio:chunk',
  AUDIO_MUTE: 'audio:mute',

  // Transcript (main → renderer)
  TRANSCRIPT_INTERIM: 'transcript:interim',
  TRANSCRIPT_FINAL: 'transcript:final',

  // Answer (main → renderer)
  ANSWER_TOKEN: 'answer:token',
  ANSWER_DONE: 'answer:done',
  ANSWER_ERROR: 'answer:error',
  ANSWER_RESET: 'answer:reset',

  // Text (renderer → main)
  TEXT_PROCESS: 'text:process',

  // Session history (renderer → main)
  SESSION_START: 'session:start',
  HISTORY_APPEND: 'history:append',
  SESSION_SET_PROJECT: 'session:set-project',
  SESSION_SET_MODEL: 'session:set-model',

  // Session history (renderer invoke → main)
  HISTORY_LOAD: 'history:load',

  // Desktop sources (renderer invoke → main)
  GET_DESKTOP_SOURCES: 'desktop:sources',

  // App config (renderer invoke → main)
  GET_APP_CONFIG: 'app:config',

  // Window controls (renderer → main)
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_SNAP: 'window:snap',
  WINDOW_TOGGLE_COMPACT: 'window:toggle-compact',
  WINDOW_TOGGLE_ALWAYS_ON_TOP: 'window:toggle-always-on-top',

  // Window state (renderer invoke → main)
  WINDOW_GET_STATE: 'window:get-state',

  // Projects catalog
  PROJECTS_LIST: 'projects:list',
  PROJECTS_OPEN: 'projects:open',
  PROJECTS_UPDATED: 'projects:updated',

  // Status
  STATUS_UPDATE: 'status:update',
  ERROR_OCCURRED: 'error:occurred',
  STT_STATUS: 'stt:status',

  // Latency telemetry (main → renderer; renderer invoke → main)
  LATENCY_REPORT: 'latency:report',
  LATENCY_UI: 'latency:ui'
} as const
