/**
 * Stub for `@electron-toolkit/utils`.
 *
 * The real package is an externalized node_modules dependency that imports
 * Electron itself, so Vitest cannot apply the `electron` alias inside it.
 * Production code only uses `is.dev` (plus `electronApp`/`optimizer` in the
 * main entry point that tests never load), so a tiny in-memory fake is enough.
 */
export const is = { dev: false }

export const platform = { isWindows: true, isMacOS: false, isLinux: false }

export const electronApp = {
  setAppUserModelId: (_id: string) => undefined,
  setAutoLaunch: (_auto: boolean) => false,
  skipProxy: async () => undefined
}

export const optimizer = {
  watchWindowShortcuts: () => undefined,
  registerFramelessWindowIpc: () => undefined
}

export default { is, platform, electronApp, optimizer }
