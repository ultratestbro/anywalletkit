/**
 * BIP-137 message signing exactly as @bitcoinerlab/btcmessage does it:
 * hash = sha256d(varint(prefix) || prefix || varint(len) || message); header byte =
 * 27 + recovery (+4 compressed) (+8 segwit, +4 more for p2wpkh) → p2wpkh = 39 + recovery.
 * Output base64 of header || r || s.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { base64 } from '@scure/base'
import * as ecc from '@bitcoinerlab/secp256k1'

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
  const { signature, recoveryId } = ecc.signRecoverable(magicHash(message), privateKey)
  let flag = recoveryId
  if (segwitType !== undefined) { flag += 8; if (segwitType === 'p2wpkh') flag += 4 } else flag += 4 // compressed
  const out = new Uint8Array(65)
  out[0] = 27 + flag
  out.set(signature, 1)
  return base64.encode(out)
}

/** Recover the compressed public key from a BIP-137 signature, or undefined when malformed. */
export function recoverMessagePublicKey(message: string | Uint8Array, signature: string): { publicKey: Uint8Array; segwitType: SegwitType | undefined } | undefined {
  let bytes: Uint8Array
  try { bytes = base64.decode(signature) } catch { return undefined }
  if (bytes.length !== 65) return undefined
  const flag = bytes[0]! - 27
  if (flag < 0 || flag > 15) return undefined
  const recovery = flag & 3
  const compressed = !!(flag & 4) || !!(flag & 8)
  const segwit = flag & 8 ? ((flag & 4) ? 'p2wpkh' : 'p2sh(p2wpkh)') : undefined
  const pub = ecc.recover(magicHash(message), bytes.slice(1), recovery as 0 | 1 | 2 | 3, compressed)
  return pub ? { publicKey: pub, segwitType: segwit } : undefined
}
