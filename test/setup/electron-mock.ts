/**
 * Deterministic Electron stub for unit tests.
 *
 * `vitest.config.ts` aliases the `electron` module to this file, so every
 * production module that imports Electron gets these in-memory fakes instead
 * of the real runtime. Nothing here touches the registry, `%APPDATA%`, the
 * real hosts file or the network: all paths live under a unique directory in
 * the OS temp folder.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(os.tmpdir(), 'skipnet-test-'))

export const testPaths = {
  root,
  home: path.join(root, 'home'),
  userData: path.join(root, 'userData'),
  appData: path.join(root, 'appData'),
  temp: path.join(root, 'temp'),
  appPath: path.join(root, 'app'),
  exe: path.join(root, 'app', 'SkipNet.exe')
}

for (const dir of [
  testPaths.home,
  testPaths.userData,
  testPaths.appData,
  testPaths.temp,
  testPaths.appPath
]) {
  mkdirSync(dir, { recursive: true })
}

/* -------------------------------------------------------------------------- */
/* app                                                                        */
/* -------------------------------------------------------------------------- */

export const app = {
  isPackaged: true,
  getName: () => 'skipnet',
  getVersion: () => '1.4.0-test',
  getAppPath: () => testPaths.appPath,
  getPath(name: string): string {
    switch (name) {
      case 'home':
        return testPaths.home
      case 'userData':
        return testPaths.userData
      case 'appData':
        return testPaths.appData
      case 'temp':
        return testPaths.temp
      case 'exe':
        return testPaths.exe
      case 'logs':
        return path.join(testPaths.userData, 'logs')
      case 'sessionData':
        return path.join(testPaths.userData, 'session')
      case 'desktop':
        return path.join(testPaths.home, 'Desktop')
      case 'documents':
        return path.join(testPaths.home, 'Documents')
      case 'downloads':
        return path.join(testPaths.home, 'Downloads')
      default: {
        const dir = path.join(root, name)
        mkdirSync(dir, { recursive: true })
        return dir
      }
    }
  },
  on: () => undefined,
  once: () => undefined,
  whenReady: async () => undefined,
  quit: () => undefined,
  exit: () => undefined,
  relaunch: () => undefined,
  setName: () => undefined,
  setAppUserModelId: () => undefined,
  setLoginItemSettings: () => undefined,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => undefined,
  isDefaultProtocolClient: () => false,
  setAsDefaultProtocolClient: () => true,
  focus: () => undefined,
  hide: () => undefined,
  show: () => undefined
}

/* -------------------------------------------------------------------------- */
/* ipcMain                                                                    */
/* -------------------------------------------------------------------------- */

export const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

export const ipcMain = {
  handle(channel: string, listener: (...args: unknown[]) => unknown) {
    ipcHandlers.set(channel, listener)
  },
  removeHandler(channel: string) {
    ipcHandlers.delete(channel)
  },
  on: () => undefined,
  once: () => undefined,
  removeListener: () => undefined,
  removeAllListeners: () => {
    ipcHandlers.clear()
  }
}

/* -------------------------------------------------------------------------- */
/* BrowserWindow                                                              */
/* -------------------------------------------------------------------------- */

export const browserWindows: MockBrowserWindow[] = []

export class MockBrowserWindow {
  destroyed = false
  visible = true
  sent: Array<{ channel: string; args: unknown[] }> = []
  webContents = {
    id: 1,
    send: (channel: string, ...args: unknown[]) => {
      this.sent.push({ channel, args })
    },
    on: () => undefined,
    once: () => undefined,
    openDevTools: () => undefined,
    closeDevTools: () => undefined,
    isDevToolsOpened: () => false,
    setWindowOpenHandler: () => undefined,
    executeJavaScript: async () => undefined,
    reload: () => undefined,
    invalidate: () => undefined
  }

  constructor(..._args: unknown[]) {
    browserWindows.push(this)
  }

  static getAllWindows(): MockBrowserWindow[] {
    return browserWindows.filter((win) => !win.destroyed)
  }

  static fromWebContents(): MockBrowserWindow | null {
    return browserWindows[0] ?? null
  }

  static getFocusedWindow(): MockBrowserWindow | null {
    return MockBrowserWindow.getAllWindows()[0] ?? null
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return false
  }

  isMaximized(): boolean {
    return false
  }

  destroy(): void {
    this.destroyed = true
  }

  close(): void {
    this.destroyed = true
  }

  show(): void {
    this.visible = true
  }

  hide(): void {
    this.visible = false
  }

  focus(): void {
    /* noop */
  }
  minimize(): void {
    /* noop */
  }
  maximize(): void {
    /* noop */
  }
  restore(): void {
    /* noop */
  }
  setMenu(): void {
    /* noop */
  }
  setTitle(): void {
    /* noop */
  }
  setSkipTaskbar(): void {
    /* noop */
  }
  setProgressBar(): void {
    /* noop */
  }
  setAlwaysOnTop(): void {
    /* noop */
  }
  setBounds(): void {
    /* noop */
  }
  getBounds() {
    return { x: 0, y: 0, width: 1280, height: 800 }
  }
  on(): this {
    return this
  }
  once(): this {
    return this
  }
  removeListener(): this {
    return this
  }
  async loadURL(): Promise<void> { /* noop */ }
  async loadFile(): Promise<void> { /* noop */ }
}

export const BrowserWindow = MockBrowserWindow

/* -------------------------------------------------------------------------- */
/* dialogs / shell                                                            */
/* -------------------------------------------------------------------------- */

export const dialog = {
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showErrorBox: () => undefined,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showOpenDialogSync: () => undefined,
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showSaveDialogSync: () => undefined
}

export const shell = {
  openExternal: async () => undefined,
  openPath: async () => '',
  showItemInFolder: () => undefined,
  trashItem: async () => undefined,
  beep: () => undefined
}

/* -------------------------------------------------------------------------- */
/* theme / shortcuts / menus / tray                                           */
/* -------------------------------------------------------------------------- */

export const nativeTheme = {
  shouldUseDarkColors: true,
  shouldUseHighContrastColors: false,
  themeSource: 'system' as 'system' | 'light' | 'dark',
  on: () => undefined,
  once: () => undefined,
  removeListener: () => undefined
}

export const globalShortcut = {
  register: () => true,
  registerAll: () => undefined,
  isRegistered: () => false,
  unregister: () => undefined,
  unregisterAll: () => undefined
}

export class MockMenu {
  items: unknown[]
  constructor(template: unknown[] = []) {
    this.items = template
  }
  static buildFromTemplate(template: unknown[] = []) {
    return new MockMenu(template)
  }
  static setApplicationMenu() {
    /* noop */
  }
  static getApplicationMenu() {
    return null
  }
  popup() { /* noop */ }
  closePopup() { /* noop */ }
}

export const Menu = MockMenu

export class MockTray {
  destroyed = false
  setToolTip() { /* noop */ }
  setTitle() { /* noop */ }
  setImage() { /* noop */ }
  setContextMenu() { /* noop */ }
  setPressedImage() { /* noop */ }
  popUpContextMenu() { /* noop */ }
  on() {
    return this
  }
  destroy() {
    this.destroyed = true
  }
}

export const Tray = MockTray

/* -------------------------------------------------------------------------- */
/* network / session / protocol                                               */
/* -------------------------------------------------------------------------- */

function offline(): never {
  throw new Error('network access is disabled in unit tests')
}

export const net = {
  isOnline: () => true,
  fetch: async () => offline(),
  request: () => {
    offline()
  }
}

const webRequest = {
  on: () => undefined,
  onBeforeRequest: () => undefined,
  onBeforeSendHeaders: () => undefined,
  onHeadersReceived: () => undefined,
  onResponseStarted: () => undefined,
  onCompleted: () => undefined,
  onErrorOccurred: () => undefined
}

const cookies = {
  get: async () => [],
  set: async () => undefined,
  remove: async () => undefined,
  flushStore: async () => undefined
}

export const defaultSession = {
  webRequest,
  cookies,
  clearCache: async () => undefined,
  clearStorageData: async () => undefined,
  setPermissionRequestHandler: () => undefined,
  setPermissionCheckHandler: () => undefined,
  setProxy: async () => undefined,
  resolveProxy: async () => 'DIRECT'
}

export const session = {
  defaultSession,
  fromPartition: () => defaultSession,
  fromPath: () => defaultSession
}

export const protocol = {
  registerSchemesAsPrivileged: () => undefined,
  isProtocolHandled: () => true,
  handle: () => true,
  unhandle: () => undefined,
  interceptFileProtocol: () => true,
  interceptBufferProtocol: () => true,
  interceptStringProtocol: () => true
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Reset mutable state so one test cannot leak windows or handlers into the next. */
export function resetElectronMock(): void {
  browserWindows.length = 0
  ipcHandlers.clear()
  app.isPackaged = true
}

/** Look up a handler registered through `ipcMain.handle` (for future suites). */
export function getIpcHandler(
  channel: string
): ((...args: unknown[]) => unknown) | undefined {
  return ipcHandlers.get(channel)
}

export default {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  nativeTheme,
  globalShortcut,
  Menu,
  Tray,
  net,
  session,
  protocol
}
