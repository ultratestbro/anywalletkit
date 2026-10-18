import { describe, expect, it } from 'vitest'
import { InsufficientFundsError } from '@forgewallet/core'
import { P2PKH_INPUT_SIZE, TooManyInputsError, conventionalFee, logicalActions, selectAll, selectCoins } from '../src/index.js'
import { TXID_A, TXID_B } from './helpers.js'

const P2PKH_OUT = 34
const utxo = (txid: string, vout: number, value: bigint) => ({ txid, vout, value, height: 1 })

describe('ZIP-317', () => {
  it('conventional fee = 5000 × max(2, logical actions); 1-in-2-out and 2-in-2-out pay 10 000', () => {
    expect(conventionalFee([P2PKH_INPUT_SIZE], [P2PKH_OUT, P2PKH_OUT])).toBe(10_000n)
    expect(conventionalFee([P2PKH_INPUT_SIZE, P2PKH_INPUT_SIZE], [P2PKH_OUT, P2PKH_OUT])).toBe(10_000n)
    expect(conventionalFee([P2PKH_INPUT_SIZE], [P2PKH_OUT])).toBe(10_000n) // grace
    expect(conventionalFee(Array(3).fill(P2PKH_INPUT_SIZE), [P2PKH_OUT, P2PKH_OUT])).toBe(15_000n)
    expect(conventionalFee([P2PKH_INPUT_SIZE], Array(5).fill(P2PKH_OUT))).toBe(25_000n)
    expect(logicalActions([P2PKH_INPUT_SIZE * 74], [P2PKH_OUT])).toBe(74) // 74 × 149 = 11 026 B → ceil(11026/150) = 74
  })

  it('selects largest first, keeps change above dust, folds dust change into the fee', () => {
    const utxos = [utxo(TXID_A, 0, 100_000n), utxo(TXID_B, 1, 50_000n)]
    const s = selectCoins({ utxos, target: 60_000n, recipientOutputSize: P2PKH_OUT, changeOutputSize: P2PKH_OUT })
    expect(s.utxos.map((u) => u.txid)).toEqual([TXID_A])
    expect(s.fee).toBe(10_000n)
    expect(s.change).toBe(30_000n)
    // 100 000 − 89 800 − 10 000 = 200 < dust → folded
    const folded = selectCoins({ utxos, target: 89_800n, recipientOutputSize: P2PKH_OUT, changeOutputSize: P2PKH_OUT })
    expect(folded.change).toBe(0n)
    expect(folded.changeFolded).toBe(true)
    expect(folded.fee).toBe(10_200n)
    // needs both inputs
    const both = selectCoins({ utxos, target: 120_000n, recipientOutputSize: P2PKH_OUT, changeOutputSize: P2PKH_OUT })
    expect(both.utxos).toHaveLength(2)
    expect(both.fee).toBe(10_000n)
    expect(both.change).toBe(20_000n)
  })

  it('an explicit fee replaces the conventional one; too little money and too many inputs are refused', () => {
    const utxos = [utxo(TXID_A, 0, 100_000n)]
    expect(selectCoins({ utxos, target: 60_000n, recipientOutputSize: P2PKH_OUT, changeOutputSize: P2PKH_OUT, fee: 20_000n }).change).toBe(20_000n)
    expect(() => selectCoins({ utxos, target: 95_000n, recipientOutputSize: P2PKH_OUT, changeOutputSize: P2PKH_OUT })).toThrow(InsufficientFundsError)
    const many = Array.from({ length: 5 }, (_, i) => utxo(TXID_A, i, 10_000n))
    expect(() => selectCoins({ utxos: many, target: 40_000n, recipientOutputSize: P2PKH_OUT, changeOutputSize: P2PKH_OUT, maxInputs: 3 })).toThrow(TooManyInputsError)
  })

  it('selectAll sweeps every input into one output', () => {
    const utxos = [utxo(TXID_A, 0, 100_000n), utxo(TXID_B, 1, 50_000n), utxo(TXID_B, 2, 6_000n)]
    const s = selectAll({ utxos, outputSize: P2PKH_OUT })
    expect(s.utxos).toHaveLength(3)
    expect(s.fee).toBe(15_000n)
    expect(s.amount).toBe(141_000n)
  })
})
