/**
 * Hosts-related diagnostics.
 *
 * The editable hosts workflow now lives in `hosts-editor.ts`; this module only
 * answers "does the hosts file contain YouTube overrides?" for the diagnostics
 * report. `hosts-file.ts` owns the actual path and read/write logic.
 */

import { readHostsText } from './hosts-file'

/** True when the hosts file contains YouTube entries (a common cause of issues). */
export function hostsHasYoutubeEntries(): boolean {
  const hosts = readHostsText()
  if (!hosts) return false
  return hosts
    .split(/\r?\n/)
    .some((line) => {
      const value = line.trim()
      if (!value || value.startsWith('#')) return false
      return /youtube\.com|youtu\.be/i.test(value)
    })
}
