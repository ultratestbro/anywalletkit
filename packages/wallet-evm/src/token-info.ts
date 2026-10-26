import { hexToBytes, type Hex } from 'viem'

/** `decimals()`, `symbol()`, `name()`, `totalSupply()`. */
export const TOKEN_INFO_SELECTORS = {
  decimals: '0x313ce567', symbol: '0x95d89b41', name: '0x06fdde03', totalSupply: '0x18160ddd',
} as const satisfies Record<string, Hex>

/**
 * Storage slots a proxy keeps its implementation (or beacon) in: EIP-1967 implementation and
 * beacon, EIP-1822 (UUPS "PROXIABLE"), and the ZeppelinOS slot older proxies use (USDC's).
 */
export const PROXY_SLOTS: readonly Hex[] = [
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
]

const MAX_TEXT = 128
/** Strict UTF-8 → string, '' for any malformed sequence. Hand-written: Hermes polyfills of TextDecoder may ignore `fatal`. */
function utf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i]!
    let cp: number, n: number
    if (b0 < 0x80) { cp = b0; n = 1 }
    else if (b0 >= 0xc2 && b0 < 0xe0) { cp = b0 & 0x1f; n = 2 }
    else if (b0 >= 0xe0 && b0 < 0xf0) { cp = b0 & 0x0f; n = 3 }
    else if (b0 >= 0xf0 && b0 < 0xf5) { cp = b0 & 0x07; n = 4 }
    else return ''
    if (i + n > bytes.length) return ''
    for (let k = 1; k < n; k++) {
      const b = bytes[i + k]!
      if ((b & 0xc0) !== 0x80) return ''
      cp = (cp << 6) | (b & 0x3f)
    }
    // overlong forms, UTF-16 surrogates and code points past U+10FFFF are not UTF-8
    if ((n === 3 && cp < 0x800) || (n === 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return ''
    out += String.fromCodePoint(cp)
    i += n
  }
  return out
}

/**
 * A `symbol()` / `name()` return value: an ABI `string`, or a `bytes32` (MKR, early tokens) with its
 * trailing zero bytes cut. Anything else, or bytes that are not UTF-8, is ''. Capped at 128 characters.
 */
export function decodeTokenString(hex: Hex | undefined): string {
  if (!hex || hex === '0x') return ''
  const b = hexToBytes(hex)
  let out = ''
  if (b.length === 32) {
    let end = 32
    while (end > 0 && b[end - 1] === 0) end--
    out = utf8(b.subarray(0, end))
  } else if (b.length >= 64) {
    const word = (at: number) => {
      let v = 0n
      for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(b[i]!)
      return v
    }
    const offset = word(0)
    if (offset + 32n <= BigInt(b.length)) {
      const o = Number(offset.toString()) // below b.length: small
      const len = word(o)
      if (BigInt(o) + 32n + len <= BigInt(b.length)) {
        const n = Number(len.toString()) // at most b.length: small
        out = utf8(b.subarray(o + 32, o + 32 + n))
      }
    }
  }
  out = out.replace(/\0+$/g, '')
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) : out
}
