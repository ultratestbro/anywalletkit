import { Transaction } from '@scure/btc-signer'
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js'
import { hex } from '@scure/base'
import { dustLimit, scriptKind } from './address.js'
import { UnsafeTransactionError } from './errors.js'
import type { BtcTxDescription, BtcTxOutputDescription, BtcWarning } from './types.js'

/** Default fee-rate ceiling, sat/vB; a spend above it is refused. */
export const DEFAULT_MAX_FEE_RATE = 500
/** Replace-by-fee signalling: any sequence below 0xfffffffe (BIP-125). */
export const RBF_SEQUENCE = 0xfffffffd
/** Opts out of RBF while still letting nLockTime apply. */
export const FINAL_SEQUENCE = 0xfffffffe

/** What a description needs to tell recipient, change and unknown outputs apart. */
export interface DescribeContext {
  network: BTC_NETWORK
  /** Our own address: outputs paying it are tagged `change`. */
  ownAddress: string
  /** The spend the caller asked for. Outputs matching it are `recipient`; anything else is `unknown`. */
  intended?: { to: string; value: bigint } | undefined
  maxFeeRate?: number | undefined
}

/** Parse raw tx hex. Prevout amounts are not in the wire format — callers pass them in `inputValues`. */
export function parseRawTransaction(rawHex: string): Transaction {
  return Transaction.fromRaw(hex.decode(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true })
}

/** Signed: exact vsize. Unsigned: the non-witness serialisation length (exact for legacy inputs, a lower bound for segwit). */
export function vsizeOf(tx: Transaction): number {
  try { return tx.vsize } catch { return tx.unsignedTx.length }
}

/**
 * Describe a (signed or unsigned) btc-signer Transaction given the sat value of
 * every input, in input order. Pure: no network, no signing.
 */
export function describeTransaction(tx: Transaction, inputValues: bigint[], ctx: DescribeContext): BtcTxDescription {
  if (inputValues.length !== tx.inputsLength) throw new Error(`describeTransaction: ${tx.inputsLength} inputs but ${inputValues.length} values`)
  const inputs = Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i)
    return { txid: inp.txid ? hex.encode(inp.txid) : '', vout: inp.index ?? 0, value: inputValues[i]! }
  })
  const outputs: BtcTxOutputDescription[] = []
  const warnings = new Set<BtcWarning>()
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    const value = out.amount ?? 0n
    const address = tx.getOutputAddress(i, ctx.network)
    const role: BtcTxOutputDescription['role'] =
      address !== undefined && address === ctx.ownAddress ? 'change'
      : ctx.intended === undefined ? 'recipient'
      : address !== undefined && address === ctx.intended.to && value === ctx.intended.value ? 'recipient'
      : 'unknown'
    if (out.script && value < dustLimit(scriptKind(out.script))) warnings.add('dust-output')
    outputs.push({ address, value, role })
  }
  const inputSum = inputs.reduce((s, i) => s + i.value, 0n)
  const outputSum = outputs.reduce((s, o) => s + o.value, 0n)
  const fee = inputSum - outputSum
  const amount = outputs.filter((o) => o.role !== 'change').reduce((s, o) => s + o.value, 0n)
  const vsize = vsizeOf(tx)
  const feeRate = vsize > 0 ? Math.round((Number(fee) / vsize) * 100) / 100 : 0
  if (feeRate > (ctx.maxFeeRate ?? DEFAULT_MAX_FEE_RATE)) warnings.add('high-fee-rate')
  if (amount > 0n && fee * 10n > amount) warnings.add('fee-over-10pct-of-amount')
  if (!outputs.some((o) => o.role === 'change')) warnings.add('no-change')
  let rbf = false
  for (let i = 0; i < tx.inputsLength; i++) if ((tx.getInput(i).sequence ?? 0xffffffff) < FINAL_SEQUENCE) rbf = true
  const desc: BtcTxDescription = { kind: 'btc-transfer', inputs, outputs, amount, fee, feeRate, vsize, rbf, lockTime: tx.lockTime, warnings: [...warnings] }
  if (tx.isFinal) desc.txid = tx.id
  return desc
}

/**
 * Hard checks run before signing and before broadcasting. Throws UnsafeTransactionError;
 * never mutates. With `intended`, exactly one output must be the requested
 * recipient/amount and every other output must be our change.
 */
export function assertSafe(desc: BtcTxDescription, ctx: DescribeContext): void {
  const maxFeeRate = ctx.maxFeeRate ?? DEFAULT_MAX_FEE_RATE
  if (desc.feeRate > maxFeeRate) {
    throw new UnsafeTransactionError('fee-rate-too-high', `Fee rate ${desc.feeRate} sat/vB exceeds the ${maxFeeRate} sat/vB ceiling (maxFeeRate).`)
  }
  if (desc.fee < 0n) throw new UnsafeTransactionError('unexpected-output', 'Outputs exceed inputs.')
  for (const o of desc.outputs) {
    if (o.role === 'change' && o.address !== ctx.ownAddress) throw new UnsafeTransactionError('change-not-ours', `Change output pays ${o.address ?? '<no address>'}, not ${ctx.ownAddress}.`)
  }
  if (ctx.intended) {
    const recipients = desc.outputs.filter((o) => o.role === 'recipient')
    if (recipients.length !== 1) throw new UnsafeTransactionError('recipient-mismatch', `Expected one output of ${ctx.intended.value} sat to ${ctx.intended.to}, found ${recipients.length}.`)
    const unknown = desc.outputs.filter((o) => o.role === 'unknown')
    if (unknown.length) throw new UnsafeTransactionError('unexpected-output', `Transaction carries ${unknown.length} output(s) that are neither the recipient nor our change.`)
  }
}
