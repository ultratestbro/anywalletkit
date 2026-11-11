/**
 * What an EVM `sign()` behind the policies signs, and what they measure of it for the blind hash rule.
 *
 * The account is handed what the caller gave: a string as that string (an external signer shows it as
 * text), a `Uint8Array` as a plain copy of its bytes. An EIP-191 signer signs a string as its UTF-8
 * encoding — wallet-evm through viem and the runtime's `TextEncoder` — and the policies measure that
 * encoding with their own encoder ({@link utf8Bytes}, the WHATWG algorithm). The two agree on every
 * well-formed string. They can disagree only on a lone surrogate: the `TextEncoder` polyfill the Hermes
 * setup installs (fastestsmallesttextencoderdecoder 1.0.22) swallows the code unit after a lone high
 * surrogate into its U+FFFD, and drops the last byte of a U+FFFD for a lone high surrogate that ends the
 * string at the edge of its output buffer. So a string with a lone surrogate is refused before any rule
 * ({@link evmSignMessage}).
 */

/** The code point at `i` as `TextEncoder` reads it: a surrogate pair as one, a lone surrogate as U+FFFD. */
function codePoint(s: string, i: number): number {
  const c = s.charCodeAt(i)
  if (c < 0xd800 || c > 0xdfff) return c
  const lo = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0
  return lo >= 0xdc00 && lo <= 0xdfff ? 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00) : 0xfffd
}

/** The index of the first lone surrogate in `s` (a UTF-16 unit U+D800–U+DFFF that is not half of a pair), or -1. */
export function loneSurrogateAt(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0xd800 || c > 0xdfff) continue
    if (c > 0xdbff) return i
    const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
    if (lo < 0xdc00 || lo > 0xdfff) return i
    i++
  }
  return -1
}

/** The length of {@link utf8Bytes}, counted without encoding. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = codePoint(s, i)
    if (c > 0xffff) {
      n += 4
      i++
    } else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}

/** UTF-8 as the WHATWG `TextEncoder` writes it (a lone surrogate → U+FFFD), without needing one (Hermes). */
export function utf8Bytes(s: string): Uint8Array {
  const out = new Uint8Array(utf8Length(s))
  let o = 0
  for (let i = 0; i < s.length; i++) {
    const c = codePoint(s, i)
    if (c < 0x80) out[o++] = c
    else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6)
      out[o++] = 0x80 | (c & 0x3f)
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12)
      out[o++] = 0x80 | ((c >> 6) & 0x3f)
      out[o++] = 0x80 | (c & 0x3f)
    } else {
      out[o++] = 0xf0 | (c >> 18)
      out[o++] = 0x80 | ((c >> 12) & 0x3f)
      out[o++] = 0x80 | ((c >> 6) & 0x3f)
      out[o++] = 0x80 | (c & 0x3f)
      i++
    }
  }
  return out
}

/** `%TypedArray%.prototype[Symbol.toStringTag]`: the kind of a typed array from any realm (an own `Symbol.toStringTag` cannot fake it), undefined for anything else. */
const TYPED_ARRAY_NAME = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, Symbol.toStringTag)?.get

/** A `Uint8Array` (a Node `Buffer` too), also one made in another realm (an iframe, `vm`, a test DOM). */
function isUint8Array(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  return TYPED_ARRAY_NAME ? TYPED_ARRAY_NAME.call(v) === 'Uint8Array' : v instanceof Uint8Array
}

/** An EVM `sign(message)` argument the policies can read. */
export interface EvmSignMessage {
  /** The bytes signed after the "\x19Ethereum Signed Message:\n<length>" prefix: a string's UTF-8, a `Uint8Array`'s elements. */
  signed: Uint8Array
  /** What the account is handed: the caller's string itself, or a plain copy of the bytes (`signed`). */
  handed: string | Uint8Array
}

/**
 * An EVM `sign(message)` argument, read: a well-formed string, signed as its UTF-8 and handed as it is; a
 * `Uint8Array` (from any realm, a subclass, a `Buffer`), signed and handed as a plain copy of its own elements,
 * so a `length` getter or another realm cannot make a signer read other bytes. Anything else is refused with
 * the reason: an array of numbers, another typed array, an array-like (what a signer makes of those is not
 * known: viem reads any array-like by index), and a string with a lone surrogate (UTF-8 encoders disagree on it).
 */
export function evmSignMessage(message: unknown): EvmSignMessage | { refused: string } {
  if (typeof message === 'string') {
    const at = loneSurrogateAt(message)
    if (at >= 0) {
      const unit = message.charCodeAt(at).toString(16).toUpperCase()
      return { refused: `An EVM sign() of text with a lone surrogate (U+${unit} at index ${at}) is refused: UTF-8 encoders disagree on it, so the bytes signed could differ from the bytes the policies measured; nothing was signed.` }
    }
    return { signed: utf8Bytes(message), handed: message }
  }
  if (!isUint8Array(message)) return { refused: 'An EVM sign() takes a string or a Uint8Array; the policies cannot tell what this argument would sign, so nothing was signed.' }
  const bytes = new Uint8Array(message as Uint8Array)
  return { signed: bytes, handed: bytes }
}
