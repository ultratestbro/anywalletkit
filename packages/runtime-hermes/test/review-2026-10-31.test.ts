import { afterEach, describe, expect, it } from 'vitest'
import { installStructuredClone } from '../src/index.js'

// The structuredClone polyfill keeps an own "__proto__" key (JSON.parse makes one) as an own data
// property, as the native structuredClone does, instead of making it the clone's prototype.

const g = globalThis as { structuredClone?: unknown }
const native = g.structuredClone as <T>(v: T) => T
afterEach(() => { g.structuredClone = native })
const polyfilled = <T>(v: T): T => {
  delete g.structuredClone
  expect(installStructuredClone()).toBe('polyfilled')
  return (g.structuredClone as <U>(x: U) => U)(v)
}

describe('structuredClone polyfill: own "__proto__" key', () => {
  it('stays an own data property, as in the native clone; no prototype is set; Object.prototype is untouched', () => {
    const src = JSON.parse('{"a":1,"__proto__":{"isAdmin":true,"allowCrossChainTypedData":true}}') as Record<string, unknown>
    const ref = native(src) as Record<string, unknown>
    const out = polyfilled(src)
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
    expect(Object.keys(out)).toEqual(Object.keys(ref))
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(out.isAdmin).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ isAdmin: true, allowCrossChainTypedData: true })
  })

  it('nested and in arrays too', () => {
    const src = JSON.parse('{"x":[{"__proto__":{"evil":1}}],"y":{"__proto__":{"evil":2}}}') as { x: object[]; y: object }
    const out = polyfilled(src)
    expect(Object.getPrototypeOf(out.x[0])).toBe(Object.prototype)
    expect(Object.getPrototypeOf(out.y)).toBe(Object.prototype)
    expect((out.y as { evil?: unknown }).evil).toBeUndefined()
  })

  it('control: cycles and shared references are kept, plain keys copied', () => {
    const shared = { n: 1n }
    const src: Record<string, unknown> = { a: shared, b: shared, s: 'x' }
    src.self = src
    const out = polyfilled(src) as typeof src
    expect(out.self).toBe(out)
    expect(out.a).toBe(out.b)
    expect(out.a).not.toBe(shared)
    expect(out).toMatchObject({ s: 'x', a: { n: 1n } })
  })
})
