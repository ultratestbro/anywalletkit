/**
 * A drop-in for the `react-native-fast-pbkdf2` native module, in pure JS (noble).
 *
 * `@ton/crypto-primitives` (under `@anywalletkit/wallet-ton`) resolves its React
 * Native build on Metro and requires `react-native-fast-pbkdf2` for PBKDF2 —
 * the TON 24-word mnemonic (Tonkeeper / Tonhub format). Without the module the
 * bundle does not build; with a throwing stub, TON-mnemonic imports fail on the
 * device. Point Metro at this file instead:
 *
 * ```js
 * // metro.config.js
 * config.resolver.resolveRequest = (context, moduleName, platform) =>
 *   moduleName === 'react-native-fast-pbkdf2'
 *     ? { type: 'sourceFile', filePath: require.resolve('@anywalletkit/runtime-hermes/fast-pbkdf2') }
 *     : context.resolveRequest(context, moduleName, platform)
 * ```
 *
 * Same call shape as the native module: base64 in, base64 out.
 */
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'

const HASHES = { 'sha-512': sha512, 'sha-256': sha256 } as const

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 → bytes (padding optional). */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error('fast-pbkdf2: invalid base64')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let i = 0
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[i++] = (value >> bits) & 0xff
    }
  }
  return out.subarray(0, i)
}

/** Bytes → standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

const fastPbkdf2 = {
  async derive(keyB64: string, saltB64: string, iterations: number, keyLen: number, hash: string): Promise<string> {
    const h = HASHES[hash as keyof typeof HASHES]
    if (!h) throw new Error(`fast-pbkdf2: unsupported hash ${hash}`)
    const out = await pbkdf2Async(h, fromBase64(keyB64), fromBase64(saltB64), { c: iterations, dkLen: keyLen })
    return toBase64(out)
  },
}

export default fastPbkdf2
