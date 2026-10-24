import { HDKey } from '@scure/bip32'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { ed25519 } from '@noble/curves/ed25519.js'

/** A key derived from a seed at one path. The caller owns `privateKey` and should zeroize it. */
export interface DerivedKey {
  /** 32-byte private key (secp256k1 scalar or ed25519 seed). */
  privateKey: Uint8Array
  /** Compressed 33-byte secp256k1 or 32-byte ed25519 public key. */
  publicKey: Uint8Array
  /** The path it was derived at. */
  path: string
}

const HARDENED = 0x80000000

/** Parse "m/44'/60'/0'/0/0" into indexes; `'` or `h` marks hardened. */
export function parsePath(path: string): number[] {
  const parts = path.trim().split('/')
  if (parts[0] !== 'm') throw new Error(`Derivation path must start with "m": ${path}`)
  return parts.slice(1).map((p) => {
    const hardened = /['h]$/.test(p)
    const n = Number.parseInt(hardened ? p.slice(0, -1) : p, 10)
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error(`Bad path segment "${p}" in ${path}`)
    return hardened ? n + HARDENED : n
  })
}

/**
 * BIP-32 over secp256k1 — EVM (m/44'/60'/0'/0/i), BTC (m/84'/0'/0'/0/i),
 * Tron (m/44'/195'/0'/0/i). Returns the 33-byte compressed public key.
 */
export function deriveSecp256k1(seed: Uint8Array, path: string): DerivedKey {
  const node = HDKey.fromMasterSeed(seed).derive(path)
  if (!node.privateKey || !node.publicKey) throw new Error(`No key at ${path}`)
  return { privateKey: node.privateKey, publicKey: node.publicKey, path }
}

/**
 * SLIP-10 over ed25519 — Solana (m/44'/501'/i'/0'), TON (m/44'/607'/i').
 * Only hardened segments exist for ed25519; a non-hardened one is an error.
 * Returns the 32-byte ed25519 public key.
 */
export function deriveEd25519(seed: Uint8Array, path: string): DerivedKey {
  const indexes = parsePath(path)
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  let key = I.slice(0, 32)
  let chainCode = I.slice(32)
  for (const index of indexes) {
    if (index < HARDENED) throw new Error(`SLIP-10 ed25519 supports hardened segments only: ${path}`)
    const data = new Uint8Array(1 + 32 + 4)
    data[0] = 0
    data.set(key, 1)
    new DataView(data.buffer).setUint32(33, index, false)
    I = hmac(sha512, chainCode, data)
    key = I.slice(0, 32)
    chainCode = I.slice(32)
  }
  return { privateKey: key, publicKey: ed25519.getPublicKey(key), path }
}
