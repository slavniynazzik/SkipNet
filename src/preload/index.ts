import { contextBridge, ipcRenderer } from 'electron'
import { isEventChannel, isInvokeChannel } from '../shared/ipc-channels'

/**
 * The entire privileged surface available to the renderer.
 *
 * Deliberately narrow: no raw `ipcRenderer`, no `process.env`, no `webFrame`,
 * no `webUtils`. `invoke` and `on` are filtered against the frozen channel
 * registry in `src/shared/ipc-channels.ts`, so a renderer compromise cannot
 * reach a channel that was never meant to be exposed.
 */
const skipnet = {
  platform: process.platform,

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isInvokeChannel(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    if (!isEventChannel(channel)) return () => undefined
    // Strip the IpcRendererEvent: the renderer only sees the payload.
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
      listener(...args)
    }
    ipcRenderer.on(channel, wrapped)
    // Only this registration is removed — never every listener on the channel.
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('skipnet', skipnet)
