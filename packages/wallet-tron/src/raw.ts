/**
 * `raw_data_hex` is the only thing a Tron signature covers: `txID = sha256(raw_data_hex)`,
 * and a node that receives the transaction re-serializes from the protobuf, not from
 * the JSON next to it. So everything the wallet shows or checks before signing must be
 * read from those bytes — the JSON `raw_data` a dApp attaches is a convenience copy that
 * an attacker can make say anything (SDK-142 / C1).
 *
 * This module is a minimal protobuf codec for `protocol.Transaction.raw` and the
 * contract parameters the wallet understands (transfers, TRC-10, smart-contract calls,
 * stake v1/v2, delegation, votes, withdrawals). Anything else is surfaced as the
 * contract's name plus the raw parameter bytes, never silently described as something
 * benign. `encodeRawData` exists so tests and tools can build byte-exact fixtures.
 *
 * The reader is strict (scan F4): over-long or ≥ 2^32 tags, non-minimal varints, varints
 * over 64 bits and repeated singular fields are refused, and a contract the wallet has a
 * schema for must decode completely and re-encode to exactly its `Any.value` bytes —
 * otherwise java-tron could read the same bytes as a different transaction than the sheet.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { toHexAddress } from './address.js'
import { UnsafeTransactionError } from './errors.js'
import type { TronRawTransaction } from './types.js'

// ── wire ─────────────────────────────────────────────────────────────────────

interface Field { number: number; wire: number; value: bigint | Uint8Array }

/**
 * Bytes that a strict protobuf reader would not produce or that java-tron would read
 * differently from this codec (scan F4). The wallet refuses them rather than guess:
 * protobuf-java keeps only the low 32 bits of an over-long tag, so a field this codec
 * would call "unknown 536870916" is `data` to the node.
 */
export class NonCanonicalError extends Error {
  constructor(message: string) { super(message); this.name = 'NonCanonicalError' }
}

/** Longest varint: 10 bytes (64 bits). Tags: 5 bytes and below 2^32, as protobuf-java reads them. */
const MAX_VARINT_BYTES = 10
const MAX_TAG_BYTES = 5

function readVarint(bytes: Uint8Array, at: number, what: 'tag' | 'value' | 'length' = 'value'): { value: bigint; next: number } {
  const max = what === 'tag' ? MAX_TAG_BYTES : MAX_VARINT_BYTES
  let shift = 0n
  let value = 0n
  let i = at
  for (;;) {
    if (i >= bytes.length) throw new Error('truncated varint')
    const b = bytes[i++]!
    const n = i - at
    value |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) {
      // A trailing 0x00 adds nothing: the same number has a shorter encoding.
      if (n > 1 && b === 0) throw new NonCanonicalError(`non-minimal ${what} varint`)
      // 10th byte carries bit 63 only (0x01 = a negative int64); anything more is over 64 bits.
      if (n === MAX_VARINT_BYTES && b > 1) throw new NonCanonicalError(`${what} varint exceeds 64 bits`)
      if (what === 'tag' && value >= 1n << 32n) throw new NonCanonicalError('tag exceeds 32 bits')
      return { value, next: i }
    }
    if (n >= max) throw new NonCanonicalError(`${what} varint longer than ${max} bytes`)
    shift += 7n
  }
}

/** Every top-level field of a protobuf message, in wire order. Throws on malformed or non-canonical input. */
export function readFields(bytes: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < bytes.length) {
    const tag = readVarint(bytes, i, 'tag')
    i = tag.next
    const number = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (number === 0) throw new Error('field 0')
    switch (wire) {
      case 0: { const v = readVarint(bytes, i); i = v.next; out.push({ number, wire, value: v.value }); break }
      case 1: { if (i + 8 > bytes.length) throw new Error('truncated fixed64'); out.push({ number, wire, value: bytes.subarray(i, i + 8) }); i += 8; break }
      case 2: {
        const len = readVarint(bytes, i, 'length')
        const start = len.next
        if (len.value > BigInt(bytes.length - start)) throw new Error('truncated length-delimited field')
        const end = start + Number(len.value)
        out.push({ number, wire, value: bytes.subarray(start, end) })
        i = end
        break
      }
      case 5: { if (i + 4 > bytes.length) throw new Error('truncated fixed32'); out.push({ number, wire, value: bytes.subarray(i, i + 4) }); i += 4; break }
      default: throw new Error(`unsupported wire type ${wire}`)
    }
  }
  return out
}

/**
 * A singular field that appears twice is "last one wins" to java-tron and possibly
 * "first one wins" to a reader — refuse. Only fields known to be singular are checked;
 * repeated ones (`raw.auths`, `raw.contract`, `VoteWitness.votes` …) may repeat.
 */
function assertSingular(fields: Field[], singular: Iterable<number>, what: string): void {
  const want = new Set(singular)
  const seen = new Set<number>()
  for (const f of fields) {
    if (!want.has(f.number)) continue
    if (seen.has(f.number)) throw new NonCanonicalError(`${what}: field ${f.number} appears more than once`)
    seen.add(f.number)
  }
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

function encodeVarint(n: bigint): number[] {
  if (n < 0n) n = (1n << 64n) + n
  const out: number[] = []
  do {
    let b = Number(n & 0x7fn)
    n >>= 7n
    if (n !== 0n) b |= 0x80
    out.push(b)
  } while (n !== 0n)
  return out
}

const tagOf = (number: number, wire: number) => encodeVarint(BigInt((number << 3) | wire))
const fieldVarint = (number: number, v: bigint): number[] => [...tagOf(number, 0), ...encodeVarint(v)]
const fieldBytes = (number: number, v: Uint8Array): number[] => [...tagOf(number, 2), ...encodeVarint(BigInt(v.length)), ...v]

// ── schema ───────────────────────────────────────────────────────────────────

/** `protocol.Transaction.Contract.ContractType`. */
export const CONTRACT_TYPES: Record<number, string> = {
  0: 'AccountCreateContract', 1: 'TransferContract', 2: 'TransferAssetContract', 3: 'VoteAssetContract', 4: 'VoteWitnessContract',
  5: 'WitnessCreateContract', 6: 'AssetIssueContract', 8: 'WitnessUpdateContract', 9: 'ParticipateAssetIssueContract',
  10: 'AccountUpdateContract', 11: 'FreezeBalanceContract', 12: 'UnfreezeBalanceContract', 13: 'WithdrawBalanceContract',
  14: 'UnfreezeAssetContract', 15: 'UpdateAssetContract', 16: 'ProposalCreateContract', 17: 'ProposalApproveContract',
  18: 'ProposalDeleteContract', 19: 'SetAccountIdContract', 20: 'CustomContract', 30: 'CreateSmartContract',
  31: 'TriggerSmartContract', 32: 'GetContract', 33: 'UpdateSettingContract', 41: 'ExchangeCreateContract',
  42: 'ExchangeInjectContract', 43: 'ExchangeWithdrawContract', 44: 'ExchangeTransactionContract', 45: 'UpdateEnergyLimitContract',
  46: 'AccountPermissionUpdateContract', 48: 'ClearABIContract', 49: 'UpdateBrokerageContract', 51: 'ShieldedTransferContract',
  52: 'MarketSellAssetContract', 53: 'MarketCancelOrderContract', 54: 'FreezeBalanceV2Contract', 55: 'UnfreezeBalanceV2Contract',
  56: 'WithdrawExpireUnfreezeContract', 57: 'DelegateResourceContract', 58: 'UnDelegateResourceContract', 59: 'CancelAllUnfreezeV2Contract',
}
const CONTRACT_ENUM: Record<string, number> = Object.fromEntries(Object.entries(CONTRACT_TYPES).map(([n, name]) => [name, Number(n)]))
const TYPE_URL_PREFIX = 'type.googleapis.com/protocol.'

type Kind = 'address' | 'bytes' | 'int' | 'bool' | 'resource' | 'string'
type Schema = Record<number, [name: string, kind: Kind]>

const RESOURCES = ['BANDWIDTH', 'ENERGY', 'TRON_POWER'] as const

/**
 * Parameter messages the wallet can describe field by field. `owner_address` is field 1
 * in every system contract, which is also what the generic fallback relies on.
 */
const PARAMETERS: Record<string, Schema> = {
  TransferContract: { 1: ['owner_address', 'address'], 2: ['to_address', 'address'], 3: ['amount', 'int'] },
  TransferAssetContract: { 1: ['asset_name', 'bytes'], 2: ['owner_address', 'address'], 3: ['to_address', 'address'], 4: ['amount', 'int'] },
  TriggerSmartContract: { 1: ['owner_address', 'address'], 2: ['contract_address', 'address'], 3: ['call_value', 'int'], 4: ['data', 'bytes'], 5: ['call_token_value', 'int'], 6: ['token_id', 'int'] },
  FreezeBalanceV2Contract: { 1: ['owner_address', 'address'], 2: ['frozen_balance', 'int'], 3: ['resource', 'resource'] },
  UnfreezeBalanceV2Contract: { 1: ['owner_address', 'address'], 2: ['unfreeze_balance', 'int'], 3: ['resource', 'resource'] },
  FreezeBalanceContract: { 1: ['owner_address', 'address'], 2: ['frozen_balance', 'int'], 3: ['frozen_duration', 'int'], 10: ['resource', 'resource'], 15: ['receiver_address', 'address'] },
  UnfreezeBalanceContract: { 1: ['owner_address', 'address'], 10: ['resource', 'resource'], 15: ['receiver_address', 'address'] },
  WithdrawBalanceContract: { 1: ['owner_address', 'address'] },
  WithdrawExpireUnfreezeContract: { 1: ['owner_address', 'address'] },
  CancelAllUnfreezeV2Contract: { 1: ['owner_address', 'address'] },
  DelegateResourceContract: { 1: ['owner_address', 'address'], 2: ['resource', 'resource'], 3: ['balance', 'int'], 4: ['receiver_address', 'address'], 5: ['lock', 'bool'], 6: ['lock_period', 'int'] },
  UnDelegateResourceContract: { 1: ['owner_address', 'address'], 2: ['resource', 'resource'], 3: ['balance', 'int'], 4: ['receiver_address', 'address'] },
}

/** One decoded `Transaction.Contract`. `value` has the node's JSON keys (hex addresses, hex bytes, numbers as JSON numbers or decimal strings). */
export interface TronDecodedContract {
  type: string
  parameter: { value: Record<string, unknown>; type_url: string }
  Permission_id?: number
  /** Field numbers inside the parameter the wallet has no schema for (or the whole parameter when the type is unknown). */
  undecoded: number[]
}

export interface TronDecodedRaw {
  raw_data: Omit<TronRawTransaction['raw_data'], 'contract'> & { contract: TronDecodedContract[]; ref_block_num?: number }
  /** Top-level `Transaction.raw` field numbers this codec does not know. */
  unknownFields: number[]
}

/** int64 on the wire is two's complement: a 10-byte varint with bit 63 set is negative. */
const signed = (v: bigint): bigint => (v >= 1n << 63n ? v - (1n << 64n) : v)
/** JSON-shaped integer: a number while exact, else a decimal string (the node's JSON does the same). */
const int = (v: bigint): number | string => { const s = signed(v); return s <= BigInt(Number.MAX_SAFE_INTEGER) && s >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(s) : s.toString() }
/** Number via the decimal string: Hermes mis-converts Number(bigint) at and above 2^63. */
const num = (v: bigint): number => Number(signed(v).toString())
const asBytes = (f: Field, what: string): Uint8Array => { if (!(f.value instanceof Uint8Array) || f.wire !== 2) throw new Error(`${what}: expected bytes`); return f.value }
const asInt = (f: Field, what: string): bigint => { if (typeof f.value !== 'bigint') throw new Error(`${what}: expected varint`); return f.value }

function decodeParameter(type: string, bytes: Uint8Array): { value: Record<string, unknown>; undecoded: number[] } {
  const schema = PARAMETERS[type]
  const value: Record<string, unknown> = {}
  const undecoded: number[] = []
  const fields = readFields(bytes)
  if (!schema) {
    // Generic: field 1 is owner_address in every system contract; keep the rest as bytes for the sheet.
    const owner = fields.find((f) => f.number === 1 && f.wire === 2 && (f.value as Uint8Array).length === 21 && (f.value as Uint8Array)[0] === 0x41)
    if (owner) value.owner_address = bytesToHex(owner.value as Uint8Array)
    value.raw_parameter_hex = bytesToHex(bytes)
    return { value, undecoded: [...new Set(fields.filter((f) => f !== owner).map((f) => f.number))] }
  }
  assertSingular(fields, Object.keys(schema).map(Number), type)
  for (const f of fields) {
    const entry = schema[f.number]
    if (!entry) { undecoded.push(f.number); continue }
    const [name, kind] = entry
    const what = `${type}.${name}`
    switch (kind) {
      case 'address': { const b = asBytes(f, what); if (b.length !== 21 || b[0] !== 0x41) throw new Error(`${what}: not a Tron address`); value[name] = bytesToHex(b); break }
      case 'bytes': value[name] = bytesToHex(asBytes(f, what)); break
      case 'string': value[name] = new TextDecoder().decode(asBytes(f, what)); break
      case 'int': value[name] = int(asInt(f, what)); break
      case 'bool': value[name] = asInt(f, what) !== 0n; break
      case 'resource': { const r = num(asInt(f, what)); value[name] = RESOURCES[r] ?? `RESOURCE_${r}`; break }
    }
  }
  return { value, undecoded: [...new Set(undecoded)] }
}

/** `Transaction.Contract` fields: type 1, parameter 2, provider 3, ContractName 4, Permission_id 5 — all singular. */
const CONTRACT_FIELDS = [1, 2, 3, 4, 5]

function decodeContract(bytes: Uint8Array): TronDecodedContract {
  let enumType: number | undefined
  let typeUrl: string | undefined
  let parameter: Uint8Array | undefined
  let permissionId: number | undefined
  const fields = readFields(bytes)
  assertSingular(fields, CONTRACT_FIELDS, 'Contract')
  for (const f of fields) {
    switch (f.number) {
      case 1: enumType = num(asInt(f, 'Contract.type')); break
      case 2: {
        const any = readFields(asBytes(f, 'Contract.parameter'))
        assertSingular(any, [1, 2], 'Contract.parameter')
        for (const a of any) {
          if (a.number === 1) typeUrl = new TextDecoder().decode(asBytes(a, 'Any.type_url'))
          else if (a.number === 2) parameter = asBytes(a, 'Any.value')
          else throw new Error(`Contract.parameter: unknown Any field ${a.number}`)
        }
        break
      }
      case 5: permissionId = num(asInt(f, 'Contract.Permission_id')); break
      case 3: case 4: break // provider, ContractName: informational
      default: throw new Error(`Contract: unknown field ${f.number}`)
    }
  }
  const fromUrl = typeUrl?.startsWith(TYPE_URL_PREFIX) ? typeUrl.slice(TYPE_URL_PREFIX.length) : undefined
  const fromEnum = enumType !== undefined ? CONTRACT_TYPES[enumType] : undefined
  if (fromUrl && fromEnum && fromUrl !== fromEnum) throw new Error(`contract type_url ${fromUrl} disagrees with type ${fromEnum}`)
  const type = fromUrl ?? fromEnum ?? (enumType !== undefined ? `Unknown(${enumType})` : typeUrl ?? 'Unknown')
  const paramBytes = parameter ?? new Uint8Array()
  const { value, undecoded } = decodeParameter(type, paramBytes)
  if (PARAMETERS[type]) {
    // A contract the wallet decodes is decoded completely and exactly, or not at all:
    // an unknown field could be anything to the node, and bytes that do not re-encode to
    // themselves are bytes java-tron may read differently from this codec (scan F4).
    if (undecoded.length) throw new Error(`${type}: field(s) ${undecoded.join(', ')} are not part of the contract`)
    if (!equalBytes(encodeParameter(type, value), paramBytes)) throw new NonCanonicalError(`${type}: parameter bytes are not the canonical encoding of what they decode to`)
  }
  const out: TronDecodedContract = { type, parameter: { value, type_url: typeUrl ?? `${TYPE_URL_PREFIX}${type}` }, undecoded }
  if (permissionId !== undefined) out.Permission_id = permissionId
  return out
}

/** Whether the wallet decodes this contract type field by field (otherwise only its owner and raw bytes are known). */
export function isDecodedContractType(type: string): boolean {
  return PARAMETERS[type] !== undefined
}

/** `Transaction.raw` fields that may appear at most once (auths 9 and contract 11 are repeated). */
const RAW_SINGULAR = [1, 3, 4, 8, 10, 12, 14, 18]

/** Decode `Transaction.raw` bytes (or hex). Throws a plain `Error` on malformed input; callers wrap it. */
export function decodeRawData(raw: Uint8Array | string): TronDecodedRaw {
  const bytes = typeof raw === 'string' ? hexToBytes(raw.replace(/^0x/, '')) : raw
  const data: TronDecodedRaw['raw_data'] = { contract: [] }
  const unknown: number[] = []
  const fields = readFields(bytes)
  assertSingular(fields, RAW_SINGULAR, 'Transaction.raw')
  for (const f of fields) {
    switch (f.number) {
      case 1: data.ref_block_bytes = bytesToHex(asBytes(f, 'ref_block_bytes')); break
      case 3: data.ref_block_num = num(asInt(f, 'ref_block_num')); break
      case 4: data.ref_block_hash = bytesToHex(asBytes(f, 'ref_block_hash')); break
      case 8: data.expiration = num(asInt(f, 'expiration')); break
      case 10: data.data = bytesToHex(asBytes(f, 'data')); break
      case 11: data.contract.push(decodeContract(asBytes(f, 'contract'))); break
      case 14: data.timestamp = num(asInt(f, 'timestamp')); break
      case 18: data.fee_limit = num(asInt(f, 'fee_limit')); break
      case 9: case 12: break // auths, scripts: carried by the node, nothing the wallet acts on
      default: unknown.push(f.number)
    }
  }
  return { raw_data: data, unknownFields: [...new Set(unknown)] }
}

// ── encode (fixtures, tooling) ───────────────────────────────────────────────

function encodeParameter(type: string, value: Record<string, unknown>): Uint8Array {
  const schema = PARAMETERS[type]
  if (!schema) {
    const hex = value.raw_parameter_hex
    if (typeof hex === 'string') return hexToBytes(hex)
    // No schema: the one field every system contract shares. Enough for fixtures of unknown types.
    return typeof value.owner_address === 'string' ? Uint8Array.from(fieldBytes(1, hexToBytes(toHexAddress(value.owner_address)))) : new Uint8Array()
  }
  const out: number[] = []
  for (const number of Object.keys(schema).map(Number).sort((a, b) => a - b)) {
    const [name, kind] = schema[number]!
    const v = value[name]
    if (v === undefined || v === null) continue
    switch (kind) {
      case 'address': out.push(...fieldBytes(number, hexToBytes(toHexAddress(String(v))))); break
      case 'bytes': out.push(...fieldBytes(number, hexToBytes(String(v).replace(/^0x/, '')))); break
      case 'string': out.push(...fieldBytes(number, new TextEncoder().encode(String(v)))); break
      case 'int': { const n = BigInt(v as number | string | bigint); if (n !== 0n) out.push(...fieldVarint(number, n)); break }
      case 'bool': if (v) out.push(...fieldVarint(number, 1n)); break
      case 'resource': { const r = typeof v === 'number' ? v : RESOURCES.indexOf(v as typeof RESOURCES[number]); if (r < 0) throw new Error(`unknown resource ${String(v)}`); if (r !== 0) out.push(...fieldVarint(number, BigInt(r))); break }
    }
  }
  return Uint8Array.from(out)
}

/**
 * Serialize a `raw_data` object the way java-tron does (fields in number order, proto3
 * defaults omitted). Round-trips with {@link decodeRawData}; `sha256` of the result is the txID.
 */
export function encodeRawData(raw: TronRawTransaction['raw_data'] & { ref_block_num?: number }): Uint8Array {
  const out: number[] = []
  if (raw.ref_block_bytes) out.push(...fieldBytes(1, hexToBytes(raw.ref_block_bytes)))
  if (raw.ref_block_num) out.push(...fieldVarint(3, BigInt(raw.ref_block_num)))
  if (raw.ref_block_hash) out.push(...fieldBytes(4, hexToBytes(raw.ref_block_hash)))
  if (raw.expiration) out.push(...fieldVarint(8, BigInt(raw.expiration)))
  if (raw.data) out.push(...fieldBytes(10, hexToBytes(raw.data)))
  for (const c of raw.contract ?? []) {
    const type = c.type
    const enumType = CONTRACT_ENUM[type]
    const typeUrl = c.parameter.type_url ?? `${TYPE_URL_PREFIX}${type}`
    const any = Uint8Array.from([...fieldBytes(1, new TextEncoder().encode(typeUrl)), ...fieldBytes(2, encodeParameter(type, c.parameter.value))])
    const contract: number[] = []
    if (enumType !== undefined && enumType !== 0) contract.push(...fieldVarint(1, BigInt(enumType)))
    contract.push(...fieldBytes(2, any))
    const pid = (c as { Permission_id?: number }).Permission_id
    if (pid) contract.push(...fieldVarint(5, BigInt(pid)))
    out.push(...fieldBytes(11, Uint8Array.from(contract)))
  }
  if (raw.timestamp) out.push(...fieldVarint(14, BigInt(raw.timestamp)))
  if (raw.fee_limit) out.push(...fieldVarint(18, BigInt(raw.fee_limit)))
  return Uint8Array.from(out)
}

// ── verification ─────────────────────────────────────────────────────────────

export interface VerifiedRaw extends TronDecodedRaw {
  /** The bytes that get hashed and signed. */
  bytes: Uint8Array
  /** Lowercase hex sha256 of `bytes` (= the txID the signature is over). */
  txID: string
}

const norm = (key: string, v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'boolean') return v ? '1' : ''
  if (typeof v === 'bigint' || typeof v === 'number') return v === 0 || v === 0n ? '' : v.toString()
  const s = String(v)
  if (key.endsWith('_address')) { try { return toHexAddress(s) } catch { return s.toLowerCase() } }
  if (/^\d+$/.test(s)) return s === '0' ? '' : s
  return s.replace(/^0x/, '').toLowerCase()
}

/** First material difference between the dApp's JSON `raw_data` and what the bytes say, or `null`. */
export function rawMismatch(json: TronRawTransaction['raw_data'] | undefined, decoded: TronDecodedRaw['raw_data']): string | null {
  if (!json) return null
  const top: Array<keyof TronRawTransaction['raw_data']> = ['ref_block_bytes', 'ref_block_hash', 'expiration', 'timestamp', 'fee_limit', 'data']
  for (const k of top) if (norm(k, json[k]) !== norm(k, decoded[k])) return `raw_data.${k}: JSON says ${JSON.stringify(json[k] ?? null)}, bytes say ${JSON.stringify(decoded[k] ?? null)}`
  const jc = json.contract ?? []
  if (jc.length !== decoded.contract.length) return `raw_data.contract: JSON lists ${jc.length} contract(s), bytes carry ${decoded.contract.length}`
  for (let i = 0; i < jc.length; i++) {
    const a = jc[i]!
    const b = decoded.contract[i]!
    if (a.type !== b.type) return `contract[${i}].type: JSON says ${a.type}, bytes say ${b.type}`
    const av = (a.parameter?.value ?? {}) as Record<string, unknown>
    const bv = b.parameter.value
    // A type without a schema has no decoded counterpart for its JSON keys (votes, account_address …):
    // only the owner is read from the bytes. Its other keys are neither compared nor shown — the
    // description says the type is not decoded — so a JSON copy cannot make the sheet say anything.
    const hasSchema = isDecodedContractType(b.type)
    for (const key of new Set([...Object.keys(av), ...Object.keys(bv)])) {
      if (key === 'raw_parameter_hex') continue
      if (!hasSchema && key !== 'owner_address') continue
      if (norm(key, av[key]) !== norm(key, bv[key])) return `contract[${i}].${key}: JSON says ${JSON.stringify(av[key] ?? null)}, bytes say ${JSON.stringify(bv[key] ?? null)}`
    }
  }
  return null
}

/**
 * Everything that must hold before a prebuilt transaction is signed or shown:
 * `raw_data_hex` present and well-formed, `txID == sha256(raw_data_hex)`, and the
 * JSON copy (when there is one) agreeing with the bytes field by field. Returns the
 * decoded bytes; the description and the hard checks run on that, never on the JSON.
 */
export function verifyRawTransaction(tx: TronRawTransaction): VerifiedRaw {
  const hex = typeof tx.raw_data_hex === 'string' ? tx.raw_data_hex.replace(/^0x/, '') : ''
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) throw new UnsafeTransactionError('raw-undecodable', 'The transaction has no raw_data_hex; a Tron signature covers those bytes, so nothing else can be signed.')
  const bytes = hexToBytes(hex)
  const txID = bytesToHex(sha256(bytes))
  if (typeof tx.txID !== 'string' || tx.txID.replace(/^0x/, '').toLowerCase() !== txID) {
    throw new UnsafeTransactionError('txid-mismatch', `txID ${String(tx.txID)} is not sha256(raw_data_hex) (${txID}); refusing to sign a hash that does not belong to these bytes.`)
  }
  let decoded: TronDecodedRaw
  try {
    decoded = decodeRawData(bytes)
  } catch (e) {
    if (e instanceof NonCanonicalError) throw new UnsafeTransactionError('raw-noncanonical', `raw_data_hex is not the canonical encoding of a Transaction.raw (${e.message}); the node could read these bytes differently from the wallet, so they are not signed.`)
    throw new UnsafeTransactionError('raw-undecodable', `raw_data_hex is not a well-formed Transaction.raw (${(e as Error).message}); refusing to sign what cannot be read.`)
  }
  const mismatch = rawMismatch(tx.raw_data, decoded.raw_data)
  if (mismatch) throw new UnsafeTransactionError('raw-mismatch', `The transaction's JSON does not match the bytes that would be signed — ${mismatch}.`)
  return { ...decoded, bytes, txID }
}

