import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { encodeRawData, selector, toHexAddress, type TronFetch, type TronRawTransaction } from '../src/index.js'

export const NOW = 1_800_000_000_000
export const RECIPIENT = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK' // account 1 — "new" account in the fake node
/** The fake chain's head block (its low 16 bits are a1b2) and the hash part of its block ids. */
export const HEAD_BLOCK = 0x3fa1b2
export const REF_BLOCK_HASH = '0011223344556677'

/**
 * Fake full node. raw_data_hex is real protobuf (encodeRawData) padded towards real sizes (134 raw bytes
 * for a TRX transfer, 211 for a TRC-20 transfer; a byte more when the padding record cannot fit exactly); txID = sha256(raw_data_hex).
 */
/** `txID` + `raw_data_hex` from a `raw_data` object; `rawBytes` pads with field 12 (`scripts`) when the encoding is shorter. */
export function seal(raw_data: TronRawTransaction['raw_data'], rawBytes = 0, nonce = 0, padWith: 'scripts' | 'ref_block_num' = 'scripts'): TronRawTransaction {
  let hex = bytesToHex(encodeRawData(raw_data))
  const short = rawBytes - hex.length / 2
  if (padWith === 'ref_block_num' && short >= 1 && short <= 11) {
    // A node build may carry ref_block_num (field 3) but never scripts (12): pad with a varint of the right
    // length (a record is at least 2 bytes, so a 1-byte gap becomes 2). Spliced after ref_block_bytes
    // (field 1) to keep java-tron field order.
    const pad = Math.max(short, 2)
    const v = (1n << BigInt(7 * (pad - 2))) + BigInt(nonce)
    const bytes: number[] = []
    let x = v
    do { let b = Number(x & 0x7fn); x >>= 7n; if (x) b |= 0x80; bytes.push(b) } while (x)
    if (bytes.length !== pad - 1) throw new Error('padding does not fit')
    const at = hex.startsWith('0a') ? 4 + parseInt(hex.slice(2, 4), 16) * 2 : 0
    hex = hex.slice(0, at) + '18' + bytesToHex(Uint8Array.from(bytes)) + hex.slice(at)
  } else if (short >= 2) hex += '62' + (short - 2).toString(16).padStart(2, '0') + nonce.toString(16).padStart(4, '0').padEnd((short - 2) * 2, '0').slice(0, (short - 2) * 2)
  else if (short === 1) hex += '6200'
  return { txID: bytesToHex(sha256(hexToBytes(hex))), raw_data_hex: hex, visible: false, raw_data }
}

export function fakeNode(overrides: Record<string, (body: Record<string, unknown>) => unknown> = {}, opts: { resources?: Record<string, number>; params?: Array<{ key: string; value: number }> } = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const broadcast: TronRawTransaction[] = []
  let n = 0
  // Real protobuf bytes (what a node returns), padded with a `scripts` (field 12) record to the target size when that is possible.
  const rawTx = (type: string, value: Record<string, unknown>, rawBytes: number, extra: Record<string, unknown> = {}): TronRawTransaction => {
    const raw_data: TronRawTransaction['raw_data'] = { contract: [{ type, parameter: { value, type_url: `type.googleapis.com/protocol.${type}` } }], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW, ...extra }
    return seal(raw_data, rawBytes, ++n, 'ref_block_num')
  }
  const handlers: Record<string, (body: Record<string, unknown>) => unknown> = {
    '/wallet/createtransaction': (b) => rawTx('TransferContract', { owner_address: b.owner_address, to_address: b.to_address, amount: b.amount }, 134),
    '/wallet/triggersmartcontract': (b) => ({ result: { result: true }, transaction: rawTx('TriggerSmartContract', { owner_address: b.owner_address, contract_address: b.contract_address, data: selector(String(b.function_selector)) + b.parameter }, 211, { fee_limit: b.fee_limit }) }),
    '/wallet/triggerconstantcontract': (b) => ({ result: { result: true }, energy_used: 30_000, constant_result: ['0'.repeat(63) + '5'], transaction: rawTx('TriggerSmartContract', { owner_address: b.owner_address, contract_address: b.contract_address, data: b.data ?? '' }, 211) }),
    '/wallet/getaccount': (b) => (b.address === toHexAddress(RECIPIENT) ? {} : { address: b.address, balance: 5_000_000 }),
    '/wallet/getaccountresource': () => ({ freeNetLimit: 600, freeNetUsed: 0, EnergyLimit: 0, EnergyUsed: 0, ...opts.resources }),
    '/wallet/getchainparameters': () => ({ chainParameter: [{ key: 'getTransactionFee', value: 1000 }, { key: 'getEnergyFee', value: 210 }, { key: 'getMemoFee', value: 1_000_000 }, { key: 'getCreateAccountFee', value: 100_000 }, { key: 'getCreateNewAccountFeeInSystemContract', value: 1_000_000 }, ...(opts.params ?? [])] }),
    '/wallet/broadcasttransaction': (b) => { broadcast.push(b as unknown as TronRawTransaction); return { result: true, txid: b.txID } },
    '/wallet/gettransactioninfobyid': () => ({}),
    // The fake chain: its head's low 16 bits are the a1b2 every build references, and every block id
    // carries 0011223344556677 at bytes 8..16 (the ref_block_hash of those builds).
    '/wallet/getnowblock': () => ({ block_header: { raw_data: { number: HEAD_BLOCK } } }),
    '/wallet/getblockbynum': (b) => ({ blockID: Number(b.num).toString(16).padStart(16, '0') + REF_BLOCK_HASH + '0'.repeat(32) }),
    ...overrides,
  }
  const fetch: TronFetch = async (path, body) => { const b = body as Record<string, unknown>; calls.push({ path, body: b }); const h = handlers[path]; if (!h) throw new Error(`unmocked ${path}`); return h(b) }
  return { fetch, calls, broadcast, paths: () => calls.map((c) => c.path), rawTx }
}

