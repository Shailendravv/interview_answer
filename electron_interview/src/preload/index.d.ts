export interface ElectronAPI {
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, callback: (...args: unknown[]) => void) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  removeAllListeners: (channel: string) => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}
