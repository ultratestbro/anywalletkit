import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  CONTRACT_TYPES, UnsafeTransactionError, WalletManagerTron, attachMemo, decodeRawData, describeTransaction, encodeRawData, rawMismatch, toHexAddress,
  verifyRawTransaction, type TronRawTransaction,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const VICTIM_TO = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const NOW = 1_800_000_000_000
const base = (contract: TronRawTransaction['raw_data']['contract'][number], extra: Partial<TronRawTransaction['raw_data']> = {}): TronRawTransaction['raw_data'] =>
  ({ contract: [contract], ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW, ...extra })
const seal = (raw_data: TronRawTransaction['raw_data'], json: TronRawTransaction['raw_data'] = raw_data): TronRawTransaction => {
  const raw_data_hex = bytesToHex(encodeRawData(raw_data))
  return { txID: bytesToHex(sha256(hexToBytes(raw_data_hex))), raw_data_hex, visible: false, raw_data: json }
}
const transfer = (owner: string, to: string, amount: number | string) => ({ type: 'TransferContract', parameter: { value: { owner_address: toHexAddress(owner), to_address: toHexAddress(to), amount }, type_url: 'type.googleapis.com/protocol.TransferContract' } })
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return (e as UnsafeTransactionError).code ?? (e as Error).message } }

describe('Transaction.raw codec', () => {
  it('round-trips the contracts the wallet describes, with java-tron field order and proto3 defaults omitted', () => {
    const cases: TronRawTransaction['raw_data'][] = [
      base(transfer(ME, VICTIM_TO, 1_000_000)),
      base({ type: 'TriggerSmartContract', parameter: { value: { owner_address: toHexAddress(ME), contract_address: toHexAddress(USDT), data: 'a9059cbb' + '00'.repeat(64), call_value: 0 }, type_url: 'type.googleapis.com/protocol.TriggerSmartContract' } }, { fee_limit: 100_000_000 }),
      base({ type: 'TransferAssetContract', parameter: { value: { asset_name: '31303030303031', owner_address: toHexAddress(ME), to_address: toHexAddress(VICTIM_TO), amount: '9007199254740993' }, type_url: 'type.googleapis.com/protocol.TransferAssetContract' } }),
      base({ type: 'FreezeBalanceV2Contract', parameter: { value: { owner_address: toHexAddress(ME), frozen_balance: 5_000_000, resource: 'ENERGY' }, type_url: 'type.googleapis.com/protocol.FreezeBalanceV2Contract' } }),
      base({ type: 'DelegateResourceContract', parameter: { value: { owner_address: toHexAddress(ME), resource: 'ENERGY', balance: 1, receiver_address: toHexAddress(VICTIM_TO), lock: true, lock_period: 3 }, type_url: 'type.googleapis.com/protocol.DelegateResourceContract' } }, { data: '6869' }),
    ]
    for (const raw of cases) {
      const decoded = decodeRawData(encodeRawData(raw))
      expect(decoded.unknownFields).toEqual([])
      expect(decoded.raw_data.contract[0]!.undecoded).toEqual([])
      expect(rawMismatch(raw, decoded.raw_data)).toBeNull()
      // defaults (call_value: 0) are dropped by the encoder; everything else survives
      const { call_value: _cv, ...rest } = raw.contract[0]!.parameter.value as Record<string, unknown>
      expect(decoded.raw_data.contract[0]!.parameter.value).toMatchObject(rest)
      expect(decoded.raw_data).toMatchObject({ ref_block_bytes: 'a1b2', ref_block_hash: '0011223344556677', expiration: NOW + 60_000, timestamp: NOW })
    }
    // the TRX transfer encodes to the size a real node produces for one
    expect(encodeRawData(base(transfer(ME, VICTIM_TO, 1_000_000))).length).toBeGreaterThanOrEqual(130)
    expect(encodeRawData(base(transfer(ME, VICTIM_TO, 1_000_000))).length).toBeLessThanOrEqual(136)
    // first field bytes: ref_block_bytes tag 0x0a, len 2
    expect(bytesToHex(encodeRawData(base(transfer(ME, VICTIM_TO, 1)))).startsWith('0a02a1b2')).toBe(true)
    expect(CONTRACT_TYPES[1]).toBe('TransferContract')
  })

  it('unknown contract types decode to their name + raw bytes, never to something benign', () => {
    const raw = seal(base({ type: 'AccountPermissionUpdateContract', parameter: { value: { owner_address: toHexAddress(ME), raw_parameter_hex: '0a15' + toHexAddress(ME) + '12050a03666f6f' }, type_url: 'type.googleapis.com/protocol.AccountPermissionUpdateContract' } }))
    const decoded = decodeRawData(raw.raw_data_hex)
    expect(decoded.raw_data.contract[0]).toMatchObject({ type: 'AccountPermissionUpdateContract', undecoded: [2] })
    expect(decoded.raw_data.contract[0]!.parameter.value.owner_address).toBe(toHexAddress(ME))
    const d = describeTransaction(raw, { now: NOW })
    expect(d.kind).toBe('unknown')
    expect(d.from).toBe(ME)
    expect(d.warnings.map((w) => w.code)).toEqual(['undecoded', 'account-permission', 'undecoded'])
    // an enum the codec does not know still names itself
    const weird = bytesToHex(encodeRawData(base({ type: 'TransferContract', parameter: { value: { owner_address: toHexAddress(ME) }, type_url: 'type.googleapis.com/protocol.TransferContract' } }))).replace('0801', '0802')
    expect(() => decodeRawData(weird)).toThrow(/disagrees/)
  })

  it('malformed bytes are refused, not guessed', () => {
    expect(() => decodeRawData('ab')).toThrow()
    expect(() => decodeRawData('0a')).toThrow(/truncated/)
    expect(() => decodeRawData('5a0208ff')).toThrow() // contract with a truncated varint
    const d = describeTransaction({ txID: 'x', raw_data_hex: 'ab', raw_data: base(transfer(ME, VICTIM_TO, 1)) }, { now: NOW })
    expect(d.kind).toBe('unknown')
    expect(d.warnings.map((w) => w.code)).toEqual(['raw-undecodable'])
    expect(code(() => verifyRawTransaction({ txID: 'x', raw_data_hex: 'ab', raw_data: base(transfer(ME, VICTIM_TO, 1)) }))).toBe('txid-mismatch')
    expect(code(() => verifyRawTransaction({ txID: bytesToHex(sha256(hexToBytes('ab'))), raw_data_hex: 'ab', raw_data: base(transfer(ME, VICTIM_TO, 1)) }))).toBe('raw-undecodable')
    expect(code(() => verifyRawTransaction({ txID: 'ab'.repeat(32), raw_data: base(transfer(ME, VICTIM_TO, 1)) } as unknown as TronRawTransaction))).toBe('raw-undecodable')
  })
})

describe('C1: what the sheet shows is what gets signed', () => {
  // The attack: JSON says "1 TRX to myself", the bytes say "1000 TRX to the attacker", txID = sha256(bytes).
  const benignJson = base(transfer(ME, ME, 1_000_000))
  const maliciousBytes = base(transfer(ME, VICTIM_TO, 1_000_000_000))
  const forged = seal(maliciousBytes, benignJson)

  it('describeTransaction reads the bytes, so the sheet shows the attacker and the real amount', () => {
    const d = describeTransaction(forged, { now: NOW })
    expect(d).toMatchObject({ kind: 'trx-transfer', from: ME, to: VICTIM_TO, amount: 1_000_000_000n })
    expect(d.warnings).toEqual([])
    // without bytes the JSON is described, with a warning that nothing can be signed
    const jsonOnly = describeTransaction({ txID: forged.txID, raw_data: benignJson } as unknown as TronRawTransaction, { now: NOW })
    expect(jsonOnly).toMatchObject({ kind: 'trx-transfer', to: ME, amount: 1_000_000n })
    expect(jsonOnly.warnings.map((w) => w.code)).toEqual(['no-raw-hex'])
  })

  it('verifyRawTransaction names the first field where the JSON lies', () => {
    expect(() => verifyRawTransaction(forged)).toThrow(/contract\[0\]\.to_address: JSON says/)
    expect(code(() => verifyRawTransaction(forged))).toBe('raw-mismatch')
    expect(code(() => verifyRawTransaction(seal(maliciousBytes, base(transfer(ME, VICTIM_TO, 1)))))).toBe('raw-mismatch')
    expect(code(() => verifyRawTransaction(seal(maliciousBytes, { ...maliciousBytes, fee_limit: 5 })))).toBe('raw-mismatch')
    expect(code(() => verifyRawTransaction(seal(maliciousBytes, { ...maliciousBytes, expiration: NOW + 1 })))).toBe('raw-mismatch')
    // base58 vs hex addresses and numbers vs strings are the same transaction
    const visible = { ...maliciousBytes, contract: [{ type: 'TransferContract', parameter: { value: { owner_address: ME, to_address: VICTIM_TO, amount: '1000000000' } } }] }
    expect(code(() => verifyRawTransaction(seal(maliciousBytes, visible)))).toBe('ok')
    // a txID that is not sha256(raw_data_hex) is refused before anything else
    expect(code(() => verifyRawTransaction({ ...seal(maliciousBytes), txID: 'ab'.repeat(32) }))).toBe('txid-mismatch')
    // and a transaction with no JSON at all is fine: the bytes are the truth
    const { raw_data: _r, ...bytesOnly } = seal(maliciousBytes)
    expect(verifyRawTransaction(bytesOnly as TronRawTransaction).raw_data.contract[0]!.type).toBe('TransferContract')
    expect(verifyRawTransaction(seal(maliciousBytes)).txID).toBe(seal(maliciousBytes).txID)
  })

  it('signRaw refuses the forgery, the hash mismatch and the foreign owner; signs only bytes it has read', async () => {
    const m = new WalletManagerTron(SEED)
    const a = await m.getAccount(0)
    const mine = (to: string, amount: number) => base(transfer(a.address, to, amount))
    const real = Date.now
    Date.now = () => NOW
    try {
      await expect(a.signRaw(forged)).rejects.toMatchObject({ code: 'raw-mismatch' }) // the JSON/bytes check comes before the owner check
      await expect(a.signRaw(seal(mine(VICTIM_TO, 1_000_000_000), mine(a.address, 1)))).rejects.toMatchObject({ code: 'raw-mismatch' })
      await expect(a.signRaw({ ...seal(mine(VICTIM_TO, 1)), txID: 'cd'.repeat(32) })).rejects.toMatchObject({ code: 'txid-mismatch' })
      await expect(a.signRaw(seal(base(transfer(VICTIM_TO, a.address, 1))))).rejects.toMatchObject({ code: 'owner-mismatch' })
      await expect(a.signRaw(seal(mine(VICTIM_TO, 1), undefined as never))).resolves.toBeDefined()
      const honest = seal(mine(VICTIM_TO, 7))
      const signed = await a.signRaw(honest)
      expect(signed.txID).toBe(honest.txID)
      expect(signed.raw_data).toBe(honest.raw_data) // the JSON the dApp broadcasts is returned untouched
      const sig = hexToBytes(signed.signature![0]!)
      expect(sig).toHaveLength(65)
      const pub = secp256k1.recoverPublicKey(Uint8Array.from([sig[64]!, ...sig.subarray(0, 64)]), hexToBytes(honest.txID), { prehash: false })
      expect(bytesToHex(pub)).toBe(bytesToHex(a.publicKey))
      // a memo attached by the wallet keeps bytes, JSON and txID consistent
      const withMemo = attachMemo(honest, 'order 42')
      expect(code(() => verifyRawTransaction(withMemo))).toBe('ok')
      expect(describeTransaction(withMemo, { now: NOW }).memo).toBe('order 42')
    } finally {
      Date.now = real
      m.dispose()
    }
  })
})
