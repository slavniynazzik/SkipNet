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

  // The nested branch used to read `other[trimWrap(key)]` after rewriting the
  // key, so a wrapped object key was silently dropped. S6 fixed the lookup.
  it('merges a wrapped <key> object subtree', () => {
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

  // SECURITY (S6 in REFACTOR_PLAN.md): `deepMerge` walks own keys only and
  // refuses `__proto__` / `constructor` / `prototype`, so a payload from parsed
  // YAML/JSON can no longer pollute Object.prototype.
  it('does not pollute Object.prototype via __proto__ / constructor.prototype (S6)', () => {
    const protoTarget: Tree = {}

    deepMerge(protoTarget, JSON.parse('{"__proto__":{"polluted":"yes"}}') as Tree)
    deepMerge(
      protoTarget,
      JSON.parse('{"constructor":{"prototype":{"pollutedCtor":"yes"}}}') as Tree
    )

    const leaked = ({} as Tree).polluted
    const leakedCtor = ({} as Tree).pollutedCtor

    // Clean up before asserting in case a regression leaks again.
    delete (Object.prototype as Tree).polluted
    delete (Object.prototype as Tree).pollutedCtor

    expect(leaked).toBeUndefined()
    expect(leakedCtor).toBeUndefined()
    expect(protoTarget).toEqual({})
  })

  it('also blocks wrapped and bang-suffixed prototype keys', () => {
    const target: Tree = {}

    deepMerge(target, JSON.parse('{"<__proto__>":{"polluted":"yes"}}') as Tree)
    deepMerge(target, JSON.parse('{"constructor!":{"prototype":{"polluted":"yes"}}}') as Tree)
    deepMerge(target, JSON.parse('{"<prototype>":{"polluted":"yes"}}') as Tree)

    expect(({} as Tree).polluted).toBeUndefined()
    expect(target).toEqual({})
  })

  it('ignores inherited (non-own) keys', () => {
    const inherited: Tree = { inherited: 'nope' }
    const patch = Object.create(inherited) as Tree
    patch.own = 'yes'
    const target: Tree = {}

    deepMerge(target, patch)

    expect(target).toEqual({ own: 'yes' })
  })

  it('merges only plain objects, assigning class instances as-is', () => {
    class Box {
      value = 1
    }
    const instance = new Box()
    const target: Tree = {}

    deepMerge(target, { box: instance } as Tree)

    expect(target.box).toBe(instance)
  })

  it('accepts null-prototype objects as mergeable plain objects', () => {
    const child = Object.create(null) as Tree
    child.b = 2
    const target: Tree = { a: { x: 1 } }

    deepMerge(target, { a: child } as Tree)

    expect(target).toEqual({ a: { x: 1, b: 2 } })
  })

  it('stops at the depth cap instead of recursing without bound', () => {
    const target: Tree = {}
    const root: Tree = {}
    let cursor = root
    for (let i = 0; i < 48; i++) {
      const next: Tree = {}
      cursor.next = next
      cursor = next
    }
    cursor.marker = 'deep'

    expect(() => deepMerge(target, root)).not.toThrow()

    // Levels beyond the cap are not merged, so the marker never lands.
    let node: Tree | undefined = target
    for (let i = 0; i < 48 && node; i++) node = node.next as Tree | undefined
    expect(node).toBeUndefined()
    expect(Object.keys(target)).toEqual(['next'])
  })
})
