import type { IWalletAccount, IWalletAccountReadOnly } from '@anywalletkit/core'
import type { NearAction, NearTransaction } from '@anywalletkit/wallet-near'
import type { NearTransactionsSender } from './types.js'

/** True when the account can send several transactions with one approval. */
export function canSendBatch(account: IWalletAccountReadOnly | IWalletAccount): account is IWalletAccount & NearTransactionsSender {
  return typeof (account as Partial<NearTransactionsSender>).sendTransactions === 'function'
}

const canonicalArgs = (args: unknown): unknown =>
  args instanceof Uint8Array ? { bytes: Array.from(args) } : typeof args === 'string' ? { text: args } : args

const canonicalAction = (a: NearAction): unknown => {
  if ('functionCall' in a) {
    const f = a.functionCall
    return { functionCall: { methodName: f.methodName, args: canonicalArgs(f.args), gas: String(f.gas ?? 0n), deposit: String(f.deposit ?? 0n) } }
  }
  if ('transfer' in a) return { transfer: { deposit: String(a.transfer.deposit) } }
  return { other: Object.keys(a)[0] }
}

/** Sorted-key JSON, so argument key order never makes two equal plans differ. */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(typeof v === 'bigint' ? String(v) : v)
}

/**
 * Same receivers, same actions, same order, same args, gas and deposits. Only function calls and
 * transfers are compared field by field; any other action kind never matches (the module builds none).
 */
export function sameTransactions(a: readonly NearTransaction[], b: readonly NearTransaction[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!
    if (x.receiverId !== y.receiverId || x.actions.length !== y.actions.length) return false
    for (let j = 0; j < x.actions.length; j++) {
      const ca = canonicalAction(x.actions[j]!), cb = canonicalAction(y.actions[j]!)
      if ((ca as { other?: unknown }).other !== undefined || stable(ca) !== stable(cb)) return false
    }
  }
  return true
}

/** A function-call action as the module builds them: plain JSON args, gas and deposit always set. */
export function fc(methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint): NearAction {
  return { functionCall: { methodName, args, gas, deposit } }
}

/** The only methods the module ever calls on a family contract. */
export const LIQUID_WRITE_METHODS: readonly string[] = ['deposit_and_stake', 'unstake', 'unstake_all', 'withdraw_all']

/**
 * Throws unless every transaction goes to `contract` and holds only function calls to
 * {@link LIQUID_WRITE_METHODS}. Runs on every plan before it is returned or sent. In particular it
 * refuses `ft_transfer` / `ft_transfer_call` to the contract: it has no `ft_on_transfer`, so tokens
 * (or "staking by transfer") sent that way are lost.
 */
export function assertLiquidPlan(transactions: readonly NearTransaction[], contract: string): void {
  for (const tx of transactions) {
    if (tx.receiverId !== contract) throw new Error(`Refusing a transaction to ${tx.receiverId}: liquid staking only calls ${contract}.`)
    if (tx.signerId !== undefined) throw new Error('Refusing a transaction with a signerId: the account signs as itself.')
    for (const a of tx.actions) {
      const method = 'functionCall' in a ? a.functionCall.methodName : null
      if (method === null) throw new Error(`Refusing a ${Object.keys(a)[0]} action: liquid staking sends function calls only.`)
      if (!LIQUID_WRITE_METHODS.includes(method)) throw new Error(`Refusing ${method} on ${contract}: liquid staking calls only ${LIQUID_WRITE_METHODS.join(', ')}${/^ft_transfer/.test(method) ? ' (the contract has no ft_on_transfer: tokens sent with ft_transfer_call are lost)' : ''}.`)
    }
  }
}
