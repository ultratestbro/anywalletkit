import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describeTransaction, encodeRawData, toHexAddress, type TronRawTransaction } from '../src/index.js'

// extension audit 2026-11-09 E33: TRX attached to a contract call (call_value) and TRC-10 call_token_value / token_id were
// raw facts or missing, and an unknown selector raised no warning.
const ME = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const DAPP = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const NOW = 1_800_000_000_000
const trigger = (contract: string, data: string, extra: Record<string, unknown> = {}): TronRawTransaction => {
  const raw_data = { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: toHexAddress(ME), contract_address: toHexAddress(contract), data, ...extra }, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' } }], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW, fee_limit: 100_000_000 } as TronRawTransaction['raw_data']
  const raw_data_hex = bytesToHex(encodeRawData(raw_data))
  return { txID: bytesToHex(sha256(hexToBytes(raw_data_hex))), raw_data_hex, visible: false, raw_data }
}
const codes = (d: { warnings: Array<{ code: string }> }) => d.warnings.map((w) => w.code)

describe('E33: TRX and TRC-10 attached to a contract call, unknown selectors', () => {
  it('an unknown selector with call_value: TRX amount, unknown-selector and call-value warnings', () => {
    const d = describeTransaction(trigger(DAPP, 'deadbeef' + '00'.repeat(32), { call_value: 25_000_000 }), { now: NOW })
    expect(d).toMatchObject({ kind: 'contract-call', contract: DAPP, selector: 'deadbeef', callValue: 25_000_000n })
    expect(codes(d)).toEqual(['unknown-selector', 'call-value'])
    expect(d.warnings[1]!.message).toMatch(/25 TRX/)
  })

  it('TRC-10 call_token_value / token_id are decoded and warned about', () => {
    const d = describeTransaction(trigger(DAPP, 'deadbeef', { call_token_value: 7_000, token_id: 1_002_000 }), { now: NOW })
    expect(d).toMatchObject({ callTokenValue: 7_000n, tokenId: '1002000' })
    expect(codes(d)).toContain('call-token-value')
  })

  it('a plain TRC-20 transfer without value stays quiet; the unbuilt contract-call shape is checked the same way', () => {
    const t = describeTransaction(trigger(USDT, 'a9059cbb' + '00'.repeat(12) + toHexAddress(DAPP).slice(2) + (5n).toString(16).padStart(64, '0')), { now: NOW })
    expect(t.kind).toBe('trc20-transfer')
    expect(t.warnings).toEqual([])
    const u = describeTransaction({ contractAddress: DAPP, functionSelector: 'stake()', options: { callValue: 1_000_000 } })
    expect(codes(u)).toEqual(['unknown-selector', 'call-value'])
  })
})
