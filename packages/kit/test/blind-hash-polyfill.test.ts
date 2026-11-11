import { describe, expect, it, vi } from 'vitest'

// SDK-303 round 2 (D3). An EVM sign() behind the policies hands the account the caller's string, and an EIP-191
// signer signs it as UTF-8 with the runtime's TextEncoder (viem, in wallet-evm), while the policies measure it with
// their own encoder. On Hermes without a native TextEncoder the documented setup installs
// fastestsmallesttextencoderdecoder (EncoderDecoderTogether.min.js, 1.0.22). Read from its source, its encode():
//  - preallocates 2 × length + 8 bytes and grows (to 3 × length) only on a 3-byte character, testing the index
//    after a high surrogate has already advanced it;
//  - on a high surrogate it consumes the next code unit unconditionally: when that unit is not a low surrogate it
//    writes one U+FFFD for both (the WHATWG encoder writes U+FFFD and then encodes the unit);
//  - a lone high surrogate at the end is a U+FFFD for both, but when the bytes before it are exactly
//    2 × length + 6 the U+FFFD's last byte lands past the buffer and is dropped ('中' × 8 + U+D83E: 26, not 27);
//  - a lone low surrogate is U+FFFD in both.
// For a well-formed string every write stays inside the buffer (at most 2 bytes per code unit until a 3-byte
// character grows it) and each code point is encoded as the spec does: no difference. So the kit refuses a string
// with any lone surrogate (both kinds, to depend on no encoder's reading of them), and this file proves that for
// every string it does not refuse, polyfill bytes == spec bytes == the bytes the kit measured — and that each
// string the polyfill reads differently is one the kit refuses. The polyfill is installed as this runtime's
// TextEncoder before viem loads (viem builds its encoder at import), as on a Hermes app.

const { Native, Polyfill } = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const vm = await import('node:vm')
  const g = globalThis as { TextEncoder?: unknown; TextDecoder?: unknown }
  const source = readFileSync(createRequire(import.meta.url).resolve('fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'), 'utf8')
  const native = g.TextEncoder as typeof TextEncoder
  const decoder = g.TextDecoder
  // The polyfill installs itself only where there is no TextEncoder (RN's Hermes has one; the smoke deletes it too).
  delete g.TextEncoder
  vm.runInThisContext(source)
  g.TextDecoder = decoder
  return { Native: native, Polyfill: g.TextEncoder as typeof TextEncoder }
})

// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { evmSignMessage, loneSurrogateAt, utf8Bytes } from '../src/message-bytes.js'
import { PolicyViolationError, Wallet, type WriteIntent } from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:1'
const TREASURY = '0x1111111111111111111111111111111111111111'
/** The polyfill swallows the 'a': 32 bytes signed (EF BF BD + 29 × 'b') for 33 by the spec. */
const SWALLOW = `\uD83Ea${'b'.repeat(29)}`
/** The polyfill drops the U+FFFD's last byte: 32 bytes signed for 33 by the spec. */
const TRUNCATE = `aé${'中'.repeat(9)}\uD800`

const poly = new Polyfill()
const spec = new Native()
const same = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The property: either the kit refuses the string (it has a lone surrogate), or polyfill bytes == spec bytes ==
 * the bytes the kit measured, and the string is handed on as it came. Says whether the encoders disagree.
 */
function holds(s: string): { refused: boolean; disagree: boolean } {
  const read = evmSignMessage(s)
  const p = poly.encode(s)
  const n = spec.encode(s)
  const disagree = !same(p, n)
  if ('refused' in read) {
    if (loneSurrogateAt(s) < 0) throw new Error(`refused without a lone surrogate: ${JSON.stringify(s)}`)
    return { refused: true, disagree }
  }
  if (read.handed !== s) throw new Error(`not handed as it came: ${JSON.stringify(s)}`)
  if (disagree || !same(read.signed, n)) throw new Error(`accepted, but the bytes differ: ${JSON.stringify(s)} poly=${p.length} spec=${n.length} kit=${read.signed.length}`)
  return { refused: false, disagree }
}

/** xorshift32: a fixed sequence, so a failure names the same string every run. */
function rng(seed: number) {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x
  }
}

/** A code point of every width, noncharacters, U+FEFF, U+FFFD and the bounds included; never a surrogate. */
function scalar(next: () => number): number {
  const r = next() % 100
  if (r < 20) return next() % 0x80
  if (r < 40) return 0x80 + (next() % 0x780)
  if (r < 70) {
    const c = 0x800 + (next() % 0xf800)
    return c >= 0xd800 && c <= 0xdfff ? 0xfffd : c
  }
  if (r < 92) return 0x10000 + (next() % 0x100000)
  return [0, 0x7f, 0x80, 0x7ff, 0x800, 0xfeff, 0xfffd, 0xfffe, 0xffff, 0xfdd0, 0xfdef, 0x1fffe, 0x10000, 0x10ffff][next() % 14]!
}

describe('SDK-303 round 2: the Hermes TextEncoder polyfill, the spec and the kit agree on every string the kit signs', () => {
  it('this runtime\'s TextEncoder is the polyfill, and it reads the two lone-surrogate strings as 32 bytes', () => {
    expect(TextEncoder).toBe(Polyfill)
    expect(new TextEncoder().encode(SWALLOW)).toEqual(Uint8Array.from([0xef, 0xbf, 0xbd, ...new Array<number>(29).fill(0x62)]))
    expect(spec.encode(SWALLOW)).toHaveLength(33)
    expect(new TextEncoder().encode(TRUNCATE)).toHaveLength(32)
    expect(Array.from(new TextEncoder().encode(TRUNCATE).slice(-2))).toEqual([0xef, 0xbf])
    expect(spec.encode(TRUNCATE)).toHaveLength(33)
  })

  it('every Unicode scalar value, alone and at the buffer-growth edge: accepted, the same bytes in all three', () => {
    const grow = '中'.repeat(8)
    let n = 0
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      for (const s of [c, `${grow}${c}`, `aé${grow}é${c}`]) if (holds(s).refused) throw new Error(`refused: ${JSON.stringify(s)}`)
      n++
    }
    expect(n).toBe(0x110000 - 0x800)
  }, 120_000)

  it('every lone surrogate, alone, at the end, at the buffer edge, before every kind of unit: refused; the polyfill reads each lone high one there differently', () => {
    let disagreeing = 0
    for (let u = 0xd800; u <= 0xdfff; u++) {
      const c = String.fromCharCode(u)
      for (const s of [c, `a${c}`, `${'中'.repeat(8)}${c}`, `aé${'中'.repeat(9)}${c}`, `${c}a`, `${c}é`, `${c}中`, `${c}🦊`, `x${c}y`, `${c}�`]) {
        const r = holds(s)
        expect(r.refused, JSON.stringify(s)).toBe(true)
        if (r.disagree) disagreeing++
      }
    }
    // 1024 high surrogates × (2 at the buffer edge + 6 followed by a unit); a lone low surrogate is U+FFFD in both.
    expect(disagreeing).toBe(1024 * 8)
  })

  it('every sequence of up to 5 units over 15 kinds (lone surrogates included): accepted ones agree, every disagreement is refused', () => {
    const KINDS = ['a', '\u007f', '\u0080', 'é', '߿', 'ࠀ', '中', '﻿', '�', '￿', '﷐', '\uD800', '\uDBFF', '\uDC00', '\uDFFF']
    const counts = { accepted: 0, refused: 0, disagree: 0 }
    const walk = (s: string, depth: number) => {
      const r = holds(s)
      counts[r.refused ? 'refused' : 'accepted']++
      if (r.disagree) counts.disagree++
      if (depth > 0) for (const k of KINDS) walk(s + k, depth - 1)
    }
    walk('', 5)
    expect(counts.accepted + counts.refused).toBe((15 ** 6 - 1) / 14)
    expect(counts.disagree).toBeGreaterThan(0)
  }, 120_000)

  it('random strings: 100 000 well-formed (up to 300 code points), 100 000 of raw code units (a quarter of them surrogates)', () => {
    const next = rng(0x2545f491)
    for (let n = 0; n < 100_000; n++) {
      const len = next() % (n % 10 === 0 ? 300 : 40)
      let s = ''
      for (let i = 0; i < len; i++) s += String.fromCodePoint(scalar(next))
      if (holds(s).refused) throw new Error(`refused: ${JSON.stringify(s)}`)
    }
    let refused = 0
    for (let n = 0; n < 100_000; n++) {
      const len = next() % 40
      let s = ''
      for (let i = 0; i < len; i++) s += String.fromCharCode(next() % 4 === 0 ? 0xd800 + (next() % 0x800) : next() % 0x10000)
      if (holds(s).refused) refused++
    }
    expect(refused).toBeGreaterThan(50_000)
  }, 120_000)
})

describe('SDK-303 round 2: through the kit, wallet-evm signs with the polyfill', () => {
  const guardedEvm = async (policies: { allowlist?: Record<string, string[]>; confirm?: (i: WriteIntent) => Promise<boolean> }) => {
    const w = new Wallet(SEED, { policies })
    w.registerWallet(CHAIN, WalletManagerEvm as never, { chainId: 1 })
    return (await w.getAccount(CHAIN)) as unknown as { sign(m: string): Promise<string> }
  }

  it('unguarded, the polyfill signs both lone-surrogate strings as 32 bytes: the hidden hash the rule must not miss', async () => {
    const plain = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    for (const s of [SWALLOW, TRUNCATE]) {
      expect(poly.encode(s)).toHaveLength(32)
      expect(await plain.verify(poly.encode(s), await plain.sign(s))).toBe(true)
    }
  })

  it('guarded, both are refused (method) before any rule or confirm, with or without lists', async () => {
    for (const lists of [{}, { allowlist: { eip155: [TREASURY] } }]) {
      const confirm = vi.fn(async () => true)
      const guarded = await guardedEvm({ ...lists, confirm })
      for (const s of [SWALLOW, TRUNCATE]) {
        const err = await guarded.sign(s).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(PolicyViolationError)
        expect(err).toMatchObject({ policy: 'method', message: expect.stringMatching(/lone surrogate/) })
      }
      expect(confirm).not.toHaveBeenCalled()
    }
  })

  it('for strings the kit signs, the signature is over exactly the bytes it measured; 32 of them are a blind hash', async () => {
    const intents: WriteIntent[] = []
    const guarded = await guardedEvm({ confirm: async (i) => { intents.push(i); return true } })
    const plain = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    const next = rng(7)
    const strings = ['é'.repeat(16), '🦊'.repeat(8), `﻿${'a'.repeat(29)}`, `${'中'.repeat(8)}é${'a'.repeat(6)}`, `�${'￿'.repeat(9)}a\u{10FFFF}`]
    for (let n = 0; n < 120; n++) {
      // Half of them aimed at 32 bytes: code points added until the UTF-8 length reaches 32 or more.
      let s = ''
      const target = n % 2 === 0 ? 32 : next() % 80
      while (utf8Bytes(s).length < target) s += String.fromCodePoint(scalar(next))
      strings.push(s)
    }
    for (const s of strings) {
      const measured = utf8Bytes(s)
      // ECDSA here is deterministic (RFC 6979): the same signature means the same signed bytes.
      expect(await guarded.sign(s), JSON.stringify(s)).toBe(await plain.sign(measured))
      expect(intents.at(-1)!.blindHash === true, JSON.stringify(s)).toBe(measured.length === 32)
    }
    expect(intents.filter((i) => i.blindHashForm === 'text').length).toBeGreaterThan(20)
  }, 60_000)
})
