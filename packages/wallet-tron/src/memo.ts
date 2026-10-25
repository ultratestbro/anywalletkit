import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { UnsafeTransactionError } from './errors.js'
import type { TronRawTransaction } from './types.js'

/**
 * Memo = `Transaction.raw.data` (protobuf field 10, bytes). The full node builds
 * `raw_data_hex` for us; we splice the field in ourselves rather than re-encoding
 * the contracts.
 *
 * Where it goes matters: java-tron recomputes `txID` as sha256 of the raw_data it
 * re-serializes from the parsed message, and protobuf-java writes fields in
 * field-number order. A memo appended after `contract` (field 11) would therefore
 * hash differently on the node than what we signed. So the record is inserted at
 * its canonical position — after every field numbered ≤ 10, before the first > 10
 * (ref_block_bytes 1 … expiration 8, auths 9, DATA 10, contract 11, scripts 12,
 * timestamp 14, fee_limit 18). The JSON we broadcast carries the same bytes as
 * `raw_data.data` (hex), the way tronweb's `addUpdateData` does.
 */
export const MEMO_FIELD = 10
/** Upper bound we enforce on a memo (UTF-8 bytes). java-tron bounds only the whole transaction (500 KB); 512 keeps memos cheap and sane. */
export const MAX_MEMO_BYTES = 512

interface Record_ { field: number; start: number; end: number }

/** Walk a protobuf message's top-level records. Throws on anything malformed. */
function walkRecords(bytes: Uint8Array): Record_[] {
  const out: Record_[] = []
  let i = 0
  const varint = (): bigint => {
    let shift = 0n
    let v = 0n
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated varint')
      const b = bytes[i++]!
      v |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return v
      shift += 7n
      if (shift > 63n) throw new Error('varint too long')
    }
  }
  while (i < bytes.length) {
    const start = i
    const tag = varint()
    if (tag >> 3n > 0x1fffffffn) throw new Error('field number out of range') // protobuf: at most 2^29 − 1
    const field = Number((tag >> 3n).toString())
    const wire = Number(tag & 7n)
    if (field === 0) throw new Error('field 0')
    switch (wire) {
      case 0: varint(); break
      case 1: i += 8; break
      case 2: { const len = varint(); if (len > BigInt(bytes.length - i)) throw new Error('truncated length-delimited field'); i += Number(len.toString()); break }
      case 5: i += 4; break
      default: throw new Error(`unsupported wire type ${wire}`)
    }
    if (i > bytes.length) throw new Error('truncated record')
    out.push({ field, start, end: i })
  }
  return out
}

function encodeVarint(n: number): number[] {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n !== 0) b |= 0x80
    out.push(b)
  } while (n !== 0)
  return out
}

/**
 * How a memo string becomes `raw_data.data` bytes: 'utf8' (a text memo — THORChain, exchanges) or 'hex' (binary
 * payloads — a Chainflip vault swap's SCALE-encoded note, given as 0x-hex).
 */
export type MemoEncoding = 'utf8' | 'hex'

/**
 * Bytes of a memo, from UTF-8 text or `0x` hex.
 *
 * @throws `UnsafeTransactionError` `memo` for invalid hex.
 */
export function memoBytes(memo: string, encoding: MemoEncoding = 'utf8'): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(memo)
  const h = memo.startsWith('0x') ? memo.slice(2) : memo
  if (!h || h.length % 2 || /[^0-9a-f]/i.test(h)) throw new UnsafeTransactionError('memo', 'A hex memo must be non-empty, even-length hex.')
  return hexToBytes(h.toLowerCase())
}

/** The wire bytes of a memo record: tag (field 10, length-delimited = 0x52) ‖ varint(len) ‖ the memo bytes. */
export function encodeMemoRecord(memo: string, encoding: MemoEncoding = 'utf8'): Uint8Array {
  const bytes = memoBytes(memo, encoding)
  if (bytes.length === 0) throw new UnsafeTransactionError('memo', 'A memo must not be empty.')
  if (bytes.length > MAX_MEMO_BYTES) throw new UnsafeTransactionError('memo', `Memo is ${bytes.length} bytes; the limit is ${MAX_MEMO_BYTES}.`)
  return Uint8Array.from([(MEMO_FIELD << 3) | 2, ...encodeVarint(bytes.length), ...bytes])
}

/**
 * Splice `memo` into a node-built transaction: canonical-position `raw_data` field 10,
 * fresh `txID` = sha256(raw_data), and `raw_data.data` (hex) for the JSON broadcast.
 * A transaction that already carries a memo is refused (the node's own `data` would
 * have to be re-signed anyway and we cannot know which the caller meant).
 */
export function attachMemo(tx: TronRawTransaction, memo: string, encoding: MemoEncoding = 'utf8'): TronRawTransaction {
  if (tx.raw_data?.data) throw new UnsafeTransactionError('memo', 'The transaction already carries a memo (raw_data.data).')
  if (tx.signature?.length) throw new UnsafeTransactionError('memo', 'Cannot attach a memo to an already signed transaction.')
  const raw = hexToBytes(tx.raw_data_hex)
  let records: Record_[]
  try {
    records = walkRecords(raw)
  } catch (e) {
    throw new UnsafeTransactionError('memo', `raw_data_hex is not a well-formed protobuf message (${(e as Error).message}); refusing to attach a memo.`)
  }
  if (records.some((r) => r.field === MEMO_FIELD)) throw new UnsafeTransactionError('memo', 'raw_data_hex already contains field 10 (data).')
  const record = encodeMemoRecord(memo, encoding)
  const after = records.find((r) => r.field > MEMO_FIELD)
  const at = after ? after.start : raw.length
  const out = new Uint8Array(raw.length + record.length)
  out.set(raw.subarray(0, at), 0)
  out.set(record, at)
  out.set(raw.subarray(at), at + record.length)
  return {
    ...tx,
    txID: bytesToHex(sha256(out)),
    raw_data_hex: bytesToHex(out),
    raw_data: { ...tx.raw_data, data: bytesToHex(memoBytes(memo, encoding)) },
  }
}
