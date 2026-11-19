import { globalShortcut } from 'electron'
import { getAppConfig } from '../config'
import { triggerMainWindow } from '..'
import { startTgws, stopTgws, getTgwsStatus } from '../core/tgws'
import { startZapret, stopZapret, getZapretStatus } from '../core/zapret'
import { appLog } from '../utils/app-logger'
import {
  collectShortcutRegistrations,
  setFailedShortcuts,
  type ShortcutBinding
} from './shortcut-status'

export async function initShortcut(): Promise<void> {
  const cfg = await getAppConfig()
  globalShortcut.unregisterAll()

  const bindings: ShortcutBinding[] = []
  if (cfg.showWindowShortcut) {
    bindings.push({ accelerator: cfg.showWindowShortcut, handler: () => triggerMainWindow() })
  }
  if (cfg.tgwsToggleShortcut) {
    bindings.push({
      accelerator: cfg.tgwsToggleShortcut,
      handler: () => {
        const s = getTgwsStatus().state
        if (s === 'running') stopTgws().catch(() => void 0)
        else startTgws().catch(() => void 0)
      }
    })
  }
  if (cfg.zapretToggleShortcut) {
    bindings.push({
      accelerator: cfg.zapretToggleShortcut,
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
}
