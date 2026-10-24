import { ed25519 } from '@noble/curves/ed25519.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58, hex } from '@scure/base'
import { zeroize } from '@forgewallet/core'
import { CHAIN_SPECS, type ChainKey } from './chains.js'
import { KeyringError } from './errors.js'

export interface ParsedKey {
  chain: ChainKey
  /** The 32-byte private key (secp256k1 scalar or ed25519 seed). The caller owns and zeroizes it. */
  privateKey: Uint8Array
}

/**
 * Formats accepted per chain:
 * - EVM, Tron: 32-byte hex, with or without `0x`.
 * - BTC, Zcash: WIF (compressed, mainnet `K…`/`L…` or testnet `c…`), or 32-byte hex.
 * - Solana: base58 64-byte secret key (Phantom export), the JSON byte array
 *   (solana-keygen / Phantom "array" export), or a base58 32-byte seed.
 * - TON: hex of the 32-byte seed or the 64-byte secret key (seed ‖ public key).
 * - NEAR: `ed25519:<base58>` of the 64-byte secret key (or a 32-byte seed).
 * A 64-byte ed25519 secret must carry its own public key — a mismatch is refused.
 */
export function parsePrivateKey(chain: ChainKey, input: string): ParsedKey {
  const raw = input.trim()
  if (!raw) throw new KeyringError('Paste a private key.')
  const curve = CHAIN_SPECS[chain].curve
  let bytes: Uint8Array
  switch (chain) {
    case 'evm':
    case 'tron':
      bytes = fromHex(raw, chain)
      break
    case 'btc':
    case 'zcash':
      bytes = /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? fromHex(raw, chain) : fromWif(raw)
      break
    case 'solana':
      bytes = raw.startsWith('[') ? fromJsonArray(raw) : fromBase58(raw, chain)
      break
    case 'ton':
      bytes = fromHex(raw, chain, true)
      break
    case 'near': {
      const m = /^ed25519:(.+)$/.exec(raw)
      if (!m) throw new KeyringError('A NEAR private key looks like "ed25519:…".')
      bytes = fromBase58(m[1]!, chain)
      break
    }
  }
  const privateKey = curve === 'ed25519' ? ed25519Seed(bytes) : bytes
  if (privateKey.length !== 32) throw new KeyringError(`A ${chain} private key is 32 bytes; this one is ${privateKey.length}.`)
  if (curve === 'secp256k1' && !secp256k1.utils.isValidSecretKey(privateKey)) throw new KeyringError('This is not a valid secp256k1 private key.')
  return { chain, privateKey }
}

/** Public key of a parsed key (33-byte compressed secp256k1, or 32-byte ed25519). */
export function publicKeyOf(parsed: ParsedKey): Uint8Array {
  return CHAIN_SPECS[parsed.chain].curve === 'secp256k1' ? secp256k1.getPublicKey(parsed.privateKey, true) : ed25519.getPublicKey(parsed.privateKey)
}

/** Duplicate check without keeping the secret: chain + a hash of the public key. */
export function keyFingerprint(chain: ChainKey, publicKey: Uint8Array): string {
  return `${chain}:${hex.encode(sha256(publicKey)).slice(0, 32)}`
}

function fromHex(raw: string, chain: ChainKey, allow64 = false): Uint8Array {
  const h = raw.replace(/^0x/i, '')
  const ok = allow64 ? /^([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/ : /^[0-9a-fA-F]{64}$/
  if (!ok.test(h)) throw new KeyringError(`A ${chain} private key is ${allow64 ? '64 or 128' : '64'} hex characters.`)
  return hex.decode(h.toLowerCase())
}

function fromBase58(raw: string, chain: ChainKey): Uint8Array {
  try {
    return base58.decode(raw)
  } catch {
    throw new KeyringError(`This ${chain} key is not valid base58.`)
  }
}

function fromJsonArray(raw: string): Uint8Array {
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    throw new KeyringError('The key array is not valid JSON.')
  }
  if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new KeyringError('The key array must hold bytes (0–255).')
  return Uint8Array.from(arr as number[])
}

/** WIF: base58check(version ‖ key ‖ 0x01). Only compressed keys — SegWit and taproot addresses need them. */
function fromWif(raw: string): Uint8Array {
  let data: Uint8Array
  try {
    data = base58.decode(raw)
  } catch {
    throw new KeyringError('This is not a WIF key (base58).')
  }
  if (data.length !== 38 && data.length !== 37) throw new KeyringError('This is not a WIF key.')
  const body = data.subarray(0, data.length - 4)
  const check = sha256(sha256(body)).subarray(0, 4)
  if (!check.every((b, i) => b === data[data.length - 4 + i])) throw new KeyringError('The WIF checksum does not match — check for a typo.')
  if (body[0] !== 0x80 && body[0] !== 0xef) throw new KeyringError('This WIF is not a Bitcoin / Zcash key.')
  if (data.length === 37 || body[33] !== 0x01) throw new KeyringError('Uncompressed WIF keys are not supported (they cannot own SegWit, taproot or the SDK\'s t-addresses).')
  const key = body.slice(1, 33)
  zeroize(data)
  return key
}

/** A 32-byte seed as is; a 64-byte secret (seed ‖ public key) checked and cut to its seed. */
function ed25519Seed(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes
  if (bytes.length !== 64) return bytes
  const seed = bytes.slice(0, 32)
  const pub = ed25519.getPublicKey(seed)
  if (!pub.every((b, i) => b === bytes[32 + i])) {
    zeroize(seed)
    throw new KeyringError('This 64-byte key does not match its own public key — it is corrupted or not an ed25519 secret.')
  }
  zeroize(bytes)
  return seed
}

/** How an exported key is written — the format other wallets import and `parsePrivateKey` reads back. */
export type PrivateKeyFormat = 'hex' | 'wif' | 'base58' | 'near'

export interface FormattedPrivateKey {
  format: PrivateKeyFormat
  /** The key as text. Show it once behind authentication; never log or persist it. */
  value: string
}

/**
 * The inverse of {@link parsePrivateKey}, in the format each chain's wallets import:
 * - EVM: `0x` + 64 hex (MetaMask, Rabby); Tron: 64 hex (TronLink).
 * - BTC, Zcash: compressed WIF (`K…` / `L…`; testnet `c…`). Electrum needs a `p2wpkh:` prefix to land on the same SegWit address.
 * - Solana: base58 of the 64-byte secret key (seed ‖ public key), as Phantom exports.
 * - NEAR: `ed25519:` + base58 of the 64-byte secret key (near-cli, MyNearWallet).
 * - TON: hex of the 64-byte secret key (seed ‖ public key). TON wallets themselves import only 24-word phrases.
 */
export function formatPrivateKey(chain: ChainKey, privateKey: Uint8Array, options: { testnet?: boolean } = {}): FormattedPrivateKey {
  if (privateKey.length !== 32) throw new KeyringError(`A ${chain} private key is 32 bytes.`)
  switch (chain) {
    case 'evm':
      return { format: 'hex', value: `0x${hex.encode(privateKey)}` }
    case 'tron':
      return { format: 'hex', value: hex.encode(privateKey) }
    case 'btc':
    case 'zcash':
      return { format: 'wif', value: toWif(privateKey, options.testnet === true) }
    case 'solana':
      return { format: 'base58', value: base58.encode(ed25519Secret(privateKey)) }
    case 'near':
      return { format: 'near', value: `ed25519:${base58.encode(ed25519Secret(privateKey))}` }
    case 'ton':
      return { format: 'hex', value: hex.encode(ed25519Secret(privateKey)) }
  }
}

/** WIF: base58check(version ‖ key ‖ 0x01) — compressed, as fromWif requires. */
function toWif(key: Uint8Array, testnet: boolean): string {
  const body = new Uint8Array(34)
  body[0] = testnet ? 0xef : 0x80
  body.set(key, 1)
  body[33] = 0x01
  const check = sha256(sha256(body)).subarray(0, 4)
  const data = new Uint8Array(38)
  data.set(body, 0)
  data.set(check, 34)
  const out = base58.encode(data)
  zeroize(body)
  zeroize(data)
  return out
}

/** seed ‖ public key — the 64-byte ed25519 secret most tools exchange. */
function ed25519Secret(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(64)
  out.set(seed, 0)
  out.set(ed25519.getPublicKey(seed), 32)
  return out
}
