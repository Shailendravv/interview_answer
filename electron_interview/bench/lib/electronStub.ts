// Minimal stand-in for the `electron` module so main-process code can run
// headless. Only the surface the app's main modules touch is provided.
import { EventEmitter } from 'events'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

/** Fresh userData per run, so evaluation never touches the real app databases. */
export const userDataDir = mkdtempSync(join(tmpdir(), 'interview-eval-'))

/** electron_interview/ -- dev-mode app path, so projects.json resolves as in `npm run dev`. */
export const appRoot = resolve(__dirname, '..', '..')

class IpcMainStub extends EventEmitter {
  handle(): void {}
  removeHandler(): void {}
}

export const ipcMain = new IpcMainStub()

export const electronModule = {
  app: {
    isPackaged: false,
    getPath: (_name: string): string => userDataDir,
    getAppPath: (): string => appRoot,
    getName: (): string => 'interview-eval'
  },
  ipcMain,
  BrowserWindow: class {}
}
