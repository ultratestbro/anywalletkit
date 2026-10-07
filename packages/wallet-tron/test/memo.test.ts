import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  MAX_MEMO_BYTES, UnsafeTransactionError, WalletManagerTron, attachMemo, bandwidthPoints, describeTransaction, encodeMemoRecord, selector,
  toHexAddress, type TronFetch, type TronRawTransaction,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EXISTING = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const NOW = 1_800_000_000_000
const utf8hex = (s: string) => bytesToHex(new TextEncoder().encode(s))

const withNow = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
}

// ── A well-formed raw_data (top-level protobuf records in java-tron's field order) ──
const F = {
  refBlockBytes: '0a02a1b2',                       // 1, bytes
  refBlockHash: '22080011223344556677',           // 4, bytes
  expiration: '40' + '80e4b7ea8fd4a4' + '03',      // 8, varint (value irrelevant to the walker)
  contract: '5a' + '10' + 'ab'.repeat(16),         // 11, message (opaque here: only the top level is walked)
  timestamp: '70' + '80e4b7ea8fd4a4' + '03',       // 14, varint
  feeLimit: '90 01'.replace(' ', '') + '80ade204', // 18, varint
}
const RAW_TRANSFER = F.refBlockBytes + F.refBlockHash + F.expiration + F.contract + F.timestamp
const RAW_CALL = F.refBlockBytes + F.refBlockHash + F.expiration + F.contract + F.timestamp + F.feeLimit

function rawTx(type: string, value: Record<string, unknown>, raw_data_hex: string, extra: Record<string, unknown> = {}): TronRawTransaction {
  return {
    txID: bytesToHex(sha256(hexToBytes(raw_data_hex))), raw_data_hex, visible: false,
    raw_data: { contract: [{ type, parameter: { value } }], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW, ...extra },
  }
}

function fakeNode() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const broadcast: TronRawTransaction[] = []
  const handlers: Record<string, (b: Record<string, unknown>) => unknown> = {
    '/wallet/createtransaction': (b) => rawTx('TransferContract', { owner_address: b.owner_address, to_address: b.to_address, amount: b.amount }, RAW_TRANSFER),
    '/wallet/triggersmartcontract': (b) => ({ result: { result: true }, transaction: rawTx('TriggerSmartContract', { owner_address: b.owner_address, contract_address: b.contract_address, data: selector(String(b.function_selector)) + b.parameter }, RAW_CALL, { fee_limit: b.fee_limit }) }),
    '/wallet/triggerconstantcontract': () => ({ result: { result: true }, energy_used: 30_000, constant_result: ['0'.repeat(63) + '1'] }),
    '/wallet/getaccount': (b) => ({ address: b.address, balance: 5_000_000 }),
    '/wallet/getaccountresource': () => ({ freeNetLimit: 600, freeNetUsed: 0, EnergyLimit: 0, EnergyUsed: 0 }),
    '/wallet/getchainparameters': () => ({ chainParameter: [{ key: 'getTransactionFee', value: 1000 }, { key: 'getEnergyFee', value: 210 }, { key: 'getMemoFee', value: 1_000_000 }] }),
    '/wallet/broadcasttransaction': (b) => { broadcast.push(b as unknown as TronRawTransaction); return { result: true, txid: b.txID } },
  }
  const fetch: TronFetch = async (path, body) => { const b = body as Record<string, unknown>; calls.push({ path, body: b }); const h = handlers[path]; if (!h) throw new Error(`unmocked ${path}`); return h(b) }
  return { fetch, calls, broadcast }
}

describe('memo (raw_data.data)', () => {
  it('encodes the record as tag 0x52 ‖ varint(len) ‖ UTF-8', () => {
    expect(bytesToHex(encodeMemoRecord('hi'))).toBe('52' + '02' + '6869')
    expect(bytesToHex(encodeMemoRecord('ü'))).toBe('52' + '02' + 'c3bc')
    const long = 'x'.repeat(200)
    expect(bytesToHex(encodeMemoRecord(long))).toBe('52' + 'c801' + utf8hex(long)) // 200 = 0xc8 0x01 varint
    expect(() => encodeMemoRecord('')).toThrow(UnsafeTransactionError)
    expect(() => encodeMemoRecord('y'.repeat(MAX_MEMO_BYTES + 1))).toThrow(/limit/)
  })

  it('splices the record at its canonical position (after field ≤ 10, before contract 11) and recomputes txID', () => {
    const tx = rawTx('TransferContract', {}, RAW_TRANSFER)
    const memo = 'order 42'
    const out = attachMemo(tx, memo)
    const record = '52' + '08' + utf8hex(memo)
    expect(out.raw_data_hex).toBe(F.refBlockBytes + F.refBlockHash + F.expiration + record + F.contract + F.timestamp)
    expect(out.raw_data_hex.length).toBe(RAW_TRANSFER.length + record.length)
    expect(out.txID).toBe(bytesToHex(sha256(hexToBytes(out.raw_data_hex))))
    expect(out.txID).not.toBe(tx.txID)
    expect(out.raw_data.data).toBe(utf8hex(memo))
    expect(out.raw_data.contract).toBe(tx.raw_data.contract) // untouched
    // nothing numbered > 10 → appended at the end
    const tail = attachMemo(rawTx('TransferContract', {}, F.refBlockBytes + F.expiration), 'z')
    expect(tail.raw_data_hex).toBe(F.refBlockBytes + F.expiration + '52' + '01' + '7a')
  })

  it('refuses a malformed raw_data_hex, an existing memo, and a signed transaction', () => {
    expect(() => attachMemo(rawTx('TransferContract', {}, 'abab'), 'm')).toThrow(/well-formed/)
    expect(() => attachMemo(rawTx('TransferContract', {}, RAW_TRANSFER, { data: '6869' }), 'm')).toThrow(/already carries/)
    expect(() => attachMemo(rawTx('TransferContract', {}, F.refBlockBytes + '520268' + '69' + F.contract), 'm')).toThrow(/field 10/)
    expect(() => attachMemo({ ...rawTx('TransferContract', {}, RAW_TRANSFER), signature: ['00'] }, 'm')).toThrow(/signed/)
  })

  it('TRX transfer with a memo: bandwidth grows by the record, memo fee is charged, the memo is broadcast and signed over the new txID', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const memo = 'order 42'
    const plain = await withNow(() => a.estimateFee({ to: EXISTING, value: 1_000_000n }))
    const res = await withNow(() => a.transfer({ recipient: EXISTING, amount: 1_000_000n, memo }))
    const recordBytes = 1 + 1 + 8
    expect(res.estimate!.bandwidth).toBe(plain.bandwidth + recordBytes)
    expect(res.estimate!.bandwidth).toBe(bandwidthPoints(f.broadcast[0]!.raw_data_hex))
    expect(res.estimate!.breakdown.memoFee).toBe(1_000_000n)
    expect(res.fee).toBe(1_000_000n) // free bandwidth covers the bytes; only the memo fee burns
    const sent = f.broadcast[0]!
    expect(sent.raw_data.data).toBe(utf8hex(memo))
    expect(sent.raw_data_hex).toContain('5208' + utf8hex(memo))
    expect(sent.txID).toBe(bytesToHex(sha256(hexToBytes(sent.raw_data_hex))))
    expect(res.hash).toBe(sent.txID)
    expect(sent.signature).toHaveLength(1)
    m.dispose()
  })

  it('TRC-20 transfer with a memo (THORChain style): memo rides on the contract call; fee_limit from the simulation is kept', async () => {
    const f = fakeNode()
    const m = new WalletManagerTron(SEED, { provider: f.fetch })
    const a = await m.getAccount(0)
    const memo = '=:ETH.ETH:0x000000000000000000000000000000000000bEEF:0/1/0'
    const res = await withNow(() => a.transfer({ token: USDT, recipient: EXISTING, amount: 5_000_000n, memo }))
    const sent = f.broadcast[0]!
    expect(sent.raw_data.data).toBe(utf8hex(memo))
    expect(sent.raw_data.fee_limit).toBe(Math.ceil(30_000 * 210 * 1.2))
    expect(sent.raw_data.contract[0]!.type).toBe('TriggerSmartContract')
    expect(res.estimate!.breakdown.memoFee).toBe(1_000_000n)
    expect(res.estimate!.bandwidth).toBe(bandwidthPoints(sent.raw_data_hex))
    // canonical position: before contract (0x5a), after expiration (0x40)
    const hex = sent.raw_data_hex
    expect(hex.indexOf('52' + Buffer.from([memo.length]).toString('hex'))).toBeLessThan(hex.indexOf(F.contract))
    m.dispose()
  })

  it('describe reports the memo for every input shape', () => {
    const native = describeTransaction({ to: EXISTING, value: 1n, memo: 'hi' })
    expect(native.memo).toBe('hi')
    expect(native.warnings.map((w) => w.code)).toEqual(['memo-fee'])
    const call = describeTransaction({ contractAddress: USDT, functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: EXISTING }, { type: 'uint256', value: 1n }], memo: 'hi' })
    expect(call.kind).toBe('trc20-transfer')
    expect(call.memo).toBe('hi')
    expect(call.warnings.map((w) => w.code)).toEqual(['memo-fee'])
    const raw = describeTransaction(attachMemo(rawTx('TransferContract', { owner_address: toHexAddress(EXISTING), to_address: toHexAddress(EXISTING), amount: 1 }, RAW_TRANSFER), 'hi'), { now: NOW })
    expect(raw.memo).toBe('hi')
    expect(raw.warnings.map((w) => w.code)).toEqual(['memo-fee'])
    expect(describeTransaction({ to: EXISTING, value: 1n }).memo).toBeUndefined()
  })
})
