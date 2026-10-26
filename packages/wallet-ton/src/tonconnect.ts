/**
 * TON Connect signatures (docs.ton.org/develop/dapps/ton-connect/sign): `ton_proof` and
 * `signData` (text / binary). The account builds the digest itself, from the request fields and
 * its own address, so what it signs always starts with the TON Connect prefix (0xffff ‖
 * "ton-connect…") and can never be the cell hash a wallet contract checks a transfer against.
 *
 * ton_proof:
 *   sha256(0xffff ‖ "ton-connect" ‖ sha256("ton-proof-item-v2/" ‖ workchain:int32BE ‖
 *     address_hash:32 ‖ domain_len:uint32LE ‖ domain ‖ timestamp:uint64LE ‖ payload))
 * signData (text | binary):
 *   sha256(0xffff ‖ "ton-connect/sign-data/" ‖ workchain:int32BE ‖ address_hash:32 ‖
 *     domain_len:uint32BE ‖ domain ‖ timestamp:uint64BE ‖ "txt"|"bin" ‖ payload_len:uint32BE ‖ payload)
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'

/** What a dApp asks `ton_proof` for: its domain (host), the time of the proof, its nonce. */
export interface TonProofRequest {
  /** The dApp's host as the wallet saw it (`app.example`), never the dApp's own claim. */
  domain: string
  /** Unix seconds. */
  timestamp: number
  /** The dApp's `ton_proof` payload. */
  payload: string
}

/** The `proof` object of a TON Connect `ton_proof` reply. */
export interface TonProof {
  timestamp: number
  domain: { lengthBytes: number; value: string }
  payload: string
  /** Base64 ed25519 signature. */
  signature: string
}

/** A `signData` payload. `cell` payloads need schema-aware rendering and are not signed here. */
export type TonSignDataPayload = { type: 'text'; text: string } | { type: 'binary'; bytes: string }

/** What a dApp asks `signData` for. */
export interface TonSignDataRequest {
  /** The dApp's host as the wallet saw it. */
  domain: string
  /** Unix seconds. */
  timestamp: number
  payload: TonSignDataPayload
}

/** The TON Connect `signData` reply. */
export interface TonSignedData {
  /** Base64 ed25519 signature. */
  signature: string
  /** Raw form (`0:…`) of the address that signed. */
  address: string
  timestamp: number
  domain: string
  payload: TonSignDataPayload
}

/** The address parts the digests bind to. */
export interface TonAddressParts { workChain: number; hash: Uint8Array }

const utf8 = (s: string) => new TextEncoder().encode(s)
const int32BE = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, false); return b }
const uint32 = (n: number, littleEndian: boolean) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, littleEndian); return b }
const uint64 = (n: number, littleEndian: boolean) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), littleEndian); return b }
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }

function checkCommon(address: TonAddressParts, domain: unknown, timestamp: unknown): void {
  if (address.hash.length !== 32) throw new RangeError('TON address hash must be 32 bytes.')
  if (!Number.isInteger(address.workChain)) throw new TypeError('TON address workChain must be an integer.')
  if (typeof domain !== 'string' || domain.length === 0) throw new TypeError('TON Connect domain must be a non-empty string.')
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('TON Connect timestamp must be a non-negative integer (unix seconds).')
}

/** Standard base64 (padding optional, ASCII whitespace ignored as `atob` does), strictly: a malformed `bytes` is refused, not half-decoded. */
function base64Bytes(raw: string): Uint8Array {
  const s = raw.replace(/[\t\n\f\r ]/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.replace(/=+$/, '').length % 4 === 1) throw new TypeError('signData binary payload must be base64.')
  return new Uint8Array(Buffer.from(s, 'base64'))
}

/** The 32 bytes a wallet signs for `ton_proof`. */
export function tonProofDigest(address: TonAddressParts, request: TonProofRequest): Uint8Array {
  checkCommon(address, request.domain, request.timestamp)
  if (typeof request.payload !== 'string') throw new TypeError('ton_proof payload must be a string.')
  const domain = utf8(request.domain)
  const inner = concat(utf8('ton-proof-item-v2/'), int32BE(address.workChain), address.hash, uint32(domain.length, true), domain, uint64(request.timestamp, true), utf8(request.payload))
  return sha256(concat(new Uint8Array([0xff, 0xff]), utf8('ton-connect'), sha256(inner)))
}

/** The 32 bytes a wallet signs for `signData` (text / binary). */
export function tonSignDataDigest(address: TonAddressParts, request: TonSignDataRequest): Uint8Array {
  checkCommon(address, request.domain, request.timestamp)
  const p = request.payload as { type?: unknown; text?: unknown; bytes?: unknown } | undefined
  let payload: Uint8Array
  if (p?.type === 'text' && typeof p.text === 'string') payload = utf8(p.text)
  else if (p?.type === 'binary' && typeof p.bytes === 'string') payload = base64Bytes(p.bytes)
  else throw new TypeError('signData payload must be { type: "text", text } or { type: "binary", bytes }; cell payloads are not supported.')
  const domain = utf8(request.domain)
  return sha256(concat(new Uint8Array([0xff, 0xff]), utf8('ton-connect/sign-data/'), int32BE(address.workChain), address.hash, uint32(domain.length, false), domain, uint64(request.timestamp, false), utf8(p.type === 'text' ? 'txt' : 'bin'), uint32(payload.length, false), payload))
}
