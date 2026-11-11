/**
 * The bytes an EVM `sign()` signs under the EIP-191 prefix, as the policies measure them: a string
 * as its UTF-8 encoding, a `Uint8Array` as it is. The account behind `applyPolicies` is handed exactly
 * these bytes, so what was measured is what gets signed whatever encoder the runtime has: a
 * `TextEncoder` polyfill that reads a lone surrogate differently cannot change the length.
 */

/** The code point at `i` as `TextEncoder` reads it: a surrogate pair as one, a lone surrogate as U+FFFD. */
function codePoint(s: string, i: number): number {
  const c = s.charCodeAt(i)
  if (c < 0xd800 || c > 0xdfff) return c
  const lo = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0
  return lo >= 0xdc00 && lo <= 0xdfff ? 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00) : 0xfffd
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

/** UTF-8 as `TextEncoder` writes it (a lone surrogate → U+FFFD), without needing one (Hermes). */
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

/**
 * What an EVM `sign(message)` signs after the "\x19Ethereum Signed Message:\n<length>" prefix: a string as its
 * UTF-8 encoding, a `Uint8Array` as a plain copy of its own elements (a subclass's `length` getter or another
 * realm cannot make a signer read other bytes). Undefined for anything else — an array of numbers, another typed
 * array, an array-like: what a signer makes of those is not known (viem reads any array-like by index), so the
 * policies refuse them.
 */
export function evmMessageBytes(message: unknown): Uint8Array | undefined {
  if (typeof message === 'string') return utf8Bytes(message)
  return isUint8Array(message) ? new Uint8Array(message as Uint8Array) : undefined
}
