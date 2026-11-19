import type { BrowserWindow } from 'electron'

/**
 * Single owner of the main `BrowserWindow` reference.
 *
 * Before Q4, `resolve/*` imported `mainWindow` and the window commands from
 * `src/main/index.ts`, which created an import cycle (index -> tray -> index).
 * Everything that needs the window now depends on this leaf module instead.
 *
 * The commands are injected by `index.ts` because creating/showing a window
 * requires the app bootstrap (config, window-state, protocol handlers).
 */

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
}

export interface MainWindowActions {
  show: () => Promise<void>
  trigger: () => Promise<void>
}

let actions: MainWindowActions | null = null

/** Registered once by `src/main/index.ts` after the bootstrap functions exist. */
export function setMainWindowActions(next: MainWindowActions): void {
  actions = next
}

export async function showMainWindow(): Promise<void> {
  if (actions) await actions.show()
}

export async function triggerMainWindow(): Promise<void> {
  if (actions) await actions.trigger()
}
