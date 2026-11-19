/**
 * Prototype-pollution-safe deep merge used by the config layer.
 *
 * Untrusted YAML/JSON (persisted config, IPC patches) must never be able to
 * write through `__proto__`, `constructor` or `prototype`, and inherited
 * properties must not be merged at all. Only own enumerable keys are
 * considered, only plain objects are merged recursively, and recursion is
 * bounded.
 */

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 32

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPlainObject(item: any): item is Record<string, unknown> {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
  const proto = Object.getPrototypeOf(item)
  return proto === Object.prototype || proto === null
}

function trimWrap(str: string): string {
  if (str.startsWith('<') && str.endsWith('>')) {
    return str.slice(1, -1)
  }
  return str
}

/** `<key>!` and `key!` both mean "replace this subtree entirely". */
function normalizeKey(rawKey: string): { key: string; replace: boolean } {
  const replace = rawKey.endsWith('!')
  const base = replace ? rawKey.slice(0, -1) : rawKey
  return { key: trimWrap(base), replace }
}

function mergeInto(
  target: Record<string, unknown>,
  source: object,
  depth: number
): void {
  if (depth >= MAX_DEPTH) return

  for (const rawKey of Object.keys(source)) {
    const { key, replace } = normalizeKey(rawKey)
    if (!key || BLOCKED_KEYS.has(key)) continue

    // Always read the value with the *original* own key. The old code
    // trimmed `<...>` first and then read `other[k]`, which silently dropped
    // wrapped object keys.
    const value = (source as Record<string, unknown>)[rawKey]

    if (replace) {
      target[key] = value
      continue
    }

    if (isPlainObject(value)) {
      const current = target[key]
      if (!isPlainObject(current)) target[key] = {}
      mergeInto(target[key] as Record<string, unknown>, value, depth + 1)
      continue
    }

    if (Array.isArray(value)) {
      // Arrays are replaced, never merged element-wise.
      target[key] = value
      continue
    }

    target[key] = value
  }
}

export function deepMerge<T extends object>(target: T, other: Partial<T>): T {
  if (!isPlainObject(target) || other === null || typeof other !== 'object') {
    return target
  }
  mergeInto(target, other, 0)
  return target as T
}
