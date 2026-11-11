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

const hexBytes = (value: string): Uint8Array => Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16))

/** UTF-8 as `TextEncoder` writes it (a lone surrogate → U+FFFD), without needing one. */
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

/** What the signer is handed for a personal_sign message: hex as bytes, anything else as the string. */
export function personalSignInput(message: string): string | Uint8Array {
  return HEX.test(message) ? hexBytes(message) : message
}

/** The bytes a personal_sign of `message` signs (after the EIP-191 "\x19Ethereum Signed Message:\n<length>" prefix). */
export function personalSignBytes(message: string): Uint8Array {
  const input = personalSignInput(message)
  return typeof input === 'string' ? utf8Bytes(input) : input
}
