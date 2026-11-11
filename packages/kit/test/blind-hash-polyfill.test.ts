import { describe, expect, it, vi } from 'vitest'

// SDK-303 review: an app on a runtime without a native TextEncoder installs a polyfill (the Hermes setup in the docs
// uses fastestsmallesttextencoderdecoder). That one reads a lone high surrogate together with the next code unit, so
// '\uD83E' + 'a' + 29 × 'b' — 33 bytes by the spec, a plain message to the policies — was signed by viem as 32 bytes
// (EF BF BD + 29 × 'b'): a hidden hash past the rule. The account is now handed the bytes the policies measured, so its
// encoder never runs. The stub is installed before viem loads (it builds its TextEncoder at import).
vi.hoisted(() => {
  /** UTF-8 like that polyfill: a lone high surrogate takes the next code unit with it into one U+FFFD. */
  class SwallowingEncoder {
    readonly encoding = 'utf-8'
    encode(s = ''): Uint8Array {
      const out: number[] = []
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
          const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
          i++
          c = lo >= 0xdc00 && lo <= 0xdfff ? 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00) : 0xfffd
        } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd
        if (c < 0x80) out.push(c)
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      }
      return Uint8Array.from(out)
    }
  }
  ;(globalThis as { TextEncoder: unknown }).TextEncoder = SwallowingEncoder
})

// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { utf8Bytes } from '../src/message-bytes.js'
import { Wallet, type WriteIntent } from '../src/index.js'

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:1'
const TREASURY = '0x1111111111111111111111111111111111111111'
const TRICK = `\uD83Ea${'b'.repeat(29)}`
const SWALLOWED = Uint8Array.from([0xef, 0xbf, 0xbd, ...new Array<number>(29).fill(0x62)])

describe('SDK-303 review: a TextEncoder polyfill that miscounts cannot shrink a message to 32 signed bytes', () => {
  it('this runtime\'s encoder is the miscounting one (the kit\'s own is not)', () => {
    expect(new TextEncoder().encode(TRICK)).toEqual(SWALLOWED)
    expect(utf8Bytes(TRICK).length).toBe(33)
  })

  it('unguarded wallet-evm signs the 32 swallowed bytes; through the kit the 33 measured ones, under an allowlist', async () => {
    const plain = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    // What the bypass was: the string signed by viem's encoder is the 32-byte hidden hash.
    expect(await plain.verify(SWALLOWED, await plain.sign(TRICK))).toBe(true)

    const intents: WriteIntent[] = []
    const w = new Wallet(SEED, { policies: { allowlist: { eip155: [TREASURY] }, confirm: async (i) => { intents.push(i); return true } } })
    w.registerWallet(CHAIN, WalletManagerEvm as never, { chainId: 1 })
    const guarded = (await w.getAccount(CHAIN)) as unknown as { sign(m: string): Promise<string> }
    const signature = await guarded.sign(TRICK)
    expect(intents[0]).toMatchObject({ kind: 'message' })
    expect(await plain.verify(utf8Bytes(TRICK), signature)).toBe(true)
    expect(await plain.verify(SWALLOWED, signature)).toBe(false)
  })
})
