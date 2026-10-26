import { afterEach, describe, expect, it } from 'vitest'
import { installStructuredClone } from '../src/index.js'

// Audit 2026-10-25 round 3, L21: the Hermes structuredClone polyfill was a JSON round trip with a
// bigint marker: -5n came back as the string "-5n", the string "100n" came back as 100n, and
// Uint8Array / Date / Map / Set came back as plain objects or strings. It is now a real recursive
// clone of the structured-clone types the SDK passes around.

const g = globalThis as { structuredClone?: unknown }
const native = g.structuredClone
afterEach(() => { g.structuredClone = native })
const polyfilled = <T>(v: T): T => {
  delete g.structuredClone
  expect(installStructuredClone()).toBe('polyfilled')
  return (g.structuredClone as <U>(x: U) => U)(v)
}

describe('structuredClone polyfill', () => {
  it('bigints of either sign stay bigints; strings that look like bigints stay strings', () => {
    expect(polyfilled({ a: -5n, b: 0n, c: 2n ** 70n, s: '100n', t: '-5n' })).toEqual({ a: -5n, b: 0n, c: 2n ** 70n, s: '100n', t: '-5n' })
  })

  it('typed arrays, ArrayBuffer, DataView, Date, RegExp, Map, Set keep their types and are copies', () => {
    const bytes = Uint8Array.of(1, 2, 3)
    const words = new Uint32Array([7, 8])
    const buf = Uint8Array.of(9, 9).buffer
    const date = new Date(1_700_000_000_000)
    const map = new Map<unknown, unknown>([['k', 1n], [2, { x: Uint8Array.of(5) }]])
    const set = new Set([1, 'two', 3n])
    const src = { bytes, words, buf, view: new DataView(Uint8Array.of(4, 5, 6).buffer, 1, 2), date, re: /a+b/gi, map, set, nested: [bytes, { d: date }] }
    const out = polyfilled(src)
    expect(out.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(out.bytes)).toEqual([1, 2, 3])
    expect(out.bytes).not.toBe(bytes)
    expect(out.words).toBeInstanceOf(Uint32Array)
    expect(Array.from(out.words)).toEqual([7, 8])
    expect(out.buf).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(out.buf))).toEqual([9, 9])
    expect(out.view).toBeInstanceOf(DataView)
    expect([out.view.getUint8(0), out.view.getUint8(1)]).toEqual([5, 6])
    expect(out.date).toBeInstanceOf(Date)
    expect(out.date.getTime()).toBe(date.getTime())
    expect(out.date).not.toBe(date)
    expect(out.re).toBeInstanceOf(RegExp)
    expect([out.re.source, out.re.flags]).toEqual(['a+b', 'gi'])
    expect(out.map).toBeInstanceOf(Map)
    expect(out.map.get('k')).toBe(1n)
    expect(Array.from((out.map.get(2) as { x: Uint8Array }).x)).toEqual([5])
    expect(out.set).toBeInstanceOf(Set)
    expect([...out.set]).toEqual([1, 'two', 3n])
    bytes[0] = 99
    expect(out.bytes[0]).toBe(1)
  })

  it('cycles and shared references survive; undefined, null, NaN and -0 too', () => {
    const shared = { v: 1 }
    const a: Record<string, unknown> = { shared, again: shared, u: undefined, n: null, nan: Number.NaN, z: -0 }
    a.self = a
    const out = polyfilled(a)
    expect(out.self).toBe(out)
    expect(out.again).toBe(out.shared)
    expect(out.shared).not.toBe(shared)
    expect('u' in out && out.u === undefined).toBe(true)
    expect(out.n).toBeNull()
    expect(Number.isNaN(out.nan)).toBe(true)
    expect(Object.is(out.z, -0)).toBe(true)
  })

  it('functions and symbols are refused like the native one (DataCloneError)', () => {
    expect(() => polyfilled({ f: () => 1 })).toThrow(/could not be cloned/)
    expect(() => polyfilled(Symbol('s'))).toThrow(/could not be cloned/)
  })
})
