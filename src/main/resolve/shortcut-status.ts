/**
 * Global shortcut registration bookkeeping (P3).
 *
 * `globalShortcut.register()` returns a boolean instead of throwing when
 * another application already owns the combination. The old code wrapped the
 * call in `try/catch` and discarded the result, so a shortcut silently stopped
 * working after Windows resumed from sleep or a game grabbed the key. This
 * module collects the failures and exposes them through diagnostics.
 *
 * Pure collector + a tiny in-memory store; no Electron import, so it is
 * testable without a runtime.
 */

export interface ShortcutBinding {
  /** Electron accelerator (e.g. `CommandOrControl+Shift+F12`). */
  accelerator: string
  handler: () => void
}

export interface ShortcutRegistrationResult {
  registered: string[]
  failed: string[]
}

/**
 * Register every non-empty binding, collecting the ones that were rejected.
 * A throwing `register` is treated as a rejection, never propagated.
 */
export function collectShortcutRegistrations(
  bindings: readonly ShortcutBinding[],
  register: (accelerator: string, handler: () => void) => boolean
): ShortcutRegistrationResult {
  const registered: string[] = []
  const failed: string[] = []
  for (const binding of bindings) {
    const accelerator = binding.accelerator?.trim()
    if (!accelerator) continue
    let ok = false
    try {
      ok = register(accelerator, binding.handler) === true
    } catch {
      ok = false
    }
    if (ok) registered.push(accelerator)
    else failed.push(accelerator)
  }
  return { registered, failed }
}

let failedAccelerators: string[] = []

export function setFailedShortcuts(list: readonly string[]): void {
  failedAccelerators = [...list]
}

export function getFailedShortcuts(): string[] {
  return [...failedAccelerators]
}
