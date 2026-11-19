/**
 * Single SemVer-aware version comparator shared by the app, Zapret, TgWsProxy
 * updaters and the hosts catalog.
 *
 * Rules (SemVer 2.0 precedence, tolerant input):
 *  - an optional leading `v` / `V` is ignored;
 *  - build metadata (`+sha.123`) never affects ordering;
 *  - numeric release segments compare numerically (`1.10.0 > 1.9.9`);
 *  - a prerelease sorts below the matching release (`2.0.0-rc.1 < 2.0.0`);
 *  - prerelease identifiers compare dot-by-dot: numeric below alphanumeric,
 *    numeric numerically, alphanumeric by ASCII order; a prefix sorts lower
 *    (`1.0.0-alpha < 1.0.0-alpha.1`);
 *  - malformed input sorts below a valid version and compares equal to itself.
 *
 * Returns -1, 0 or 1 so callers can keep their existing `> 0` / `< 0` checks.
 */

interface ParsedVersion {
  release: number[]
  prerelease: string[]
}

const RELEASE_RE = /^\d+(?:\.\d+)*$/
const NUMERIC_RE = /^\d+$/

/** Parse a version string, or return null when it has no numeric core. */
export function parseSemver(value: string): ParsedVersion | null {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (!text) return null
  if (text.startsWith('v') || text.startsWith('V')) text = text.slice(1)

  // Build metadata is explicitly ignored by SemVer precedence.
  const plus = text.indexOf('+')
  if (plus >= 0) text = text.slice(0, plus)

  const dash = text.indexOf('-')
  const core = dash >= 0 ? text.slice(0, dash) : text
  const pre = dash >= 0 ? text.slice(dash + 1) : ''

  if (!RELEASE_RE.test(core)) return null
  const release = core.split('.').map((part) => Number.parseInt(part, 10))
  const prerelease = pre ? pre.split('.') : []
  // `1.0.0-` / `1.0.0-alpha..1` are malformed rather than silently accepted.
  if (prerelease.some((identifier) => identifier.length === 0)) return null

  return { release, prerelease }
}

function compareRelease(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}

function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease means the final release: it outranks every prerelease.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i]
    const bv = b[i]
    // A shorter identifier list has lower precedence.
    if (av === undefined) return -1
    if (bv === undefined) return 1

    const aNumeric = NUMERIC_RE.test(av)
    const bNumeric = NUMERIC_RE.test(bv)
    if (aNumeric && bNumeric) {
      const an = Number.parseInt(av, 10)
      const bn = Number.parseInt(bv, 10)
      if (an !== bn) return an > bn ? 1 : -1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric.
    if (aNumeric) return -1
    if (bNumeric) return 1
    if (av !== bv) return av > bv ? 1 : -1
  }
  return 0
}

export function compareVersion(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)

  if (!pa && !pb) {
    const left = typeof a === 'string' ? a.trim() : String(a)
    const right = typeof b === 'string' ? b.trim() : String(b)
    if (left === right) return 0
    return left > right ? 1 : -1
  }
  // Fail closed: an unparseable version is treated as older than any valid one.
  if (!pa) return -1
  if (!pb) return 1

  const release = compareRelease(pa.release, pb.release)
  if (release !== 0) return release
  return comparePrerelease(pa.prerelease, pb.prerelease)
}
