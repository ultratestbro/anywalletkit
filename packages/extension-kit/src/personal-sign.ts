/**
 * What a `personal_sign` signs, in one place: the signer input `createSignHandler` passes and the
 * bytes `classifySignRequest` measures for the 32-byte (blind hash) check come from the same
 * conversion, so the check never reads a different message than the one signed.
 *
 * `0x` + an even number of hex digits is handed to the signer as those bytes; any other string as the
 * string, which an EIP-191 signer (viem `signMessage`, ethers, wallet-evm `sign`) signs as its UTF-8
 * encoding — a lone surrogate as U+FFFD, a BOM as its three bytes, as `TextEncoder` does.
 */

/** `0x` + an even number of hex digits: a message given as bytes. */
export const HEX = /^0x([0-9a-fA-F]{2})*$/

/**
 * The longest message that can be 32 signed bytes: `0x` + 64 hex. Text needs at most 32 UTF-16 units for 32
 * UTF-8 bytes (every unit is at least one byte), so anything longer is measured without being encoded.
 */
export const BLIND_HASH_MAX_CHARS = 66

const hexBytes = (value: string): Uint8Array => Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16))

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

/** UTF-8 as `TextEncoder` writes it (a lone surrogate → U+FFFD), without needing one. */
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

/** What the signer is handed for a personal_sign message: hex as bytes, anything else as the string. */
export function personalSignInput(message: string): string | Uint8Array {
  return HEX.test(message) ? hexBytes(message) : message
}

/** The bytes a personal_sign of `message` signs (after the EIP-191 "\x19Ethereum Signed Message:\n<length>" prefix). */
export function personalSignBytes(message: string): Uint8Array {
  const input = personalSignInput(message)
  return typeof input === 'string' ? utf8Bytes(input) : input
}
