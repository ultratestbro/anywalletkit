/**
 * Coin selection — our own, deterministic, documented. (btc-signer ships
 * `selectUTXO`, but it is outside the audited scope, so it is not used.)
 *
 * Strategy: effective-value accumulation, largest first.
 *   1. Drop UTXOs whose value does not cover the fee their own input adds.
 *   2. Sort the rest by value descending (ties: txid, then vout — stable across runs).
 *   3. Add inputs until Σvalue ≥ targets + fee(no-change tx).
 *   4. If what is left after a change output is ≥ the change dust threshold, keep
 *      the change; otherwise fold it into the fee (one output less).
 *   5. More than `maxInputs` inputs → TooManyInputsError.
 *
 * Fees are feeRate × vsize, vsize = ceil(weight / 4) with the standard
 * segwit weights (see address.ts). The p2wpkh input estimate assumes a 72-byte
 * DER signature, so the estimate is an upper bound for lowR signatures.
 */
import { InsufficientFundsError } from '@forgewallet/core'
import { TooManyInputsError } from './errors.js'
import type { Utxo } from './types.js'

export const MAX_UTXO_INPUTS = 200

/** Version 4 + locktime 4 + input count 1 + output count 1 = 10 B × 4, plus segwit marker + flag (2 WU). */
const OVERHEAD_WEIGHT = 42

export interface SelectionTarget {
  value: bigint
  /** vbytes the output occupies (see `outputVBytes`). */
  vbytes: number
}

export interface CoinSelectOptions {
  utxos: Utxo[]
  targets: SelectionTarget[]
  /** sat/vB, ≥ 1. */
  feeRate: bigint
  /** Weight units one of our inputs adds (`INPUT_WEIGHT[addressType]`). */
  inputWeight: number
  /** vbytes a change output to our own address occupies. */
  changeVBytes: number
  /** Dust threshold for our change output type. */
  changeDust: bigint
  maxInputs?: number
}

export interface CoinSelection {
  utxos: Utxo[]
  fee: bigint
  /** Change back to us; 0n when folded into the fee. */
  change: bigint
  /** True when change existed but fell below dust and became fee. */
  changeFolded: boolean
  /** Estimated vsize of the final transaction. */
  vsize: number
  feeRate: bigint
}

export function estimateVsize(inputs: number, inputWeight: number, outputVBytes: number[]): number {
  const outputWeight = outputVBytes.reduce((s, vb) => s + vb * 4, 0)
  // Count varints grow past 252 entries; one extra byte each covers up to 65535.
  const extra = (inputs > 252 ? 2 : 0) + (outputVBytes.length > 252 ? 2 : 0)
  return Math.ceil((OVERHEAD_WEIGHT + extra * 4 + inputs * inputWeight + outputWeight) / 4)
}

const cmpUtxo = (a: Utxo, b: Utxo): number =>
  a.value > b.value ? -1 : a.value < b.value ? 1 : a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout

/** UTXOs worth spending at this fee rate, largest first. */
export function spendableUtxos(utxos: Utxo[], feeRate: bigint, inputWeight: number): Utxo[] {
  const inputFee = BigInt(Math.ceil(inputWeight / 4)) * feeRate
  return utxos.filter((u) => u.value > inputFee).sort(cmpUtxo)
}

export function selectCoins(o: CoinSelectOptions): CoinSelection {
  if (o.feeRate < 1n) throw new Error('feeRate must be at least 1 sat/vB')
  const maxInputs = o.maxInputs ?? MAX_UTXO_INPUTS
  const targetSum = o.targets.reduce((s, t) => s + t.value, 0n)
  const targetVB = o.targets.map((t) => t.vbytes)
  const candidates = spendableUtxos(o.utxos, o.feeRate, o.inputWeight)
  const available = o.utxos.reduce((s, u) => s + u.value, 0n)

  const feeFor = (n: number, withChange: boolean) =>
    BigInt(estimateVsize(n, o.inputWeight, withChange ? [...targetVB, o.changeVBytes] : targetVB)) * o.feeRate

  const selected: Utxo[] = []
  let sum = 0n
  for (const u of candidates) {
    if (selected.length >= maxInputs) throw new TooManyInputsError(maxInputs)
    selected.push(u)
    sum += u.value
    const n = selected.length
    const feeNoChange = feeFor(n, false)
    if (sum < targetSum + feeNoChange) continue
    const feeWithChange = feeFor(n, true)
    const change = sum - targetSum - feeWithChange
    if (change >= o.changeDust) {
      return { utxos: selected, fee: feeWithChange, change, changeFolded: false, vsize: estimateVsize(n, o.inputWeight, [...targetVB, o.changeVBytes]), feeRate: o.feeRate }
    }
    return { utxos: selected, fee: sum - targetSum, change: 0n, changeFolded: sum - targetSum > feeNoChange, vsize: estimateVsize(n, o.inputWeight, targetVB), feeRate: o.feeRate }
  }
  const need = targetSum + feeFor(Math.max(selected.length, 1), false)
  throw new InsufficientFundsError(need, available, 'BTC')
}

/** Sweep: every spendable input (largest first, capped), one output, no change. */
export function selectAll(o: Omit<CoinSelectOptions, 'targets' | 'changeVBytes' | 'changeDust'> & { outputVBytes: number }): { utxos: Utxo[]; fee: bigint; amount: bigint; vsize: number } {
  const maxInputs = o.maxInputs ?? MAX_UTXO_INPUTS
  const utxos = spendableUtxos(o.utxos, o.feeRate, o.inputWeight).slice(0, maxInputs)
  if (utxos.length === 0) return { utxos, fee: 0n, amount: 0n, vsize: 0 }
  const vsize = estimateVsize(utxos.length, o.inputWeight, [o.outputVBytes])
  const fee = BigInt(vsize) * o.feeRate
  const amount = utxos.reduce((s, u) => s + u.value, 0n) - fee
  return { utxos, fee, amount: amount > 0n ? amount : 0n, vsize }
}
