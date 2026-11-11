/**
 * SDK-303: an EVM `sign()` behind the kit's policies hands the signer the caller's string and measures its UTF-8
 * with the kit's own encoder, while viem signs it through the runtime's `TextEncoder`. Under Hermes that is the
 * polyfill this smoke installs (fastestsmallesttextencoderdecoder: an app without a native TextEncoder) or React
 * Native's own. For every string the kit accepts both write exactly the kit's bytes; the strings the polyfill
 * reads differently (a lone surrogate) are the ones the kit refuses. Seeded, so a failure names the same string.
 */
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
// The kit's encoder itself, from its source: it has no imports (the smoke does not depend on the kit package).
import { evmSignMessage, utf8Bytes } from '../../packages/kit/src/message-bytes.js'
import { hermesTextEncoder } from './shim-globals.js'

type Encoder = { encode(s: string): Uint8Array }

const same = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** xorshift32. */
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

/** A code point of every width (noncharacters, U+FEFF, U+FFFD and the bounds included), never a surrogate. */
function scalar(next: () => number): number {
  const r = next() % 100
  if (r < 20) return next() % 0x80
  if (r < 40) return 0x80 + (next() % 0x780)
  if (r < 70) {
    const c = 0x800 + (next() % 0xf800)
    return c >= 0xd800 && c <= 0xdfff ? 0xfffd : c
  }
  if (r < 92) return 0x10000 + (next() % 0x100000)
  return [0, 0x7f, 0x80, 0x7ff, 0x800, 0xfeff, 0xfffd, 0xfffe, 0xffff, 0xfdd0, 0x1fffe, 0x10000, 0x10ffff][next() % 13]!
}

export async function smokeUtf8(check: (what: string, ok: boolean, detail?: string) => void): Promise<void> {
  const encoders: Array<[string, Encoder]> = [['polyfill', new TextEncoder()]]
  if (hermesTextEncoder) encoders.push(['Hermes TextEncoder', new hermesTextEncoder()])
  check('utf8: the global TextEncoder is the polyfill', hermesTextEncoder === undefined || (TextEncoder as unknown) !== hermesTextEncoder)

  // Well-formed strings: every BMP scalar value and every 61st supplementary one, alone and at the polyfill's
  // buffer-growth edge (8 three-byte characters before it), and 3000 random strings of up to 120 code points.
  const wellFormed: string[] = []
  for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x10000 ? 1 : 61) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const c = String.fromCodePoint(cp)
    wellFormed.push(c, `${'中'.repeat(8)}${c}`, `aé${'中'.repeat(8)}é${c}`)
  }
  wellFormed.push(String.fromCodePoint(0x10ffff))
  const next = rng(0x2545f491)
  for (let n = 0; n < 3000; n++) {
    let s = ''
    const len = next() % 120
    for (let i = 0; i < len; i++) s += String.fromCodePoint(scalar(next))
    wellFormed.push(s)
  }
  let refused = ''
  for (const s of wellFormed) if (!refused && 'refused' in evmSignMessage(s)) refused = JSON.stringify(s)
  check('utf8: the kit accepts every well-formed string', refused === '', refused)
  for (const [name, e] of encoders) {
    let bad = ''
    for (const s of wellFormed) if (!same(e.encode(s), utf8Bytes(s))) { bad = JSON.stringify(s); break }
    check(`utf8: ${name} writes the kit's bytes for ${wellFormed.length} well-formed strings`, bad === '', bad)
  }

  // Lone surrogates, alone, at the end, at the buffer edge and before each kind of unit: all refused by the kit;
  // the polyfill reads each lone high one at the edge or before a unit differently, React Native's encoder none.
  const lone: string[] = []
  for (let u = 0xd800; u <= 0xdfff; u++) {
    const c = String.fromCharCode(u)
    lone.push(c, `a${c}`, `${'中'.repeat(8)}${c}`, `aé${'中'.repeat(9)}${c}`, `${c}a`, `${c}é`, `${c}中`, `${c}🦊`, `x${c}y`, `${c}�`)
  }
  check('utf8: the kit refuses every string with a lone surrogate', lone.every((s) => 'refused' in evmSignMessage(s)))
  for (const [name, e] of encoders) {
    const differ = lone.filter((s) => !same(e.encode(s), utf8Bytes(s))).length
    check(`utf8: ${name} differs on ${differ} of ${lone.length} lone-surrogate strings`, differ === (name === 'polyfill' ? 1024 * 8 : 0), String(differ))
  }

  // viem under Hermes: a string signed as text is the signature over the kit's bytes; a lone-surrogate string
  // is signed over the polyfill's bytes — 32 of them for 33 measured, why the kit refuses it.
  const account = await new WalletManagerEvm('test test test test test test test test test test test junk', { chainId: 1 }).getAccount(0)
  let mismatch = ''
  for (let n = 0; n < 24 && !mismatch; n++) {
    let s = ''
    const target = n % 2 === 0 ? 32 : 1 + (next() % 60)
    while (utf8Bytes(s).length < target) s += String.fromCodePoint(scalar(next))
    if ((await account.sign(s)) !== (await account.sign(utf8Bytes(s)))) mismatch = JSON.stringify(s)
  }
  check('utf8: wallet-evm signs a string over the kit-measured bytes', mismatch === '', mismatch)
  const swallow = `\uD83Ea${'b'.repeat(29)}`
  const polyBytes = new TextEncoder().encode(swallow)
  check('utf8: the polyfill signs a lone-surrogate string as other bytes', polyBytes.length === 32 && utf8Bytes(swallow).length === 33 && (await account.sign(swallow)) === (await account.sign(polyBytes)))
  account.dispose()
}
