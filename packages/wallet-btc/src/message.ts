/**
 * BIP-137 message signatures (the Electrum / Bitcoin Core encoding):
 * hash = sha256d(varint(prefix) || prefix || varint(len) || message); header byte =
 * 27 + recovery (+4 compressed) (+8 segwit, +4 more for p2wpkh) → p2wpkh = 39 + recovery.
 * Output: base64 of header || r || s. Signing is RFC-6979 deterministic, low-S.
 *
 * Only p2pkh / p2wpkh keys have a BIP-137 form; taproot accounts must use BIP-322
 * (not implemented).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base64 } from '@scure/base'

const PREFIX = new TextEncoder().encode('\u0018Bitcoin Signed Message:\n') // the \x18 IS the varint length (24) of "Bitcoin Signed Message:\n"

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff)
}

export function magicHash(message: string | Uint8Array): Uint8Array {
  const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message
  const len = varint(msg.length)
  const buf = new Uint8Array(PREFIX.length + len.length + msg.length)
  buf.set(PREFIX, 0); buf.set(len, PREFIX.length); buf.set(msg, PREFIX.length + len.length)
  return sha256(sha256(buf))
}

export type SegwitType = 'p2wpkh' | 'p2sh(p2wpkh)'

export function signMessage(message: string | Uint8Array, privateKey: Uint8Array, segwitType: SegwitType | undefined = 'p2wpkh'): string {
  // 65 bytes: recovery id || r || s
  const sig = secp256k1.sign(magicHash(message), privateKey, { prehash: false, format: 'recovered' })
  let flag = sig[0]!
  if (segwitType !== undefined) { flag += 8; if (segwitType === 'p2wpkh') flag += 4 } else flag += 4 // compressed
  const out = new Uint8Array(65)
  out[0] = 27 + flag
  out.set(sig.subarray(1), 1)
  return base64.encode(out)
}

/** Recover the public key (compressed unless the header says otherwise) from a BIP-137 signature, or undefined when malformed. */
export function recoverMessagePublicKey(message: string | Uint8Array, signature: string): { publicKey: Uint8Array; segwitType: SegwitType | undefined } | undefined {
  let bytes: Uint8Array
  try { bytes = base64.decode(signature) } catch { return undefined }
  if (bytes.length !== 65) return undefined
  const flag = bytes[0]! - 27
  if (flag < 0 || flag > 15) return undefined
  const recovery = flag & 3
  const compressed = !!(flag & 4) || !!(flag & 8)
  const segwit = flag & 8 ? ((flag & 4) ? 'p2wpkh' : 'p2sh(p2wpkh)') : undefined
  const recovered = new Uint8Array(65)
  recovered[0] = recovery
  recovered.set(bytes.subarray(1), 1)
  try {
    const pub = secp256k1.recoverPublicKey(recovered, magicHash(message), { prehash: false })
    const publicKey = compressed ? pub : secp256k1.Point.fromBytes(pub).toBytes(false)
    return { publicKey, segwitType: segwit }
  } catch { return undefined }
}
