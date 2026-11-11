/**
 * Parsing/validation helpers shared by the Zapret list editor and the
 * upstream list updater.
 *
 * Zapret hostlists accept plain domains, wildcards (`*.example.com`),
 * IPv4/IPv6 addresses and CIDR ranges. Blank lines and comment lines
 * (`#`, `;`) are ignored by winws and preserved by the editor.
 */

const IPV4_CIDR =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/(?:[0-9]|[12]\d|3[0-2]))?$/
const IPV6_CIDR = /^(?:[A-Fa-f0-9:]+:+)+[A-Fa-f0-9]*(?:\/(?:1[0-1]\d|12[0-8]|\d{1,2}))?$/
// Hostname / FQDN: labels of [a-z0-9-], 1–63 chars, joined by dots.
// Zapret also accepts an optional `^` prefix (match this host only, no
// subdomains) and the editor historically allowed a leading wildcard.
// Total length ≤253.
const HOSTNAME =
  /^\^?\*?\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/i

export function isListComment(line: string): boolean {
  const v = line.trim()
  return !v || v.startsWith('#') || v.startsWith(';')
}

/** True for an IPv4/IPv6 address or CIDR range. */
export function isValidCidrEntry(line: string): boolean {
  const v = line.trim()
  if (isListComment(v)) return false
  return IPV4_CIDR.test(v) || IPV6_CIDR.test(v)
}

/** True for a hostname, wildcard hostname, IP address or CIDR range. */
export function isValidListEntry(line: string): boolean {
  const v = line.trim()
  if (isListComment(v) || v.length > 253) return false
  if (IPV4_CIDR.test(v) || IPV6_CIDR.test(v)) return true
  return HOSTNAME.test(v)
}

/**
 * Normalise a downloaded list: trim, drop invalid/duplicate entries, keep
 * comments, and return CRLF text plus the number of real entries.
 */
export function normalizeListContent(
  raw: string,
  validate: (line: string) => boolean
): { content: string; entries: number } {
  const out: string[] = []
  const seen = new Set<string>()
  let entries = 0

  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    if (isListComment(value)) {
      out.push(value)
      continue
    }
    if (!validate(value)) continue
    // Hostnames are case-insensitive; lowercasing also gives CIDR/IPv6 a
    // stable dedup key without changing their meaning.
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    entries++
  }

  return {
    content: out.length ? `${out.join('\r\n')}\r\n` : '',
    entries
  }
}
