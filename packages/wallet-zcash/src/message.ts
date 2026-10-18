/**
 * Zcash signed messages (zcashd `signmessage` / `verifymessage`): the Bitcoin
 * scheme with the `Zcash Signed Message:\n` magic. hash = sha256d(varint(prefix)
 * ‖ prefix ‖ varint(len) ‖ message); header byte = 27 + recovery + 4
 * (compressed key); output base64 of header ‖ r ‖ s. RFC-6979 deterministic, low-S.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { base64 } from '@scure/base'
import type { Signer } from '@forgewallet/core'
import { compactSize, utf8ToBytes } from './encoding.js'

const MAGIC = 'Zcash Signed Message:\n'
const PREFIX = utf8ToBytes(MAGIC)

export function magicHash(message: string | Uint8Array): Uint8Array {
  const msg = typeof message === 'string' ? utf8ToBytes(message) : message
  const p = compactSize(PREFIX.length), l = compactSize(msg.length)
  const buf = new Uint8Array(p.length + PREFIX.length + l.length + msg.length)
  let o = 0
  for (const part of [p, PREFIX, l, msg]) { buf.set(part, o); o += part.length }
  return sha256(sha256(buf))
}

/** Encode `r‖s` + recovery id as a base64 signature (compressed-key header 31 + recovery). */
export function encodeMessageSignature(rs: Uint8Array, recovery: number): string {
  if (rs.length !== 64 || recovery > 3) throw new Error('Expected a 64-byte r‖s signature and a recovery id 0..3.')
  const out = new Uint8Array(65)
  out[0] = 27 + 4 + recovery
  out.set(rs, 1)
  return base64.encode(out)
}

/** Sign through a {@link Signer} (`ecdsa-recoverable`, context `zcash-message`). */
export async function signMessageWith(message: string | Uint8Array, signer: Signer): Promise<string> {
  const sig = await signer.sign(magicHash(message), { scheme: 'ecdsa-recoverable', context: 'zcash-message' })
  return encodeMessageSignature(sig.subarray(0, 64), sig[64]!)
}

/** Recover the compressed public key from a message signature, or undefined when malformed. */
export function recoverMessagePublicKey(message: string | Uint8Array, signature: string): Uint8Array | undefined {
  let bytes: Uint8Array
  try { bytes = base64.decode(signature) } catch { return undefined }
  if (bytes.length !== 65) return undefined
  const flag = bytes[0]! - 27
  if (flag < 0 || flag > 15) return undefined
  const recovered = new Uint8Array(65)
  recovered[0] = flag & 3
  recovered.set(bytes.subarray(1), 1)
  try {
    const pub = secp256k1.recoverPublicKey(recovered, magicHash(message), { prehash: false })
    return pub.length === 33 ? pub : secp256k1.Point.fromBytes(pub).toBytes(true)
  } catch { return undefined }
}
