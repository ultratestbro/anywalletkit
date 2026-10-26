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

/**
 * Parse "m/44'/60'/0'/0/0" into indexes; `'` or `h` marks hardened, on every curve. A segment is a
 * plain decimal index below 2^31 — `1.9'`, `0x10'`, `1e3'`, `01` are refused (parseInt read them
 * as other numbers).
 */
export function parsePath(path: string): number[] {
  const parts = path.trim().split('/')
  if (parts[0] !== 'm') throw new Error(`Derivation path must start with "m": ${path}`)
  return parts.slice(1).map((p) => {
    const m = /^(0|[1-9]\d*)(['h]?)$/.exec(p)
    const n = m ? Number(m[1]) : Number.NaN
    if (!m || !Number.isSafeInteger(n) || n >= HARDENED) throw new Error(`Bad path segment "${p}" in ${path}`)
    return m[2] ? n + HARDENED : n
  })
}

/**
 * BIP-32 over secp256k1 — EVM (m/44'/60'/0'/0/i), BTC (m/84'/0'/0'/0/i),
 * Tron (m/44'/195'/0'/0/i). Returns the 33-byte compressed public key.
 */
export function deriveSecp256k1(seed: Uint8Array, path: string): DerivedKey {
  const indexes = parsePath(path)
  // Step by step, wiping every node once its child exists: HDKey.derive() leaves the master and
  // the intermediate private keys in memory.
  let node = HDKey.fromMasterSeed(seed)
  try {
    for (const index of indexes) {
      const child = node.deriveChild(index)
      node.wipePrivateData()
      node = child
    }
    if (!node.privateKey || !node.publicKey) throw new Error(`No key at ${path}`)
    return { privateKey: node.privateKey.slice(), publicKey: node.publicKey.slice(), path }
  } finally {
    node.wipePrivateData()
  }
}

/**
 * SLIP-10 over ed25519 — Solana (m/44'/501'/i'/0'), TON (m/44'/607'/i').
 * Only hardened segments exist for ed25519; a non-hardened one is an error.
 * Returns the 32-byte ed25519 public key.
 */
export function deriveEd25519(seed: Uint8Array, path: string): DerivedKey {
  const indexes = parsePath(path)
  for (const index of indexes) if (index < HARDENED) throw new Error(`SLIP-10 ed25519 supports hardened segments only: ${path}`)
  // Every HMAC output, parent key, chain code and input block is zeroed once used.
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  let key = I.slice(0, 32)
  let chainCode = I.slice(32)
  I.fill(0)
  try {
    for (const index of indexes) {
      const data = new Uint8Array(1 + 32 + 4)
      data.set(key, 1)
      new DataView(data.buffer).setUint32(33, index, false)
      I = hmac(sha512, chainCode, data)
      data.fill(0)
      key.fill(0)
      chainCode.fill(0)
      key = I.slice(0, 32)
      chainCode = I.slice(32)
      I.fill(0)
    }
    return { privateKey: key.slice(), publicKey: ed25519.getPublicKey(key), path }
  } finally {
    key.fill(0)
    chainCode.fill(0)
  }
}
