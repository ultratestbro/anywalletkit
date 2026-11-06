/**
 * TON Connect v2, the parts that are pure data (github.com/ton-blockchain/ton-connect,
 * `requests-responses.md`, `rpc.md`): request parsing for `connect`, `sendTransaction` and
 * `signData`, the protocol's error codes, address forms, and the digests `ton_proof` and
 * `signData` sign. One implementation for every transport a wallet answers on: the JS bridge of an
 * extension or in-app browser (`@anywalletkit/extension-kit`) and WalletConnect
 * (`@anywalletkit/walletconnect-ton`). Nothing here touches a key, and nothing imports `@ton/core`:
 * the subpath `@anywalletkit/wallet-ton/tonconnect` stays small.
 *
 * Signatures (docs.ton.org/develop/dapps/ton-connect/sign): `ton_proof` and `signData` (text /
 * binary). The account builds the digest itself, from the request fields and its own address, so
 * what it signs always starts with the TON Connect prefix (0xffff ‖ "ton-connect…") and can never
 * be the cell hash a wallet contract checks a transfer against.
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

// ── requests ────────────────────────────────────────────────────────────────

/** TON Connect error codes (`requests-responses.md`): connect errors and RPC errors share them. */
export const TONCONNECT_ERRORS = { unknown: 0, badRequest: 1, manifestNotFound: 2, manifestContent: 3, unknownApp: 100, userDeclined: 300, methodNotSupported: 400 } as const

/** A refusal with its TON Connect code: `badRequest` (1) for a malformed or mismatched request, `methodNotSupported` (400), … */
export class TonConnectError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'TonConnectError' }
}

/** Messages per `sendTransaction` a V5R1 wallet answers by default (the `maxMessages` of the `SendTransaction` feature). */
export const TONCONNECT_MAX_MESSAGES = 4

/** Mainnet and testnet as TON Connect names them (`network`). */
export const TONCONNECT_NETWORKS = { mainnet: '-239', testnet: '-3' } as const

const bad = (message: string) => new TonConnectError(TONCONNECT_ERRORS.badRequest, message)

/** A request parameter: a JSON string (the spec's `params[0]`) or the object itself. */
function requestObject(param: unknown, what: string): Record<string, unknown> {
  let o: unknown
  try { o = typeof param === 'string' ? JSON.parse(param) : param } catch { throw bad(`${what} params[0] is not valid JSON.`) }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad(`${what} needs a request object.`)
  return o as Record<string, unknown>
}

/** Strict standard or url-safe base64 (padding optional), as TON Connect carries BoCs and binary payloads. */
export function isTonConnectBase64(s: unknown, maxLength = 1 << 20): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > maxLength) return false
  const t = s.replace(/=+$/, '')
  return /^[A-Za-z0-9+/_-]*$/.test(t) && t.length % 4 !== 1 && s.length - t.length <= 2
}

export interface TonConnectRequest {
  manifestUrl: string
  /** `ton_addr` always; `ton_proof` with the dApp's payload when asked. */
  proofPayload?: string
}

/** A `ConnectRequest`: an https manifest, `ton_addr`, and `ton_proof` with a string payload when asked. */
export function parseConnectRequest(message: unknown): TonConnectRequest {
  const m = message as { manifestUrl?: unknown; items?: unknown } | undefined
  if (!m || typeof m.manifestUrl !== 'string' || !/^https:\/\//.test(m.manifestUrl)) throw bad('ConnectRequest needs an https manifestUrl.')
  const items = Array.isArray(m.items) ? (m.items as Array<{ name?: unknown; payload?: unknown }>) : []
  if (!items.some((i) => i?.name === 'ton_addr')) throw bad('ConnectRequest must ask for ton_addr.')
  const proof = items.find((i) => i?.name === 'ton_proof')
  if (proof && typeof proof.payload !== 'string') throw bad('ton_proof needs a string payload.')
  for (const i of items) if (i?.name !== 'ton_addr' && i?.name !== 'ton_proof') throw bad(`Unknown connect item ${String(i?.name)}.`)
  return { manifestUrl: m.manifestUrl, ...(proof ? { proofPayload: proof.payload as string } : {}) }
}

/** One `sendTransaction` message, as the dApp sent it. */
export interface TonConnectMessage {
  /** Destination, as given (friendly or raw). */
  address: string
  /** Nanotons, decimal string. */
  amount: string
  /** base64 BoC body. */
  payload?: string
  /** base64 BoC state init. */
  stateInit?: string
}

export interface TonConnectSendTransaction {
  /** Unix seconds (a millisecond value is read as such and converted). */
  validUntil?: number
  network?: string
  from?: string
  messages: TonConnectMessage[]
}

export interface TonConnectParseOptions {
  /** The wallet's network (`-239` mainnet, default; `-3` testnet): a request that names another is refused. */
  network?: string
  /** The wallet's address (raw or friendly): a request whose `from` is another wallet is refused. */
  address?: string
}

export interface TonConnectSendOptions extends TonConnectParseOptions {
  /** Most messages per request (default {@link TONCONNECT_MAX_MESSAGES}). */
  maxMessages?: number
  /** Unix seconds to judge `valid_until` against (default: now). */
  now?: number
}

function checkNetworkAndFrom(o: Record<string, unknown>, options: TonConnectParseOptions): void {
  const network = options.network ?? TONCONNECT_NETWORKS.mainnet
  if (o.network !== undefined && String(o.network) !== network) throw bad(`This wallet is on network ${network}; the request names ${String(o.network)}.`)
  if (o.from !== undefined) {
    if (typeof o.from !== 'string' || tonConnectRawAddress(o.from) === null) throw bad('The request has a malformed from address.')
    if (options.address !== undefined && !sameTonConnectAddress(o.from, options.address)) throw bad('The request is for another wallet (from does not match this account).')
  }
}

/**
 * `sendTransaction` params[0] (a JSON string per the spec, or the object): at most `maxMessages`
 * messages, each with an address and a decimal nanoton amount; `network` and `from` checked
 * against the wallet when given; an expired `valid_until` refused. Structured `items` (TON Connect
 * 2.x) and extra currencies are refused as not supported. Addresses and BoCs keep the form they
 * came in: the chain package decodes and checks them before anything is signed.
 */
export function parseSendTransaction(param: unknown, options: TonConnectSendOptions = {}): TonConnectSendTransaction {
  const o = requestObject(param, 'sendTransaction')
  checkNetworkAndFrom(o, options)
  if (o.items !== undefined) throw new TonConnectError(TONCONNECT_ERRORS.methodNotSupported, 'Structured items are not supported by this wallet; send messages.')
  const raw = Array.isArray(o.messages) ? (o.messages as unknown[]) : []
  const max = options.maxMessages ?? TONCONNECT_MAX_MESSAGES
  if (raw.length === 0) throw bad('sendTransaction has no messages.')
  if (raw.length > max) throw bad(`At most ${max} messages per transaction.`)
  const messages: TonConnectMessage[] = raw.map((item, i) => {
    const m = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (typeof m.address !== 'string' || !m.address) throw bad(`Message ${i + 1} has no address.`)
    // TON Connect sends a decimal string; the Reown TON reference also allows a number (whole, within 2^53).
    const amount = typeof m.amount === 'number' && Number.isSafeInteger(m.amount) && m.amount >= 0 ? String(m.amount) : m.amount
    if (typeof amount !== 'string' || !/^[0-9]{1,40}$/.test(amount)) throw bad(`Message ${i + 1} amount must be a decimal string of nanotons.`)
    if (m.payload !== undefined && typeof m.payload !== 'string') throw bad(`Message ${i + 1} payload must be a base64 BoC.`)
    if (m.stateInit !== undefined && typeof m.stateInit !== 'string') throw bad(`Message ${i + 1} stateInit must be a base64 BoC.`)
    const extra = m.extra_currency ?? m.extraCurrency
    if (extra !== undefined && extra !== null && !(typeof extra === 'object' && Object.keys(extra).length === 0)) {
      throw new TonConnectError(TONCONNECT_ERRORS.methodNotSupported, `Message ${i + 1} carries extra currencies, which this wallet does not support.`)
    }
    return { address: m.address, amount, ...(m.payload ? { payload: m.payload } : {}), ...(m.stateInit ? { stateInit: m.stateInit } : {}) }
  })
  const given = o.valid_until ?? o.validUntil
  let validUntil: number | undefined
  if (given !== undefined) {
    if (typeof given !== 'number' || !Number.isFinite(given) || given < 0) throw bad('valid_until must be a unix timestamp.')
    // Some dApps send milliseconds.
    validUntil = Math.floor(given > 1e12 ? given / 1000 : given)
    if (validUntil < (options.now ?? Math.floor(Date.now() / 1000))) throw bad('The request has expired (valid_until is in the past).')
  }
  return { messages, ...(validUntil !== undefined ? { validUntil } : {}), ...(o.network !== undefined ? { network: String(o.network) } : {}), ...(typeof o.from === 'string' ? { from: o.from } : {}) }
}

/** Longest `signData` text (characters) or binary payload (base64 characters) accepted. */
export const TONCONNECT_SIGN_DATA_MAX = 65_536

/**
 * `signData` params[0]: text or binary only, with `network` and `from` checked against the wallet
 * when given. `cell` payloads need schema-aware rendering (an opaque cell can authorize an on-chain
 * action) and are refused as not supported (400).
 */
export function parseSignData(param: unknown, options: TonConnectParseOptions = {}): TonSignDataPayload {
  const o = requestObject(param, 'signData')
  if (o.type === 'cell') throw new TonConnectError(TONCONNECT_ERRORS.methodNotSupported, 'signData with a cell payload is not supported by this wallet.')
  checkNetworkAndFrom(o, options)
  if (o.type === 'text' && typeof o.text === 'string' && o.text.length > 0 && o.text.length <= TONCONNECT_SIGN_DATA_MAX) return { type: 'text', text: o.text }
  if (o.type === 'binary' && isTonConnectBase64(o.bytes, TONCONNECT_SIGN_DATA_MAX)) return { type: 'binary', bytes: o.bytes }
  throw bad('signData payload must be { type: "text", text } or { type: "binary", bytes } (base64).')
}

// ── addresses ───────────────────────────────────────────────────────────────

function crc16(data: Uint8Array): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/** 48 base64 / base64url characters → 36 bytes, or null. By hand: no Buffer, no atob (Hermes). */
function friendlyBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(s)) return null
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  const out = new Uint8Array(36)
  for (let i = 0, o = 0; i < 48; i += 4) {
    const n = (B64.indexOf(std[i]!) << 18) | (B64.indexOf(std[i + 1]!) << 12) | (B64.indexOf(std[i + 2]!) << 6) | B64.indexOf(std[i + 3]!)
    out[o++] = (n >> 16) & 0xff; out[o++] = (n >> 8) & 0xff; out[o++] = n & 0xff
  }
  return out
}

/**
 * Any strict TON address form → raw `wc:hex` (lowercase), or null: raw `0:<64 hex>` / `-1:<64 hex>`,
 * or a user-friendly address (EQ… / UQ… / test-only, base64 or base64url) with a valid checksum.
 */
export function tonConnectRawAddress(address: string): string | null {
  if (typeof address !== 'string') return null
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(address)
  if (raw) return `${raw[1]}:${raw[2]!.toLowerCase()}`
  const bytes = friendlyBytes(address)
  if (!bytes) return null
  const crc = crc16(bytes.subarray(0, 34))
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 0xff)) return null
  const tag = bytes[0]! & 0x7f
  if (tag !== 0x11 && tag !== 0x51) return null
  const wc = bytes[1] === 0xff ? -1 : bytes[1] === 0 ? 0 : null
  return wc === null ? null : `${wc}:${toHex(bytes.subarray(2, 34))}`
}

/** Do two addresses (any strict form) name the same account? */
export function sameTonConnectAddress(a: string, b: string): boolean {
  const x = tonConnectRawAddress(a)
  return x !== null && x === tonConnectRawAddress(b)
}

/** Raw `wc:hex` → the parts the digests bind to; throws on anything else. */
export function tonAddressParts(address: string): TonAddressParts {
  const raw = tonConnectRawAddress(address)
  if (!raw) throw new TypeError(`Not a TON address: ${address}`)
  const [wc, hex] = raw.split(':') as [string, string]
  return { workChain: Number(wc), hash: Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16)) }
}

/**
 * Raw or friendly → user-friendly url-safe (non-bounceable `UQ…` unless `bounceable`, test-only on
 * testnet), or null. WalletConnect accounts (`ton:-239:<address>`) carry this form: dApps split the
 * CAIP-10 id on its first two colons, which would cut a raw `0:…` address.
 */
export function tonConnectFriendlyAddress(address: string, options: { bounceable?: boolean; testOnly?: boolean } = {}): string | null {
  const raw = tonConnectRawAddress(address)
  if (!raw) return null
  const [wc, hex] = raw.split(':') as [string, string]
  const bytes = new Uint8Array(36)
  bytes[0] = (options.bounceable ? 0x11 : 0x51) | (options.testOnly ? 0x80 : 0)
  bytes[1] = wc === '-1' ? 0xff : 0
  bytes.set(hex.match(/../g)!.map((h) => Number.parseInt(h, 16)), 2)
  const crc = crc16(bytes.subarray(0, 34))
  bytes[34] = crc >> 8
  bytes[35] = crc & 0xff
  let out = ''
  for (let i = 0; i < 36; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_')
}
