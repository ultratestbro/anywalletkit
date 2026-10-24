/**
 * ZIP-317 fees and coin selection.
 *
 * conventional_fee = marginal_fee · max(grace_actions, logical_actions)
 *   marginal_fee = 5000 zatoshis, grace_actions = 2,
 *   transparent logical actions = max(ceil(Σ tx_in bytes / 150), ceil(Σ tx_out bytes / 34)).
 *
 * The fee depends on the number of inputs and outputs, not on a market rate,
 * so selection is simple: largest-first accumulation until the inputs cover
 * amount + fee, change kept when it clears the dust floor.
 */
import { InsufficientFundsError } from '@anywalletkit/core'
import { DUST_LIMIT } from './address.js'
import type { Utxo } from './types.js'

export const MARGINAL_FEE = 5_000n
export const GRACE_ACTIONS = 2
export const P2PKH_STANDARD_INPUT_SIZE = 150
export const P2PKH_STANDARD_OUTPUT_SIZE = 34
/** Serialized size of one signed P2PKH input: prevout 36 + CompactSize 1 + scriptSig (1+73+1+33) + sequence 4. */
export const P2PKH_INPUT_SIZE = 149
/** Most inputs one spend may use. */
export const MAX_UTXO_INPUTS = 200

export function logicalActions(inputSizes: readonly number[], outputSizes: readonly number[]): number {
  const inBytes = inputSizes.reduce((s, n) => s + n, 0)
  const outBytes = outputSizes.reduce((s, n) => s + n, 0)
  return Math.max(Math.ceil(inBytes / P2PKH_STANDARD_INPUT_SIZE), Math.ceil(outBytes / P2PKH_STANDARD_OUTPUT_SIZE))
}

/** The fee a transaction of this shape should pay (zatoshis). */
export function conventionalFee(inputSizes: readonly number[], outputSizes: readonly number[]): bigint {
  return MARGINAL_FEE * BigInt(Math.max(GRACE_ACTIONS, logicalActions(inputSizes, outputSizes)))
}

/** Transaction size estimate: v5 header 20 + counts 2 + inputs + outputs + 3 empty bundle counts. */
export function estimateSize(inputs: number, outputSizes: readonly number[]): number {
  const cs = (n: number) => (n < 0xfd ? 1 : 3)
  return 20 + cs(inputs) + inputs * P2PKH_INPUT_SIZE + cs(outputSizes.length) + outputSizes.reduce((s, n) => s + n, 0) + 3
}

/** A spend would need more inputs than allowed; consolidate the UTXOs first. */
export class TooManyInputsError extends Error {
  readonly maxInputs: number
  constructor(maxInputs: number) {
    super(`The spend needs more than ${maxInputs} inputs; consolidate the UTXOs first or raise maxInputs.`)
    this.name = 'TooManyInputsError'
    this.maxInputs = maxInputs
  }
}

/** Input to {@link selectCoins}. */
export interface CoinSelectOptions {
  utxos: Utxo[]
  /** Zatoshis the recipient gets. */
  target: bigint
  /** Serialized size of the recipient output. */
  recipientOutputSize: number
  /** Serialized size of a change output to our own address. */
  changeOutputSize: number
  changeDust?: bigint
  maxInputs?: number
  /** Caller-chosen fee (replaces the conventional fee; still has to be covered by the inputs). */
  fee?: bigint
}

/** UTXOs chosen for a spend, the ZIP-317 fee and the change. */
export interface CoinSelection {
  utxos: Utxo[]
  fee: bigint
  /** The ZIP-317 fee for the chosen shape (equals `fee` unless the caller overrode it or change was folded in). */
  conventionalFee: bigint
  /** Change back to us; 0n when folded into the fee. */
  change: bigint
  /** True when change existed but fell below dust and became fee. */
  changeFolded: boolean
  size: number
}

const cmpUtxo = (a: Utxo, b: Utxo): number =>
  a.value > b.value ? -1 : a.value < b.value ? 1 : a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout

/** UTXOs worth spending (each adds at most one logical action = 5000 zatoshis), largest first. */
export function spendableUtxos(utxos: Utxo[]): Utxo[] {
  return utxos.filter((u) => u.value > MARGINAL_FEE).sort(cmpUtxo)
}

/**
 * Pick UTXOs to fund `target` at the ZIP-317 fee; change below dust joins the fee.
 *
 * @throws `InsufficientFundsError` (core) when the UTXOs cannot cover target plus fee,
 * `TooManyInputsError` above `maxInputs`.
 */
export function selectCoins(o: CoinSelectOptions): CoinSelection {
  const maxInputs = o.maxInputs ?? MAX_UTXO_INPUTS
  const dust = o.changeDust ?? DUST_LIMIT
  const candidates = spendableUtxos(o.utxos)
  const available = o.utxos.reduce((s, u) => s + u.value, 0n)
  const inputs = (n: number) => Array.from({ length: n }, () => P2PKH_INPUT_SIZE)
  const selected: Utxo[] = []
  let sum = 0n
  for (const u of candidates) {
    if (selected.length >= maxInputs) throw new TooManyInputsError(maxInputs)
    selected.push(u)
    sum += u.value
    const n = selected.length
    const convNoChange = conventionalFee(inputs(n), [o.recipientOutputSize])
    const feeNoChange = o.fee ?? convNoChange
    if (sum < o.target + feeNoChange) continue
    const convWithChange = conventionalFee(inputs(n), [o.recipientOutputSize, o.changeOutputSize])
    const feeWithChange = o.fee ?? convWithChange
    const change = sum - o.target - feeWithChange
    if (change >= dust) {
      return { utxos: selected, fee: feeWithChange, conventionalFee: convWithChange, change, changeFolded: false, size: estimateSize(n, [o.recipientOutputSize, o.changeOutputSize]) }
    }
    return { utxos: selected, fee: sum - o.target, conventionalFee: convNoChange, change: 0n, changeFolded: sum - o.target > feeNoChange, size: estimateSize(n, [o.recipientOutputSize]) }
  }
  const need = o.target + (o.fee ?? conventionalFee(inputs(Math.max(selected.length, 1)), [o.recipientOutputSize]))
  throw new InsufficientFundsError(need, available, 'ZEC')
}

/** Sweep: every spendable input (largest first, capped), one output, no change. */
export function selectAll(o: { utxos: Utxo[]; outputSize: number; maxInputs?: number; fee?: bigint }): { utxos: Utxo[]; fee: bigint; amount: bigint; size: number } {
  const maxInputs = o.maxInputs ?? MAX_UTXO_INPUTS
  const utxos = spendableUtxos(o.utxos).slice(0, maxInputs)
  if (utxos.length === 0) return { utxos, fee: 0n, amount: 0n, size: 0 }
  const fee = o.fee ?? conventionalFee(Array.from({ length: utxos.length }, () => P2PKH_INPUT_SIZE), [o.outputSize])
  const amount = utxos.reduce((s, u) => s + u.value, 0n) - fee
  return { utxos, fee, amount: amount > 0n ? amount : 0n, size: estimateSize(utxos.length, [o.outputSize]) }
}
