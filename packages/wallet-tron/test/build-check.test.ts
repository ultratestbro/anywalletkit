import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { assertNodeBuild, attachMemo, encodeParameters, encodeRawData, memoBytes, selector, toHexAddress, type ExpectedBuild, type TronRawTransaction, type UnsafeTransactionError } from '../src/index.js'

// scan F7: a node build is compared with the request before anything is signed.

const ME = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const TO = 'TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9'
const ATTACKER = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const OTHER_TOKEN = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const NOW = 1_800_000_000_000

type Raw = TronRawTransaction['raw_data']
type C = Raw['contract'][number] & { Permission_id?: number }
const seal = (raw_data: Raw): TronRawTransaction => {
  const raw_data_hex = bytesToHex(encodeRawData(raw_data))
  return { txID: bytesToHex(sha256(hexToBytes(raw_data_hex))), raw_data_hex, raw_data, visible: false }
}
const raw = (contracts: C[], extra: Partial<Raw> = {}): Raw => ({ contract: contracts, ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW, ...extra })
const trx = (v: Record<string, unknown> = {}): C => ({ type: 'TransferContract', parameter: { value: { owner_address: toHexAddress(ME), to_address: toHexAddress(TO), amount: 1_000_000, ...v }, type_url: 'type.googleapis.com/protocol.TransferContract' } })
const DATA = selector('transfer(address,uint256)') + encodeParameters([{ type: 'address', value: TO }, { type: 'uint256', value: 5_000_000n }])
const call = (v: Record<string, unknown> = {}): C => ({ type: 'TriggerSmartContract', parameter: { value: { owner_address: toHexAddress(ME), contract_address: toHexAddress(USDT), data: DATA, ...v }, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' } })

const wantTrx: ExpectedBuild = { type: 'TransferContract', owner: ME, to: TO, amount: 1_000_000n }
const wantCall: ExpectedBuild = { type: 'TriggerSmartContract', owner: toHexAddress(ME), contract: USDT, data: DATA.toUpperCase(), callValue: 0n, feeLimit: 30_000_000n }
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return (e as UnsafeTransactionError).code ?? (e as Error).message } }

describe('scan F7: node builds must be the requested transaction', () => {
  it('accepts the honest builds (addresses in any form, calldata in any case, call_value omitted = 0)', () => {
    expect(code(() => assertNodeBuild(seal(raw([trx()])), wantTrx))).toBe('ok')
    expect(code(() => assertNodeBuild(seal(raw([call()], { fee_limit: 30_000_000 })), wantCall))).toBe('ok')
    expect(code(() => assertNodeBuild(seal(raw([call({ call_value: 7 })], { fee_limit: 30_000_000 })), { ...wantCall, callValue: 7n }))).toBe('ok')
  })

  it('refuses a TRX build that pays someone else, another amount, or is another contract type', () => {
    expect(code(() => assertNodeBuild(seal(raw([trx({ to_address: toHexAddress(ATTACKER) })])), wantTrx))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([trx({ amount: 1_000_001 })])), wantTrx))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([trx({ owner_address: toHexAddress(ATTACKER) })])), wantTrx))).toBe('build-mismatch')
    const takeover: C = { type: 'AccountPermissionUpdateContract', parameter: { value: { owner_address: toHexAddress(ME), raw_parameter_hex: '0a15' + toHexAddress(ME) + '12050a03666f6f' }, type_url: 'type.googleapis.com/protocol.AccountPermissionUpdateContract' } }
    expect(code(() => assertNodeBuild(seal(raw([takeover])), wantTrx))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([trx()], { fee_limit: 1 })), wantTrx))).toBe('build-mismatch')
  })

  it('refuses a contract-call build with another contract, calldata, call_value or fee_limit', () => {
    const fee = { fee_limit: 30_000_000 }
    expect(code(() => assertNodeBuild(seal(raw([call({ contract_address: toHexAddress(OTHER_TOKEN) })], fee)), wantCall))).toBe('build-mismatch')
    const toAttacker = selector('transfer(address,uint256)') + encodeParameters([{ type: 'address', value: ATTACKER }, { type: 'uint256', value: 5_000_000n }])
    expect(code(() => assertNodeBuild(seal(raw([call({ data: toAttacker })], fee)), wantCall))).toBe('build-mismatch')
    const approve = selector('approve(address,uint256)') + encodeParameters([{ type: 'address', value: ATTACKER }, { type: 'uint256', value: (1n << 256n) - 1n }])
    expect(code(() => assertNodeBuild(seal(raw([call({ data: approve })], fee)), wantCall))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([call({ call_value: 1 })], fee)), wantCall))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([call()], { fee_limit: 30_000_001 })), wantCall))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([call()])), wantCall))).toBe('build-mismatch') // fee_limit dropped
    expect(code(() => assertNodeBuild(seal(raw([call({ token_id: 1000001, call_token_value: 5 })], fee)), wantCall))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([trx()])), wantCall))).toBe('build-mismatch')
  })

  it('refuses a second contract, a Permission_id, a memo nobody asked for, and fields a build never has', () => {
    expect(code(() => assertNodeBuild(seal(raw([trx(), trx()])), wantTrx))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([{ ...trx(), Permission_id: 2 }])), wantTrx))).toBe('build-mismatch')
    expect(code(() => assertNodeBuild(seal(raw([trx()], { data: '6869' })), wantTrx))).toBe('build-mismatch')
    // scripts (field 12) appended to the node's bytes
    const t = seal(raw([trx()]))
    const hex = t.raw_data_hex + '6200'
    expect(code(() => assertNodeBuild({ ...t, raw_data_hex: hex, txID: bytesToHex(sha256(hexToBytes(hex))) }, wantTrx))).toBe('build-mismatch')
    // and the byte-level checks still come first
    expect(code(() => assertNodeBuild({ ...t, txID: '00'.repeat(32) }, wantTrx))).toBe('txid-mismatch')
    expect(code(() => assertNodeBuild({ ...t, raw_data: raw([trx({ amount: 1 })]) }, wantTrx))).toBe('raw-mismatch')
  })

  it('memo: the spliced bytes must be the requested memo in the requested encoding', () => {
    const t = seal(raw([trx()]))
    const note = '0x00a1ff'
    const hexMemo = attachMemo(t, note, 'hex')
    expect(hexMemo.raw_data.data).toBe('00a1ff')
    expect(code(() => assertNodeBuild(hexMemo, wantTrx, memoBytes(note, 'hex')))).toBe('ok')
    // the same string as UTF-8 text is a different memo
    expect(code(() => assertNodeBuild(hexMemo, wantTrx, memoBytes(note, 'utf8')))).toBe('build-mismatch')
    const text = attachMemo(t, '=:BASE.ETH:0xabc')
    expect(code(() => assertNodeBuild(text, wantTrx, memoBytes('=:BASE.ETH:0xabc')))).toBe('ok')
    expect(code(() => assertNodeBuild(t, wantTrx, memoBytes('x')))).toBe('build-mismatch') // memo requested, none in the bytes
  })
})
