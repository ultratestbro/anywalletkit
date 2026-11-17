/**
 * Shutter's threshold IBE on BLS12-381, in pure TypeScript (no WASM, no Buffer): what `shcrypto` (Go) and
 * `@shutter-network/shutter-sdk` do, byte for byte — the package's tests run Shutter's own vectors.
 *
 * - identity point  Q = hash_to_G1(0x01 ‖ identity, DST "SHUTTER_V01_BLS12381G1_XMD:SHA-256_SSWU_RO_")
 * - r  = keccak256(0x03 ‖ σ ‖ m) mod q
 * - c1 = r·G2 (compressed, 96 bytes)
 * - c2 = σ ⊕ keccak256(0x02 ‖ e(Q, eonKey)^r)        (GT serialized the way blst does: see `gtBytes`)
 * - c3 = blocks of pad(m) ⊕ keccak256(0x04 ‖ σ ‖ i)  (i big-endian, leading zero bytes dropped, at least one byte)
 * - ciphertext = 0x03 ‖ c1 ‖ c2 ‖ c3
 *
 * Decryption recomputes r from the recovered σ and message and checks c1 = r·G2 (the Fujisaki–Okamoto check the
 * official SDK skips), so a ciphertext that was tampered with does not decrypt to something else. A decryption key is
 * checked against the eon key by pairing before it is used: e(key, G2) = e(Q, eonKey).
 */
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { ShutterCryptoError } from './errors.js'
import { bytesOf, type BytesLike } from './bytes.js'

const { G1, G2, fields } = bls12_381
const { Fp, Fp12, Fr } = fields

/** Domain separation tag of Shutter's identity hash (v01). */
export const SHUTTER_IDENTITY_DST = 'SHUTTER_V01_BLS12381G1_XMD:SHA-256_SSWU_RO_'
/** First byte of a Shutter ciphertext (crypto version 3). */
export const SHUTTER_CIPHERTEXT_VERSION = 0x03

const C1_LENGTH = 96
const C2_LENGTH = 32
const BLOCK = 32
const HEADER = 1 + C1_LENGTH + C2_LENGTH

type G1Point = ReturnType<typeof G1.hashToCurve>
type G2Point = InstanceType<typeof G2.Point>
type Gt = ReturnType<typeof bls12_381.pairing>

const tagged = (tag: number, ...parts: Uint8Array[]) => keccak_256(concatBytes(new Uint8Array([tag]), ...parts))

/** blst's `blst_bendian_from_fp12` order: for each Fp2 slot i of the two Fp6 halves, c0 then c1 of half 0, then half 1. */
function gtBytes(f: Gt): Uint8Array {
  const out: Uint8Array[] = []
  for (let i = 0; i < 3; i++) {
    for (const half of [f.c0, f.c1]) {
      const fp2 = i === 0 ? half.c0 : i === 1 ? half.c1 : half.c2
      out.push(Fp.toBytes(fp2.c0), Fp.toBytes(fp2.c1))
    }
  }
  return concatBytes(...out)
}

const hash2 = (gt: Gt) => tagged(0x02, gtBytes(gt))

function hash3(sigma: Uint8Array, message: Uint8Array): bigint {
  let x = 0n
  for (const b of tagged(0x03, sigma, message)) x = (x << 8n) | BigInt(b)
  return x % Fr.ORDER
}

/** The block index as Shutter encodes it: 4-byte big-endian with leading zero bytes dropped, at least one byte. */
function blockSuffix(i: number): Uint8Array {
  const b = [(i >>> 24) & 0xff, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff]
  let k = 0
  while (k < 3 && b[k] === 0) k++
  return new Uint8Array(b.slice(k))
}

function blockKeys(sigma: Uint8Array, count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => tagged(0x04, sigma, blockSuffix(i)))
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}

/** PKCS#7-style padding to 32-byte blocks: always 1–32 bytes, each holding the padding length. */
function pad(message: Uint8Array): Uint8Array {
  const n = BLOCK - (message.length % BLOCK)
  const out = new Uint8Array(message.length + n)
  out.set(message)
  out.fill(n, message.length)
  return out
}

function unpad(padded: Uint8Array): Uint8Array {
  const n = padded[padded.length - 1]
  if (n === undefined || n === 0 || n > BLOCK || n > padded.length) throw new ShutterCryptoError('invalid padding')
  for (let i = padded.length - n; i < padded.length; i++) if (padded[i] !== n) throw new ShutterCryptoError('invalid padding')
  return padded.subarray(0, padded.length - n)
}

/** The G1 point an identity maps to. `identity` is the 32-byte identity the registry derives (not the prefix). */
export function identityPoint(identity: BytesLike): G1Point {
  return G1.hashToCurve(concatBytes(new Uint8Array([0x01]), bytesOf(identity, 'identity')), { DST: SHUTTER_IDENTITY_DST }) as G1Point
}

function g2(bytes: BytesLike, what: string): G2Point {
  try {
    const p = G2.Point.fromBytes(bytesOf(bytes, what))
    p.assertValidity()
    if (p.is0()) throw new Error('point at infinity')
    return p
  } catch (error) {
    throw new ShutterCryptoError(`${what} is not a valid BLS12-381 G2 point (${error instanceof Error ? error.message : String(error)})`)
  }
}

function g1(bytes: BytesLike, what: string): InstanceType<typeof G1.Point> {
  try {
    const p = G1.Point.fromBytes(bytesOf(bytes, what))
    p.assertValidity()
    if (p.is0()) throw new Error('point at infinity')
    return p
  } catch (error) {
    throw new ShutterCryptoError(`${what} is not a valid BLS12-381 G1 point (${error instanceof Error ? error.message : String(error)})`)
  }
}

function randomSigma(): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto
  if (!c?.getRandomValues) throw new ShutterCryptoError('no secure random source: install a crypto.getRandomValues polyfill (react-native-get-random-values) before encrypting')
  return c.getRandomValues(new Uint8Array(32))
}

export interface EncryptInput {
  /** The plaintext. */
  readonly message: BytesLike
  /** The 32-byte identity the decryption key will be released for. */
  readonly identity: BytesLike
  /** The eon public key (G2, 96 bytes compressed). */
  readonly eonKey: BytesLike
  /** 32 random bytes. Generated with `crypto.getRandomValues` when absent; pass one only to reproduce a vector. */
  readonly sigma?: BytesLike | undefined
}

/** Encrypt for an identity under an eon key. Returns the Shutter ciphertext (`0x03 ‖ c1 ‖ c2 ‖ c3`). */
export function encrypt(input: EncryptInput): Uint8Array {
  const message = bytesOf(input.message, 'message')
  const sigma = input.sigma === undefined ? randomSigma() : bytesOf(input.sigma, 'sigma')
  if (sigma.length !== 32) throw new ShutterCryptoError('sigma must be 32 bytes')
  const eonKey = g2(input.eonKey, 'eon key')
  const r = hash3(sigma, message)
  if (r === 0n) throw new ShutterCryptoError('degenerate randomness') // probability 2^-255; never use r = 0
  const c1 = G2.Point.BASE.multiply(r).toBytes(true)
  const c2 = xor(sigma, hash2(Fp12.pow(bls12_381.pairing(identityPoint(input.identity), eonKey), r)))
  const blocks = pad(message)
  const keys = blockKeys(sigma, blocks.length / BLOCK)
  const c3 = new Uint8Array(blocks.length)
  keys.forEach((key, i) => c3.set(xor(blocks.subarray(i * BLOCK, (i + 1) * BLOCK), key), i * BLOCK))
  return concatBytes(new Uint8Array([SHUTTER_CIPHERTEXT_VERSION]), c1, c2, c3)
}

/** The parts of a Shutter ciphertext; throws for anything that is not one. */
export function parseCiphertext(ciphertext: BytesLike): { c1: Uint8Array; c2: Uint8Array; c3: Uint8Array } {
  const bytes = bytesOf(ciphertext, 'ciphertext')
  if (bytes[0] !== SHUTTER_CIPHERTEXT_VERSION) throw new ShutterCryptoError(`unsupported ciphertext version ${bytes[0] ?? 'none'}`)
  if (bytes.length < HEADER + BLOCK || (bytes.length - HEADER) % BLOCK !== 0) throw new ShutterCryptoError('ciphertext has the wrong length')
  return { c1: bytes.slice(1, 1 + C1_LENGTH), c2: bytes.slice(1 + C1_LENGTH, HEADER), c3: bytes.slice(HEADER) }
}

/**
 * True when `decryptionKey` is the key the keypers release for `identity` under `eonKey`: e(key, G2) = e(Q, eonKey).
 * A key that fails this cannot decrypt the message, and an API that serves one is wrong or lying.
 */
export function verifyDecryptionKey(decryptionKey: BytesLike, identity: BytesLike, eonKey: BytesLike): boolean {
  const key = g1(decryptionKey, 'decryption key')
  const eon = g2(eonKey, 'eon key')
  // e(key, −G2) · e(Q, eonKey) = 1, in one batch: one final exponentiation instead of two (half the time on Hermes).
  return Fp12.eql(bls12_381.pairingBatch([{ g1: key, g2: G2.Point.BASE.negate() }, { g1: identityPoint(identity), g2: eon }]), Fp12.ONE)
}

/**
 * Decrypt with the identity's decryption key (G1, 48 bytes compressed). Throws when the ciphertext does not open
 * consistently under that key (wrong key, or a ciphertext changed after encryption).
 */
export function decrypt(ciphertext: BytesLike, decryptionKey: BytesLike): Uint8Array {
  const { c1, c2, c3 } = parseCiphertext(ciphertext)
  const c1Point = g2(c1, 'ciphertext c1')
  const key = g1(decryptionKey, 'decryption key')
  const sigma = xor(c2, hash2(bls12_381.pairing(key, c1Point)))
  const keys = blockKeys(sigma, c3.length / BLOCK)
  const padded = new Uint8Array(c3.length)
  keys.forEach((k, i) => padded.set(xor(c3.subarray(i * BLOCK, (i + 1) * BLOCK), k), i * BLOCK))
  let message: Uint8Array
  try {
    message = unpad(padded)
  } catch {
    throw new ShutterCryptoError('the ciphertext does not decrypt under this key')
  }
  // Fujisaki–Okamoto: the randomness must re-derive c1, or σ (and so the message) is not what was encrypted.
  if (!G2.Point.BASE.multiply(hash3(sigma, message)).equals(c1Point)) throw new ShutterCryptoError('the ciphertext does not decrypt under this key')
  return message.slice()
}
