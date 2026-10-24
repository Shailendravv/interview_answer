// Records every IPC message the main process would send to the renderer, with
// a high-resolution timestamp, so UI-visible timings can be measured headless.
import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'

export interface WindowEvent {
  t: number
  channel: string
  args: unknown[]
}

export class FakeWindow {
  readonly events: WindowEvent[] = []
  private emitter = new EventEmitter()

  readonly webContents = {
    send: (channel: string, ...args: unknown[]): void => {
      this.events.push({ t: performance.now(), channel, args })
      this.emitter.emit(channel, ...args)
    }
  }

  isDestroyed(): boolean {
    return false
  }

  on(channel: string, listener: (...args: unknown[]) => void): void {
    this.emitter.on(channel, listener)
  }

  since(index: number): WindowEvent[] {
    return this.events.slice(index)
  }

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow
  }
}
