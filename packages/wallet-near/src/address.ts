import { base58 } from '@scure/base'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { NearPublicKey } from './types.js'

/** NEAR account id grammar (nearcore `AccountId`): 2–64 chars, lowercase alnum, `_`/`-` inside parts, `.` between parts. */
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id)
}

/** 64 lowercase hex chars = an implicit account (the account id IS the ed25519 public key). */
export function isImplicitAccountId(id: string): boolean {
  return id.length === 64 && /^[0-9a-f]{64}$/.test(id)
}

/** The implicit account id of an ed25519 public key. */
export function implicitAccountId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new RangeError('ed25519 public key must be 32 bytes')
  return bytesToHex(publicKey)
}

/** "ed25519:<base58>" as NEAR tooling prints keys. */
export function publicKeyToString(k: NearPublicKey): string {
  return `${k.keyType}:${base58.encode(k.data)}`
}

export function parsePublicKey(s: string): NearPublicKey {
  const [type, data] = s.includes(':') ? s.split(':', 2) : ['ed25519', s]
  if (type !== 'ed25519' && type !== 'secp256k1') throw new RangeError(`unknown key type ${type}`)
  const bytes = base58.decode(data!)
  const want = type === 'ed25519' ? 32 : 64
  if (bytes.length !== want) throw new RangeError(`${type} public key must be ${want} bytes`)
  return { keyType: type, data: bytes }
}

export function ed25519Key(publicKey: Uint8Array): NearPublicKey {
  if (publicKey.length !== 32) throw new RangeError('ed25519 public key must be 32 bytes')
  return { keyType: 'ed25519', data: publicKey }
}

/** The ed25519 public key behind an implicit account id. */
export function publicKeyOfImplicit(accountId: string): Uint8Array {
  if (!isImplicitAccountId(accountId)) throw new RangeError(`${accountId} is not an implicit account id`)
  return hexToBytes(accountId)
}

export function base58ToBytes(s: string, length?: number): Uint8Array {
  const b = base58.decode(s)
  if (length !== undefined && b.length !== length) throw new RangeError(`expected ${length} bytes, got ${b.length}`)
  return b
}
export const bytesToBase58 = (b: Uint8Array): string => base58.encode(b)
