import { DUST_LIMIT, addressFromScript, outputSize, scriptKind } from './address.js'
import { conventionalFee } from './fee.js'
import { serializeTx, txid as txidOf, type TransparentTxV5 } from './tx.js'
import type { SpentOutput, ZcashNetwork, ZcashTxDescription, ZcashTxOutputDescription, ZcashWarning } from './types.js'

/** Default hard fee ceiling: 0.01 ZEC. */
export const DEFAULT_MAX_FEE = 1_000_000n

export type UnsafeTransactionCode =
  /** Fee above `maxFee`. */
  | 'fee-too-high'
  /** Outputs exceed inputs. */
  | 'outputs-exceed-inputs'
  /** An output that is neither the requested recipient/amount nor our change. */
  | 'unexpected-output'
  /** The recipient output is missing or carries a different amount. */
  | 'recipient-mismatch'
  /** A change output pays an address that is not ours. */
  | 'change-not-ours'

/** A transaction failed a hard safety check and was not signed / broadcast. */
export class UnsafeTransactionError extends Error {
  readonly code: UnsafeTransactionCode
  constructor(code: UnsafeTransactionCode, message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
  }
}

export interface DescribeContext {
  network: ZcashNetwork
  /** Our own address: outputs paying it are tagged `change`. */
  ownAddress: string
  /** The spend the caller asked for. Outputs matching it are `recipient`; anything else is `unknown`. */
  intended?: { to: string; value: bigint } | undefined
  maxFee?: bigint | undefined
}

/** Byte size of a serialized input (what ZIP-317 counts). */
function inputSizes(tx: TransparentTxV5): number[] {
  return tx.inputs.map((i) => 32 + 4 + (i.scriptSig.length < 0xfd ? 1 : 3) + i.scriptSig.length + 4)
}

/** Describe a (signed or unsigned) transaction given the output every input spends. Pure: no network, no signing. */
export function describeTransaction(tx: TransparentTxV5, spent: SpentOutput[], ctx: DescribeContext): ZcashTxDescription {
  if (spent.length !== tx.inputs.length) throw new Error(`describeTransaction: ${tx.inputs.length} inputs but ${spent.length} spent outputs`)
  const inputs = tx.inputs.map((i, k) => ({ txid: i.txid, vout: i.vout, value: spent[k]!.value, address: addressFromScript(spent[k]!.script, ctx.network) }))
  const outputs: ZcashTxOutputDescription[] = []
  const warnings = new Set<ZcashWarning>()
  for (const o of tx.outputs) {
    const address = addressFromScript(o.script, ctx.network)
    const role: ZcashTxOutputDescription['role'] =
      address !== undefined && address === ctx.ownAddress ? 'change'
      : ctx.intended === undefined ? 'recipient'
      : address !== undefined && address === ctx.intended.to && o.value === ctx.intended.value ? 'recipient'
      : 'unknown'
    if (scriptKind(o.script) !== 'unknown' && o.value < DUST_LIMIT) warnings.add('dust-output')
    outputs.push({ address, value: o.value, role })
  }
  const inputSum = spent.reduce((s, c) => s + c.value, 0n)
  const outputSum = tx.outputs.reduce((s, o) => s + o.value, 0n)
  const fee = inputSum - outputSum
  const amount = outputs.filter((o) => o.role !== 'change').reduce((s, o) => s + o.value, 0n)
  const conv = conventionalFee(inputSizes(tx), tx.outputs.map((o) => outputSize(o.script)))
  if (fee < conv) warnings.add('fee-below-conventional')
  if (amount > 0n && fee * 10n > amount) warnings.add('fee-over-10pct-of-amount')
  if (!outputs.some((o) => o.role === 'change')) warnings.add('no-change')
  if (tx.expiryHeight === 0) warnings.add('no-expiry')
  const signed = tx.inputs.length > 0 && tx.inputs.every((i) => i.scriptSig.length > 0)
  const desc: ZcashTxDescription = {
    kind: 'zcash-transfer', version: 5, consensusBranchId: tx.consensusBranchId, inputs, outputs, amount, fee, conventionalFee: conv,
    size: serializeTx(tx).length, lockTime: tx.lockTime, expiryHeight: tx.expiryHeight, warnings: [...warnings],
  }
  if (signed) desc.txid = txidOf(tx)
  return desc
}

/**
 * Hard checks run before signing and before broadcasting. Throws UnsafeTransactionError;
 * never mutates. With `intended`, exactly one output must be the requested
 * recipient/amount and every other output must be our change.
 */
export function assertSafe(desc: ZcashTxDescription, ctx: DescribeContext): void {
  const maxFee = ctx.maxFee ?? DEFAULT_MAX_FEE
  if (desc.fee < 0n) throw new UnsafeTransactionError('outputs-exceed-inputs', 'Outputs exceed inputs.')
  if (desc.fee > maxFee) throw new UnsafeTransactionError('fee-too-high', `Fee ${desc.fee} zatoshis exceeds the ${maxFee} zatoshi ceiling (maxFee).`)
  for (const o of desc.outputs) {
    if (o.role === 'change' && o.address !== ctx.ownAddress) throw new UnsafeTransactionError('change-not-ours', `Change output pays ${o.address ?? '<no address>'}, not ${ctx.ownAddress}.`)
  }
  if (ctx.intended) {
    const recipients = desc.outputs.filter((o) => o.role === 'recipient')
    if (recipients.length !== 1) throw new UnsafeTransactionError('recipient-mismatch', `Expected one output of ${ctx.intended.value} zatoshis to ${ctx.intended.to}, found ${recipients.length}.`)
    const unknown = desc.outputs.filter((o) => o.role === 'unknown')
    if (unknown.length) throw new UnsafeTransactionError('unexpected-output', `Transaction carries ${unknown.length} output(s) that are neither the recipient nor our change.`)
  }
}
