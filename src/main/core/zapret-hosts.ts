/**
 * Hosts-related diagnostics.
 *
 * The editable hosts workflow now lives in `hosts-editor.ts`; this module only
 * answers "does the hosts file contain YouTube overrides?" for the diagnostics
 * report. `hosts-file.ts` owns the actual path and read/write logic.
 */

import { HOSTS_BLOCK_END, HOSTS_BLOCK_START, readHostsText } from './hosts-file'
import { LEGACY_SKIPNET_END, LEGACY_SKIPNET_START } from './hosts-render'

/**
 * True when the hosts file contains YouTube entries outside SkipNet's own
 * managed blocks. Entries written by the hosts editor are intentional and
 * visible in the Hosts tab; warning about them in Diagnostics would be noise.
 */
export function hostsHasYoutubeEntries(): boolean {
  const hosts = readHostsText()
  if (!hosts) return false
  let managed = false
  for (const line of hosts.split(/\r?\n/)) {
    const value = line.trim()
    if (value === HOSTS_BLOCK_START || value === LEGACY_SKIPNET_START) {
      managed = true
      continue
    }
    if (value === HOSTS_BLOCK_END || value === LEGACY_SKIPNET_END) {
      managed = false
      continue
    }
    if (managed || !value || value.startsWith('#')) continue
    if (/youtube\.com|youtu\.be/i.test(value)) return true
  }
  return false
}
