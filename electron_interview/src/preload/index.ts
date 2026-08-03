import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcChannels'

const FROM_RENDERER = [IPC.AUDIO_START, IPC.AUDIO_STOP, IPC.AUDIO_CHUNK, IPC.TEXT_PROCESS, IPC.SESSION_START, IPC.HISTORY_APPEND, IPC.WINDOW_MINIMIZE, IPC.WINDOW_MAXIMIZE, IPC.WINDOW_CLOSE, IPC.WINDOW_SNAP, IPC.WINDOW_TOGGLE_COMPACT, IPC.WINDOW_TOGGLE_ALWAYS_ON_TOP, IPC.SESSION_SET_PROJECT] as const
const TO_RENDERER = [
  IPC.TRANSCRIPT_INTERIM,
  IPC.TRANSCRIPT_FINAL,
  IPC.ANSWER_TOKEN,
  IPC.ANSWER_DONE,
  IPC.ANSWER_ERROR,
  IPC.ANSWER_RESET,
  IPC.STATUS_UPDATE,
  IPC.ERROR_OCCURRED,
  IPC.STT_STATUS,
  IPC.PROJECTS_UPDATED
] as const

const api = {
  send(channel: string, ...args: unknown[]): void {
    if ((FROM_RENDERER as readonly string[]).includes(channel)) {
      ipcRenderer.send(channel, ...args)
    }
  },

  on(channel: string, callback: (...args: unknown[]) => void): void {
    if ((TO_RENDERER as readonly string[]).includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args))
    }
  },

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args)
  },

  removeAllListeners(channel: string): void {
    if ((TO_RENDERER as readonly string[]).includes(channel)) {
      ipcRenderer.removeAllListeners(channel)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
