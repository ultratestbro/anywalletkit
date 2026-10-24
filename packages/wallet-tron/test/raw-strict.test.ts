import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decodeRawData, describeTransaction, readFields, toHexAddress, verifyRawTransaction, type TronRawTransaction, type UnsafeTransactionError } from '../src/index.js'

// scan F4: the decoder must read exactly what java-tron reads, or refuse.

const ME = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'
const DAPP = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'
const ATTACKER = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const NOW = 1_800_000_000_000

const varint = (n: bigint): number[] => {
  if (n < 0n) n += 1n << 64n
  const out: number[] = []
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b) } while (n)
  return out
}
const tag = (field: number, wire: number) => varint(BigInt((field << 3) | wire))
const vfield = (field: number, v: bigint | number) => [...tag(field, 0), ...varint(BigInt(v))]
const lfield = (field: number, payload: number[] | Uint8Array, tagBytes: number[] = tag(field, 2)) => [...tagBytes, ...varint(BigInt(payload.length)), ...payload]
const addr = (a: string) => [...hexToBytes(toHexAddress(a))]
const ascii = (s: string) => [...new TextEncoder().encode(s)]
const word = (hex: string) => hex.padStart(64, '0')
const calldata = (to: string, amount: bigint) => [...hexToBytes('a9059cbb' + word(toHexAddress(to).slice(2)) + word(amount.toString(16)))]

const ENUM: Record<string, number> = { TransferContract: 1, TriggerSmartContract: 31, VoteWitnessContract: 4, AccountPermissionUpdateContract: 46 }
/** Contract{type, parameter: Any{type_url, value}} — every piece given as raw bytes so tests can corrupt any of them. */
const contract = (type: string, param: number[], extra: number[] = []) =>
  [...vfield(1, ENUM[type]!), ...lfield(2, [...lfield(1, ascii(`type.googleapis.com/protocol.${type}`)), ...lfield(2, param)]), ...extra]
/** Transaction.raw around the given contract records, in java-tron order. */
const raw = (contracts: number[][], { top = [], tail = [] }: { top?: number[]; tail?: number[] } = {}) =>
  Uint8Array.from([...lfield(1, [0xa1, 0xb2]), ...lfield(4, [...hexToBytes('0011223344556677')]), ...vfield(8, NOW + 60_000), ...top, ...contracts.flatMap((c) => lfield(11, c)), ...vfield(14, NOW), ...tail])
const tx = (bytes: Uint8Array): TronRawTransaction => ({ txID: bytesToHex(sha256(bytes)), raw_data_hex: bytesToHex(bytes) } as TronRawTransaction)
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return (e as UnsafeTransactionError).code ?? (e as Error).message } }

const transferParam = (to: string, amount: bigint | number) => [...lfield(1, addr(ME)), ...lfield(2, addr(to)), ...vfield(3, amount)]
const triggerParam = (data: number[], extra: number[] = []) => [...lfield(1, addr(ME)), ...lfield(2, addr(USDT)), ...lfield(4, data), ...extra]

describe('scan F4: strict, canonical Tron protobuf', () => {
  it('the honest builds decode', () => {
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', transferParam(DAPP, 1_000_000))]))))).toBe('ok')
    expect(code(() => verifyRawTransaction(tx(raw([contract('TriggerSmartContract', triggerParam(calldata(DAPP, 1_000_000n)))], { tail: vfield(18, 30_000_000) }))))).toBe('ok')
  })

  it('refuses the report\'s attack: a second field-4 record behind the over-long tag a2 80 80 80 10', () => {
    const visible = calldata(DAPP, 1_000_000n)
    const hidden = calldata(ATTACKER, 10n ** 12n)
    const attack = raw([contract('TriggerSmartContract', triggerParam(visible, lfield(4, hidden, [0xa2, 0x80, 0x80, 0x80, 0x10])))], { tail: vfield(18, 30_000_000) })
    expect(() => readFields(hexToBytes('a28080801000'))).toThrow(/tag exceeds 32 bits/)
    expect(code(() => verifyRawTransaction(tx(attack)))).toBe('raw-noncanonical')
    // the sheet does not describe it as the visible 1 USDT transfer either
    const d = describeTransaction(tx(attack), { now: NOW })
    expect(d.kind).toBe('unknown')
    expect(d.warnings.map((w) => w.code)).toEqual(['raw-undecodable'])
  })

  it('refuses tags longer than 5 bytes and non-minimal tags', () => {
    // field 4 / wire 2 = 0x22, padded to 6 bytes (value still < 2^32)
    expect(() => readFields(Uint8Array.from([0xa2, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00]))).toThrow(/longer than 5 bytes/)
    // field 3 / wire 2 = 0x1a written as 9a 00
    expect(() => readFields(Uint8Array.from([0x9a, 0x00, 0x00]))).toThrow(/non-minimal tag/)
    const t = raw([contract('TransferContract', transferParam(DAPP, 1))], { tail: [0x9a, 0x80, 0x00, 0x00] })
    expect(code(() => verifyRawTransaction(tx(t)))).toBe('raw-noncanonical')
  })

  it('refuses non-minimal value varints and varints over 64 bits; a 10-byte negative int64 is valid', () => {
    // amount 1000 as e8 87 00 (trailing zero byte)
    const nonMinimal = [...lfield(1, addr(ME)), ...lfield(2, addr(DAPP)), 0x18, 0xe8, 0x87, 0x00]
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', nonMinimal)]))))).toBe('raw-noncanonical')
    // non-minimal length prefix on ref_block_bytes
    const badLen = Uint8Array.from([0x0a, 0x82, 0x00, 0xa1, 0xb2])
    expect(() => readFields(badLen)).toThrow(/non-minimal length/)
    // 10th byte 0x02: bit 64 set
    expect(() => readFields(Uint8Array.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02]))).toThrow(/exceeds 64 bits/)
    expect(() => readFields(Uint8Array.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(/longer than 10 bytes/)
    // -1 as int64: ff ×9, 01 — valid, decoded as negative
    const negative = raw([contract('TransferContract', transferParam(DAPP, -1n))])
    expect(varint(-1n)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    expect(code(() => verifyRawTransaction(tx(negative)))).toBe('ok')
    expect(decodeRawData(negative).raw_data.contract[0]!.parameter.value.amount).toBe(-1)
    const minInt64 = raw([contract('TransferContract', transferParam(DAPP, -(1n << 63n)))])
    expect(decodeRawData(minInt64).raw_data.contract[0]!.parameter.value.amount).toBe((-(1n << 63n)).toString())
    expect(code(() => verifyRawTransaction(tx(minInt64)))).toBe('ok')
  })

  it('refuses duplicate singular fields at every level', () => {
    const dupTo = [...transferParam(DAPP, 1), ...lfield(2, addr(ATTACKER))]
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', dupTo)]))))).toBe('raw-noncanonical')
    const dupData = triggerParam(calldata(DAPP, 1n), lfield(4, calldata(ATTACKER, 2n)))
    expect(code(() => verifyRawTransaction(tx(raw([contract('TriggerSmartContract', dupData)]))))).toBe('raw-noncanonical')
    // Transaction.raw.expiration twice
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', transferParam(DAPP, 1))], { tail: vfield(8, NOW + 1) }))))).toBe('raw-noncanonical')
    // Contract.type twice
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', transferParam(DAPP, 1), vfield(1, 31))]))))).toBe('raw-noncanonical')
    // Any.value twice
    const twoValues = [...vfield(1, 1), ...lfield(2, [...lfield(1, ascii('type.googleapis.com/protocol.TransferContract')), ...lfield(2, transferParam(DAPP, 1)), ...lfield(2, transferParam(ATTACKER, 9))])]
    expect(code(() => verifyRawTransaction(tx(raw([twoValues]))))).toBe('raw-noncanonical')
  })

  it('refuses a repeated owner_address in a contract type it has no schema for (scan 2026-10-23 F9)', () => {
    // java-tron takes the last owner_address: the chain would act for ATTACKER's account while every check here sees ME.
    const twoOwners = [...lfield(1, addr(ME)), ...lfield(1, addr(ATTACKER)), ...lfield(3, [0x0a, 0x00])]
    expect(code(() => verifyRawTransaction(tx(raw([contract('AccountPermissionUpdateContract', twoOwners)]))))).toBe('raw-noncanonical')
    // One owner_address still decodes (shown as undecoded on the sheet, owner checked by signRaw).
    const one = raw([contract('AccountPermissionUpdateContract', [...lfield(1, addr(ME)), ...lfield(3, [0x0a, 0x00])])])
    expect(code(() => verifyRawTransaction(tx(one)))).toBe('ok')
    expect(toHexAddress(decodeRawData(one).raw_data.contract[0]!.parameter.value.owner_address as string)).toBe(toHexAddress(ME))
  })

  it('allows the repeated fields: raw.contract, raw.auths, VoteWitness.votes', () => {
    const two = raw([contract('TransferContract', transferParam(DAPP, 1)), contract('TransferContract', transferParam(DAPP, 2))])
    expect(code(() => verifyRawTransaction(tx(two)))).toBe('ok') // decodes; signing still refuses it as multi-contract
    expect(decodeRawData(two).raw_data.contract).toHaveLength(2)
    const auths = raw([contract('TransferContract', transferParam(DAPP, 1))], { top: [...lfield(9, [0x0a, 0x00]), ...lfield(9, [0x0a, 0x00])] })
    expect(code(() => verifyRawTransaction(tx(auths)))).toBe('ok')
    const vote = (w: string, n: number) => lfield(2, [...lfield(1, addr(w)), ...vfield(2, n)])
    const votes = raw([contract('VoteWitnessContract', [...lfield(1, addr(ME)), ...vote(DAPP, 5), ...vote(ATTACKER, 7)])])
    expect(code(() => verifyRawTransaction(tx(votes)))).toBe('ok')
  })

  it('a schema\'d contract decodes completely and re-encodes to its own bytes, or is refused', () => {
    // unknown field 7 inside TriggerSmartContract: hard refusal, not a warning
    const unknown = raw([contract('TriggerSmartContract', triggerParam(calldata(DAPP, 1n), vfield(7, 1)))])
    expect(code(() => verifyRawTransaction(tx(unknown)))).toBe('raw-undecodable')
    // explicit proto3 default (call_value = 0) — java-tron never writes it
    const explicitDefault = raw([contract('TriggerSmartContract', [...lfield(1, addr(ME)), ...lfield(2, addr(USDT)), ...vfield(3, 0), ...lfield(4, calldata(DAPP, 1n))])])
    expect(code(() => verifyRawTransaction(tx(explicitDefault)))).toBe('raw-noncanonical')
    // fields out of order
    const reordered = [...lfield(2, addr(DAPP)), ...lfield(1, addr(ME)), ...vfield(3, 1)]
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', reordered)]))))).toBe('raw-noncanonical')
    // unknown field in the Contract wrapper or the Any
    expect(code(() => verifyRawTransaction(tx(raw([contract('TransferContract', transferParam(DAPP, 1), vfield(6, 1))]))))).toBe('raw-undecodable')
    const anyExtra = [...vfield(1, 1), ...lfield(2, [...lfield(1, ascii('type.googleapis.com/protocol.TransferContract')), ...lfield(2, transferParam(DAPP, 1)), ...vfield(3, 1)])]
    expect(code(() => verifyRawTransaction(tx(raw([anyExtra]))))).toBe('raw-undecodable')
  })
})
