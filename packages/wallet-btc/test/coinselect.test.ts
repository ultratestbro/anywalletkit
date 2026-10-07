import { describe, expect, it } from 'vitest'
import { InsufficientFundsError } from '@forgewallet/core'
import { INPUT_WEIGHT, TooManyInputsError, estimateVsize, selectAll, selectCoins, spendableUtxos, type Utxo } from '../src/index.js'

const u = (value: bigint, txid = 'a'.repeat(64), vout = 0): Utxo => ({ txid, vout, value, height: 1 })
const P2WPKH = { inputWeight: INPUT_WEIGHT.p2wpkh, changeVBytes: 31, changeDust: 294n }
const target = (value: bigint) => [{ value, vbytes: 31 }]

describe('estimateVsize', () => {
  it('matches the standard segwit sizes', () => {
    expect(estimateVsize(1, INPUT_WEIGHT.p2wpkh, [31, 31])).toBe(141) // 1-in 2-out p2wpkh
    expect(estimateVsize(1, INPUT_WEIGHT.p2wpkh, [31])).toBe(110)
    expect(estimateVsize(1, INPUT_WEIGHT.p2tr, [43])).toBe(111) // 1-in 1-out p2tr
    expect(estimateVsize(2, INPUT_WEIGHT.p2tr, [43, 43])).toBe(212)
  })
})

describe('selectCoins', () => {
  it('spends largest first, keeps change when it clears dust', () => {
    const sel = selectCoins({ ...P2WPKH, utxos: [u(10_000n, 'b'.repeat(64)), u(100_000n), u(50_000n, 'c'.repeat(64))], targets: target(48_000n), feeRate: 10n })
    expect(sel.utxos.map((x) => x.value)).toEqual([100_000n])
    expect(sel.fee).toBe(1_410n) // 141 vB × 10
    expect(sel.change).toBe(100_000n - 48_000n - 1_410n)
    expect(sel.changeFolded).toBe(false)
    expect(sel.vsize).toBe(141)
  })

  it('exact match: no change output, nothing folded', () => {
    const sel = selectCoins({ ...P2WPKH, utxos: [u(50_000n)], targets: target(48_900n), feeRate: 10n }) // 110 vB × 10 = 1100
    expect(sel.change).toBe(0n)
    expect(sel.fee).toBe(1_100n)
    expect(sel.changeFolded).toBe(false)
    expect(sel.vsize).toBe(110)
  })

  it('dust change is folded into the fee', () => {
    const sel = selectCoins({ ...P2WPKH, utxos: [u(50_000n)], targets: target(48_800n), feeRate: 10n })
    expect(sel.change).toBe(0n)
    expect(sel.fee).toBe(1_200n)
    expect(sel.changeFolded).toBe(true)
  })

  it('accumulates several inputs when one is not enough', () => {
    const sel = selectCoins({ ...P2WPKH, utxos: [u(30_000n, 'a'.repeat(64)), u(30_000n, 'b'.repeat(64)), u(30_000n, 'c'.repeat(64))], targets: target(50_000n), feeRate: 10n })
    expect(sel.utxos).toHaveLength(2)
    expect(sel.utxos.map((x) => x.txid[0])).toEqual(['a', 'b']) // deterministic tie-break on txid
    expect(sel.fee).toBe(BigInt(estimateVsize(2, INPUT_WEIGHT.p2wpkh, [31, 31])) * 10n)
  })

  it('insufficient funds reports what was needed vs available', () => {
    expect(() => selectCoins({ ...P2WPKH, utxos: [u(50_000n)], targets: target(60_000n), feeRate: 10n })).toThrow(InsufficientFundsError)
    try { selectCoins({ ...P2WPKH, utxos: [u(50_000n)], targets: target(60_000n), feeRate: 10n }) } catch (e) {
      const err = e as InsufficientFundsError
      expect(err.available).toBe(50_000n)
      expect(err.required).toBe(61_100n)
    }
  })

  it('UTXOs worth less than their own input fee are never selected', () => {
    // at 10 sat/vB a p2wpkh input costs 680 sat
    expect(spendableUtxos([u(600n), u(700n, 'b'.repeat(64)), u(680n, 'c'.repeat(64))], 10n, INPUT_WEIGHT.p2wpkh).map((x) => x.value)).toEqual([700n])
    expect(() => selectCoins({ ...P2WPKH, utxos: [u(600n), u(500n, 'b'.repeat(64))], targets: target(300n), feeRate: 10n })).toThrow(InsufficientFundsError)
  })

  it('respects maxInputs', () => {
    const utxos = ['a', 'b', 'c'].map((c) => u(20_000n, c.repeat(64)))
    expect(() => selectCoins({ ...P2WPKH, utxos, targets: target(50_000n), feeRate: 10n, maxInputs: 2 })).toThrow(TooManyInputsError)
    expect(selectCoins({ ...P2WPKH, utxos, targets: target(50_000n), feeRate: 10n, maxInputs: 3 }).utxos).toHaveLength(3)
  })

  it('rejects a fee rate below 1', () => {
    expect(() => selectCoins({ ...P2WPKH, utxos: [u(50_000n)], targets: target(1_000n), feeRate: 0n })).toThrow(/feeRate/)
  })
})

describe('selectAll (sweep)', () => {
  it('spends every spendable input into one output', () => {
    const sweep = selectAll({ utxos: [u(100_000n), u(50_000n, 'b'.repeat(64)), u(100n, 'c'.repeat(64))], feeRate: 10n, inputWeight: INPUT_WEIGHT.p2wpkh, outputVBytes: 31 })
    expect(sweep.utxos).toHaveLength(2)
    expect(sweep.vsize).toBe(estimateVsize(2, INPUT_WEIGHT.p2wpkh, [31]))
    expect(sweep.amount + sweep.fee).toBe(150_000n)
  })

  it('is empty when nothing is spendable', () => {
    expect(selectAll({ utxos: [u(100n)], feeRate: 10n, inputWeight: INPUT_WEIGHT.p2wpkh, outputVBytes: 31 })).toEqual({ utxos: [], fee: 0n, amount: 0n, vsize: 0 })
  })
})
