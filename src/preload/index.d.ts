export interface SkipnetBridge {
  /** Renderer OS platform (`win32`, `darwin`, `linux`). */
  readonly platform: NodeJS.Platform
  /**
   * Invoke an allow-listed main-process operation. Rejects with
   * `Error('IPC channel not allowed: …')` for any channel outside
   * `INVOKE_CHANNELS`.
   */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /**
   * Subscribe to an allow-listed main -> renderer event. Unknown channels are
   * ignored and the returned function unsubscribes this listener only.
   */
  on(channel: string, listener: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    skipnet: SkipnetBridge
  }
}
