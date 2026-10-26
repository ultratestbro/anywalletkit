import { sha256 } from '@noble/hashes/sha2.js'
import { MAX_SEED_LENGTH } from './constants.js'

// Base58 and `create_with_seed` in plain JS: no WebCrypto, so they run unchanged in Hermes.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]))

/** Base58 (Bitcoin alphabet) decode. Throws on a character outside the alphabet. */
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of s) {
    let carry = INDEX.get(ch)
    if (carry === undefined) throw new Error(`Invalid base58 character '${ch}'.`)
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of s) {
    if (ch !== '1') break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

/** Base58 (Bitcoin alphabet) encode. */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    out += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!]
  return out
}

/** A 32-byte Solana address in base58. */
export function isAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false
  try {
    return base58Decode(value).length === 32
  } catch {
    return false
  }
}

/** The 32 bytes of an address; throws with the field name when it is not one. */
export function addressBytes(address: string, what = 'address'): Uint8Array {
  if (!isAddress(address)) throw new Error(`${what} is not a Solana address: ${String(address)}`)
  return base58Decode(address)
}

/**
 * `Pubkey::create_with_seed`: `sha256(base ‖ seed ‖ owner)`. The address of an account created by
 * System `CreateAccountWithSeed`, which only the base key has to sign.
 */
export function createWithSeed(base: string, seed: string, owner: string): string {
  const seedBytes = new TextEncoder().encode(seed)
  if (seedBytes.length > MAX_SEED_LENGTH) throw new Error(`Seed '${seed}' is longer than ${MAX_SEED_LENGTH} bytes.`)
  const b = addressBytes(base, 'base')
  const o = addressBytes(owner, 'owner')
  const buf = new Uint8Array(b.length + seedBytes.length + o.length)
  buf.set(b, 0)
  buf.set(seedBytes, b.length)
  buf.set(o, b.length + seedBytes.length)
  return base58Encode(sha256(buf))
}
