import { describe, expect, it } from 'vitest'
import { canonicalJson, fromB64u, toB64u } from '../src/encoding.js'

describe('encoding', () => {
  it('base64url round-trips every length and matches Node', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      const text = toB64u(bytes)
      expect(text).toBe(Buffer.from(bytes).toString('base64url'))
      expect(fromB64u(text)).toEqual(bytes)
    }
  })

  it('is strict: bad characters, padding, impossible lengths and non-zero tail bits fail', () => {
    for (const bad of ['A', 'AA=A', 'AB+/', 'A$AA', 'AB', 'AAB']) expect(fromB64u(bad)).toBeNull()
    expect(fromB64u('AA')).toEqual(new Uint8Array([0]))
  })

  it('sorts keys deterministically and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  })
})
