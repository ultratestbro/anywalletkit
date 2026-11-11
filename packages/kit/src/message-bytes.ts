/**
 * The bytes an EVM `sign()` signs under the EIP-191 prefix, as the policies measure them: a string
 * as its UTF-8 encoding (wallet-evm `sign` hands a string to viem's `hashMessage`, which encodes it
 * with `TextEncoder`; ethers does the same), a `Uint8Array` as it is.
 */

/** UTF-8 as `TextEncoder` writes it (a lone surrogate → U+FFFD), without needing one (Hermes). */
export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdfff) {
      const lo = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
      } else c = 0xfffd
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return Uint8Array.from(out)
}

/** What an EVM `sign(message)` signs after the "\x19Ethereum Signed Message:\n<length>" prefix; undefined for any other argument. */
export function evmMessageBytes(message: unknown): Uint8Array | undefined {
  if (message instanceof Uint8Array) return message
  return typeof message === 'string' ? utf8Bytes(message) : undefined
}
