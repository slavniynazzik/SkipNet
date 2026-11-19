import { globalShortcut } from 'electron'
import { triggerMainWindow } from './window-ref'
import { startTgws, stopTgws, getTgwsStatus } from '../core/tgws'
import { startZapret, stopZapret, getZapretStatus } from '../core/zapret'
import { appLog } from '../utils/app-logger'
import {
  collectShortcutRegistrations,
  setFailedShortcuts,
  type ShortcutBinding
} from './shortcut-status'

/**
 * (Re-)register every global shortcut from `config`.
 *
 * `globalShortcut.unregisterAll()` runs first so a changed accelerator does not
 * leave the old binding alive and so the same combination can be re-bound
 * after a config patch. `register()` returns false when another app owns the
 * combination; those failures are stored for diagnostics and returned here.
 * Never called on a timer — only at startup, on window recreation and after a
 * config patch that actually changed one of the shortcut fields.
 */
export function applyShortcuts(config: AppConfig): string[] {
  globalShortcut.unregisterAll()

  const bindings: ShortcutBinding[] = []
  if (config.showWindowShortcut) {
    bindings.push({ accelerator: config.showWindowShortcut, handler: () => triggerMainWindow() })
  }
  if (config.tgwsToggleShortcut) {
    bindings.push({
      accelerator: config.tgwsToggleShortcut,
      handler: () => {
        const s = getTgwsStatus().state
        if (s === 'running') stopTgws().catch(() => void 0)
        else startTgws().catch(() => void 0)
      }
    })
  }
  if (config.zapretToggleShortcut) {
    bindings.push({
      accelerator: config.zapretToggleShortcut,
      handler: () => {
        const s = getZapretStatus().state
        if (s === 'running') stopZapret().catch(() => void 0)
        else startZapret().catch(() => void 0)
      }
    })
  }

  // P3: `register()` returns false when another app owns the combination; the
  // old try/catch swallowed that. Keep the failures and surface them in
  // diagnostics instead of silently losing the shortcut.
  const result = collectShortcutRegistrations(bindings, (accelerator, handler) =>
    globalShortcut.register(accelerator, handler)
  )
  setFailedShortcuts(result.failed)
  if (result.failed.length > 0) {
    appLog('warn', `Не удалось зарегистрировать горячие клавиши: ${result.failed.join(', ')}`)
  }
  return result.failed
}
