import { BrowserWindow } from 'electron'

/**
 * Send one IPC event to every live renderer.
 *
 * Windows can be destroyed between `getAllWindows()` and `send()` (user closes
 * the window while a core process is reporting status), so each send is
 * guarded. Logging and status broadcasts must never throw into the caller.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, ...args)
    } catch {
      /* window went away mid-iteration */
    }
  }
}
