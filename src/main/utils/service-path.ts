/**
 * Service image-path comparison helpers (L1).
 *
 * `sc qc` output is decoded with the console OEM code page. On a Cyrillic (or
 * other non-Latin) install path Windows may hand us `\uFFFD` replacement
 * characters instead of the real path. Comparing that garbage with our expected
 * `.sys` path never matches, and the old code responded by running
 * `sc stop` + `sc delete`, re-registering WinDivert on every single start.
 *
 * Rule:
 *  - a path containing `\uFFFD` is *unknown* → never delete the service;
 *  - otherwise compare only the file name (`path.basename`), case-insensitively,
 *    because the install directory may legitimately differ from the SCM's
 *    8.3/short form.
 */

export const REPLACEMENT_CHAR = '\uFFFD'

/** True when decoding produced replacement characters (lossy OEM output). */
export function hasReplacementChar(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes(REPLACEMENT_CHAR)
}

/**
 * File name of a Windows path, independent of the host platform, with the
 * `\??\` NT prefix and surrounding quotes removed.
 */
export function serviceImageBasename(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^\\\?\?\\/, '')
    .replace(/^"(.*)"$/, '$1')
  const parts = cleaned.split(/[\\/]+/)
  return (parts[parts.length - 1] ?? '').trim().toLowerCase()
}

/** Case-insensitive file-name comparison of two service image paths. */
export function sameServiceImagePath(registered: string, expected: string): boolean {
  const a = serviceImageBasename(registered)
  const b = serviceImageBasename(expected)
  return !!a && a === b
}
