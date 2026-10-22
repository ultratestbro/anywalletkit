/**
 * TON Connect protocol v2 — the parts that are pure data: request parsing,
 * the bytes `ton_proof` and `signData` sign, error codes. The wallet side (keys,
 * sheet, broadcast) lives in the extension; nothing here touches a key.
 *
 * ton_proof (docs.ton.org/develop/dapps/ton-connect/sign):
 *   message = sha256(0xffff ‖ "ton-connect" ‖ sha256(
 *     "ton-proof-item-v2/" ‖ workchain:int32BE ‖ address_hash:32 ‖
 *     domain_len:uint32LE ‖ domain ‖ timestamp:uint64LE ‖ payload))
 *   signature = ed25519(message)
 * signData (text | binary; `cell` payloads are refused here):
 *   message = sha256(0xffff ‖ "ton-connect/sign-data/" ‖ workchain:int32BE ‖ address_hash:32 ‖
 *     domain_len:uint32BE ‖ domain ‖ timestamp:uint64BE ‖ payload_prefix("txt"|"bin") ‖ payload_len:uint32BE ‖ payload)
 */
import { sha256 } from '@noble/hashes/sha2.js'

export const TONCONNECT_ERRORS = { unknown: 0, badRequest: 1, manifestNotFound: 2, manifestContent: 3, unknownApp: 100, userDeclined: 300, methodNotSupported: 400 } as const

export class TonConnectError extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'TonConnectError' }
}

export interface TonConnectRequest {
  manifestUrl: string
  /** `ton_addr` always; `ton_proof` with the dApp's payload when asked. */
  proofPayload?: string
}

export function parseConnectRequest(message: unknown): TonConnectRequest {
  const m = message as { manifestUrl?: unknown; items?: unknown } | undefined
  if (!m || typeof m.manifestUrl !== 'string' || !/^https:\/\//.test(m.manifestUrl)) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'ConnectRequest needs an https manifestUrl.')
  const items = Array.isArray(m.items) ? (m.items as Array<{ name?: unknown; payload?: unknown }>) : []
  if (!items.some((i) => i?.name === 'ton_addr')) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'ConnectRequest must ask for ton_addr.')
  const proof = items.find((i) => i?.name === 'ton_proof')
  if (proof && typeof proof.payload !== 'string') throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'ton_proof needs a string payload.')
  for (const i of items) if (i?.name !== 'ton_addr' && i?.name !== 'ton_proof') throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Unknown connect item ${String(i?.name)}.`)
  return { manifestUrl: m.manifestUrl, ...(proof ? { proofPayload: proof.payload as string } : {}) }
}

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
  validUntil?: number
  network?: string
  from?: string
  messages: TonConnectMessage[]
}

export const TONCONNECT_MAX_MESSAGES = 4

/** `sendTransaction` params[0] (a JSON string per the spec, or an object). */
export function parseSendTransaction(param: unknown, options: { maxMessages?: number; network?: string } = {}): TonConnectSendTransaction {
  let o: Record<string, unknown>
  try { o = (typeof param === 'string' ? JSON.parse(param) : param) as Record<string, unknown> } catch { throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'sendTransaction params[0] is not valid JSON.') }
  if (!o || typeof o !== 'object') throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'sendTransaction needs a request object.')
  const network = options.network ?? '-239'
  if (o.network !== undefined && String(o.network) !== network) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `This wallet is on network ${network}; the request names ${String(o.network)}.`)
  const raw = Array.isArray(o.messages) ? (o.messages as Array<Record<string, unknown>>) : []
  if (raw.length === 0) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'sendTransaction has no messages.')
  if (raw.length > (options.maxMessages ?? TONCONNECT_MAX_MESSAGES)) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `At most ${options.maxMessages ?? TONCONNECT_MAX_MESSAGES} messages per transaction.`)
  const messages: TonConnectMessage[] = raw.map((m, i) => {
    if (typeof m.address !== 'string' || !m.address) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Message ${i + 1} has no address.`)
    if (typeof m.amount !== 'string' || !/^[0-9]+$/.test(m.amount)) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Message ${i + 1} amount must be a decimal string of nanotons.`)
    if (m.payload !== undefined && typeof m.payload !== 'string') throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Message ${i + 1} payload must be a base64 BoC.`)
    if (m.stateInit !== undefined && typeof m.stateInit !== 'string') throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `Message ${i + 1} stateInit must be a base64 BoC.`)
    return { address: m.address, amount: m.amount, ...(m.payload ? { payload: m.payload } : {}), ...(m.stateInit ? { stateInit: m.stateInit } : {}) }
  })
  const validUntil = typeof o.valid_until === 'number' ? o.valid_until : typeof o.validUntil === 'number' ? o.validUntil : undefined
  if (validUntil !== undefined && validUntil * 1000 < Date.now()) throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'The request has expired (valid_until is in the past).')
  return { messages, ...(validUntil !== undefined ? { validUntil } : {}), ...(o.network !== undefined ? { network: String(o.network) } : {}), ...(typeof o.from === 'string' ? { from: o.from } : {}) }
}

export type TonSignDataPayload = { type: 'text'; text: string } | { type: 'binary'; bytes: string }

/** `signData` params[0]: text or binary only — `cell` payloads need schema-aware rendering and are refused by name. */
export function parseSignData(param: unknown): TonSignDataPayload {
  let o: Record<string, unknown>
  try { o = (typeof param === 'string' ? JSON.parse(param) : param) as Record<string, unknown> } catch { throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'signData params[0] is not valid JSON.') }
  if (o?.type === 'text' && typeof o.text === 'string') return { type: 'text', text: o.text }
  if (o?.type === 'binary' && typeof o.bytes === 'string') return { type: 'binary', bytes: o.bytes }
  if (o?.type === 'cell') throw new TonConnectError(TONCONNECT_ERRORS.methodNotSupported, 'signData with a cell payload is not supported by this wallet.')
  throw new TonConnectError(TONCONNECT_ERRORS.badRequest, 'signData payload must be { type: "text", text } or { type: "binary", bytes }.')
}

export interface TonAddressParts { workchain: number; hash: Uint8Array }

const utf8 = (s: string) => new TextEncoder().encode(s)
const int32BE = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, false); return b }
const uint32LE = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const uint32BE = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b }
const uint64LE = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b }
const uint64BE = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), false); return b }
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }

/** The bytes a wallet signs for `ton_proof` (already hashed — sign them raw with ed25519). */
export function tonProofMessage(input: { address: TonAddressParts; domain: string; timestamp: number; payload: string }): Uint8Array {
  if (input.address.hash.length !== 32) throw new TonConnectError(TONCONNECT_ERRORS.unknown, 'address hash must be 32 bytes')
  const domain = utf8(input.domain)
  const inner = concat(utf8('ton-proof-item-v2/'), int32BE(input.address.workchain), input.address.hash, uint32LE(domain.length), domain, uint64LE(input.timestamp), utf8(input.payload))
  return sha256(concat(new Uint8Array([0xff, 0xff]), utf8('ton-connect'), sha256(inner)))
}

/** The bytes a wallet signs for `signData` (text / binary). */
export function tonSignDataMessage(input: { address: TonAddressParts; domain: string; timestamp: number; payload: TonSignDataPayload }): Uint8Array {
  if (input.address.hash.length !== 32) throw new TonConnectError(TONCONNECT_ERRORS.unknown, 'address hash must be 32 bytes')
  const domain = utf8(input.domain)
  const payload = input.payload.type === 'text' ? utf8(input.payload.text) : Uint8Array.from(atob(input.payload.bytes), (c) => c.charCodeAt(0))
  const prefix = utf8(input.payload.type === 'text' ? 'txt' : 'bin')
  return sha256(concat(new Uint8Array([0xff, 0xff]), utf8('ton-connect/sign-data/'), int32BE(input.address.workchain), input.address.hash, uint32BE(domain.length), domain, uint64BE(input.timestamp), prefix, uint32BE(payload.length), payload))
}

/** `0:abcd…` → parts; friendly addresses are the wallet package's job (it hands us the raw form). */
export function parseRawAddress(raw: string): TonAddressParts {
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(raw)
  if (!m) throw new TonConnectError(TONCONNECT_ERRORS.unknown, `not a raw TON address: ${raw}`)
  return { workchain: Number(m[1]), hash: Uint8Array.from(m[2]!.match(/../g)!, (h) => Number.parseInt(h, 16)) }
}

/** The dApp's domain for proofs, from the page origin (host only, as the spec's `domain.value`). */
export function proofDomain(origin: string): string {
  try { return new URL(origin).host } catch { throw new TonConnectError(TONCONNECT_ERRORS.badRequest, `bad origin ${origin}`) }
}

/** Our relay errors → TON Connect error codes. */
export function tonConnectErrorCode(e: unknown): number {
  if (e instanceof TonConnectError) return e.code
  const code = (e as { code?: unknown })?.code
  if (code === 4001) return TONCONNECT_ERRORS.userDeclined
  if (code === 4100) return TONCONNECT_ERRORS.unknownApp
  if (code === 4200) return TONCONNECT_ERRORS.methodNotSupported
  if (code === -32602) return TONCONNECT_ERRORS.badRequest
  return TONCONNECT_ERRORS.unknown
}
