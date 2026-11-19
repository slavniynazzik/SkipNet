import { describe, expect, it } from 'vitest'
import { deepMerge } from '@main/utils/merge'

type Tree = Record<string, unknown>

describe('deepMerge', () => {
  it('merges nested plain objects recursively', () => {
    const target: Tree = { a: { b: 1, c: 2 }, keep: true }

    deepMerge(target, { a: { c: 3 } })

    expect(target).toEqual({ a: { b: 1, c: 3 }, keep: true })
  })

  it('replaces a whole subtree when the key ends with a bang', () => {
    const target: Tree = { zapret: { enabled: true, strategy: 'old.bat' }, keep: 1 }

    deepMerge(target, { 'zapret!': { enabled: false } })

    expect(target).toEqual({ zapret: { enabled: false }, keep: 1 })
  })

  // BUG (pre-existing): the nested branch calls `deepMerge(target[k], other[k])`.
  // After `trimWrap` rewrites `<a>` to `a`, it reads `other.a` (undefined), so a
  // wrapped object key is silently dropped. The array branch below uses
  // `other[key]` and works. Task S6 should fix the lookup and this becomes a
  // plain `it`.
  it.fails('merges a wrapped <key> object subtree (currently a no-op)', () => {
    const target: Tree = { a: { x: 1 } }

    deepMerge(target, { '<a>': { y: 2 } })

    expect(target).toEqual({ a: { x: 1, y: 2 } })
  })

  it('replaces a subtree with the wrapped bang syntax <key>!', () => {
    const target: Tree = { a: { x: 1, y: 2 } }

    deepMerge(target, { '<a>!': { z: 3 } })

    expect(target).toEqual({ a: { z: 3 } })
  })

  it('strips angle brackets from array keys before replacing', () => {
    const target: Tree = { list: [1, 2] }

    deepMerge(target, { '<list>': [3, 4] })

    expect(target).toEqual({ list: [3, 4] })
  })

  it('replaces arrays instead of concatenating them', () => {
    const target: Tree = { a: { list: [1, 2, 3] } }

    deepMerge(target, { a: { list: [4] } })

    expect(target).toEqual({ a: { list: [4] } })
  })

  it('assigns null over an existing object', () => {
    const target: Tree = { a: { b: 1 } }

    deepMerge(target, { a: null })

    expect(target).toEqual({ a: null })
  })

  it('assigns null and undefined scalars as-is', () => {
    const target: Tree = { a: 1, b: 2 }

    deepMerge(target, { a: null, b: undefined })

    expect(target.a).toBeNull()
    expect('b' in target).toBe(true)
    expect(target.b).toBeUndefined()
  })

  it('returns the same target instance', () => {
    const target: Tree = { a: 1 }

    expect(deepMerge(target, { b: 2 })).toBe(target)
  })

  it('leaves the target untouched for an empty patch', () => {
    const target: Tree = { a: 1, nested: { b: 2 } }

    deepMerge(target, {})

    expect(target).toEqual({ a: 1, nested: { b: 2 } })
  })

  // SECURITY (S6 in REFACTOR_PLAN.md): today `deepMerge` walks `for..in` and
  // writes through whatever key it receives, so a `__proto__` /
  // `constructor.prototype` payload from parsed YAML/JSON pollutes
  // Object.prototype. After S6 adds an own-key + block-list guard this test
  // must be converted from `it.fails` to a plain `it`.
  it.fails('does not pollute Object.prototype via __proto__ / constructor.prototype (S6)', () => {
    const protoTarget: Tree = {}

    deepMerge(protoTarget, JSON.parse('{"__proto__":{"polluted":"yes"}}') as Tree)
    deepMerge(
      protoTarget,
      JSON.parse('{"constructor":{"prototype":{"pollutedCtor":"yes"}}}') as Tree
    )

    const leaked = ({} as Tree).polluted
    const leakedCtor = ({} as Tree).pollutedCtor

    // Clean up before asserting: an `it.fails` that never runs (e.g. after the
    // S6 fix) must not leak the pollution into other suites.
    delete (Object.prototype as Tree).polluted
    delete (Object.prototype as Tree).pollutedCtor

    expect(leaked).toBeUndefined()
    expect(leakedCtor).toBeUndefined()
  })
})
