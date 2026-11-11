import { describe, expect, it, vi } from 'vitest'

// SDK-303 review: the 32-byte check encoded every personal_sign message as UTF-8 — a number[] per byte, then a copy —
// where the old check only ran a regex. Any connected site could send a message of tens of megabytes (under Chrome's
// 64 MiB message cap) and make the service worker allocate gigabytes. Only a message of at most 66 characters
// (0x + 64 hex; text of 32 bytes is at most 32 UTF-16 units) can be 32 signed bytes, so only such a one is encoded.
const spy = vi.hoisted(() => ({ encoded: [] as number[] }))
vi.mock('../src/personal-sign.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/personal-sign.js')>()
  return { ...real, personalSignBytes: (m: string) => { spy.encoded.push(m.length); return real.personalSignBytes(m) } }
})

import { DEFAULT_NETWORKS, classifySignRequest } from '../src/index.js'
import { BLIND_HASH_MAX_CHARS, utf8Bytes, utf8Length } from '../src/personal-sign.js'

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const classify = (msg: string) => classifySignRequest({ network: DEFAULT_NETWORKS[0]!, method: 'personal_sign', params: [msg, ME], accounts: [ME], origin: 'https://swap.example' })

describe('SDK-303 review: a long personal_sign message is never encoded for the 32-byte check', () => {
  it('8 million two-byte letters: a normal message, nothing encoded', () => {
    spy.encoded.length = 0
    const huge = 'é'.repeat(8_000_000)
    const info = classify(huge)
    expect(info).toMatchObject({ kind: 'sign-message', raw: huge })
    expect(info).not.toHaveProperty('blindHash')
    expect(spy.encoded).toEqual([])
  })

  it('the bound is exact: 66 characters are measured (the hex form), 67 are not; 32 bytes of text are flagged', () => {
    spy.encoded.length = 0
    const hex = `0x${'ab'.repeat(32)}`
    expect(hex.length).toBe(BLIND_HASH_MAX_CHARS)
    classify(hex)
    classify(`${hex}a`)
    classify('a'.repeat(67))
    expect(spy.encoded).toEqual([66])
    expect(classify('é'.repeat(16))).toMatchObject({ blindHash: true, blindHashForm: 'text' })
  })

  it('utf8Length counts what utf8Bytes writes, and both match TextEncoder (random code units, lone surrogates)', () => {
    let seed = 11
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
    for (let n = 0; n < 2000; n++) {
      const s = String.fromCharCode(...Array.from({ length: next() % 24 }, () => (next() % 4 === 0 ? 0xd800 + (next() % 0x800) : next() % 0x10000)))
      const native = new TextEncoder().encode(s)
      expect(utf8Length(s), JSON.stringify(s)).toBe(native.length)
      expect(Array.from(utf8Bytes(s)), JSON.stringify(s)).toEqual(Array.from(native))
    }
  })
})
