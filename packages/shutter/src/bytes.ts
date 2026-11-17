import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { ShutterCryptoError } from './errors.js'

/** `0x`-prefixed hex or raw bytes. */
export type BytesLike = Uint8Array | string

/** Bytes from hex (`0x` optional) or a Uint8Array; strings are hex, never text. */
export function bytesOf(value: BytesLike, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value !== 'string') throw new ShutterCryptoError(`${what} must be hex or bytes`)
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new ShutterCryptoError(`${what} is not valid hex`)
  return hexToBytes(hex)
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`
}

/** UTF-8 encode without relying on TextEncoder. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return new Uint8Array(out)
}

/** Strict UTF-8 decode without TextDecoder (Hermes has none): invalid input throws instead of producing U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!
    let len = 1
    let cp = b
    if (b >= 0x80) {
      if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f } else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f } else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07 } else throw new ShutterCryptoError('the message is not UTF-8 text')
      for (let k = 1; k < len; k++) {
        const c = bytes[i + k]
        if (c === undefined || (c & 0xc0) !== 0x80) throw new ShutterCryptoError('the message is not UTF-8 text')
        cp = (cp << 6) | (c & 0x3f)
      }
      const min = len === 2 ? 0x80 : len === 3 ? 0x800 : 0x10000
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new ShutterCryptoError('the message is not UTF-8 text')
    }
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

/** 32 random bytes as hex, from `crypto.getRandomValues` (React Native needs the react-native-get-random-values polyfill). */
export function randomHex32(): `0x${string}` {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto
  if (!c?.getRandomValues) throw new ShutterCryptoError('no secure random source: install a crypto.getRandomValues polyfill (react-native-get-random-values)')
  return toHex(c.getRandomValues(new Uint8Array(32)))
}
