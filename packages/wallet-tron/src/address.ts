import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { createBase58check } from '@scure/base'

const b58check = createBase58check(sha256)
export const ADDRESS_PREFIX = 0x41

/** Compressed secp256k1 pubkey → base58 T… address (keccak of X||Y, last 20 bytes, 0x41 prefix, sha256d checksum). */
export function addressFromPublicKey(compressed: Uint8Array): string {
  const xy = secp256k1.Point.fromBytes(compressed).toBytes(false).slice(1)
  const hash = keccak_256(xy)
  const bytes = new Uint8Array(21)
  bytes[0] = ADDRESS_PREFIX
  bytes.set(hash.slice(12), 1)
  return b58check.encode(bytes)
}

/** True for a hex Tron address (`41` plus 20 bytes, optional `0x`). */
export function isHexAddress(a: string): boolean {
  return /^(0x)?41[0-9a-fA-F]{40}$/.test(a)
}

/** Any accepted form → 21-byte hex "41…" (lowercase, no 0x). */
export function toHexAddress(address: string): string {
  if (isHexAddress(address)) return address.replace(/^0x/, '').toLowerCase()
  const bytes = b58check.decode(address)
  if (bytes.length !== 21 || bytes[0] !== ADDRESS_PREFIX) throw new Error(`Invalid Tron address: ${address}`)
  return bytesToHex(bytes)
}

/** Any accepted form → base58 T… */
export function toBase58Address(address: string): string {
  if (!isHexAddress(address)) { toHexAddress(address); return address }
  return b58check.encode(hexToBytes(address.replace(/^0x/, '')))
}

/** 20-byte EVM-style hex (no 0x) for ABI encoding. */
export function toEvmHex(address: string): string {
  return toHexAddress(address).slice(2)
}
