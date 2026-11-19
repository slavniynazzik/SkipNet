import { readFile } from 'fs/promises'
import { themesDir } from '../utils/dirs'
import { nativeTheme } from 'electron'
import path from 'path'
import { existsSync } from 'fs'
import { getMainWindow } from './window-ref'

let insertedCSSKeyMain: string | undefined

export function setNativeTheme(theme: AppTheme): void {
  nativeTheme.themeSource = theme
}

/**
 * Resolve a theme name inside the themes folder. Returns null for names that
 * escape it (`..\..\file`), so `theme:apply` cannot be used to read arbitrary
 * files or inject their contents as CSS.
 */
function themeFile(theme: string): string | null {
  const root = path.resolve(themesDir())
  const full = path.resolve(root, theme)
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null
  return full
}

export async function readTheme(theme: string): Promise<string> {
  const full = themeFile(theme)
  if (!full || !existsSync(full)) return ''
  return await readFile(full, 'utf-8')
}

export async function applyTheme(theme: string): Promise<void> {
  const css = await readTheme(theme)
  const win = getMainWindow()
  try {
    if (insertedCSSKeyMain) {
      await win?.webContents.removeInsertedCSS(insertedCSSKeyMain)
    }
    insertedCSSKeyMain = await win?.webContents.insertCSS(css) ?? undefined
  } catch { /* noop */ }
}
