import { base58 } from '@scure/base'
import { NearRpcError, decodeSignedTransaction, fromBase64, type NearFetch } from '../src/index.js'

export const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const ACCOUNT0 = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
export const USDT = 'usdt.tether-token.near'
export const BLOCK = base58.encode(new Uint8Array(32).fill(9))
export const NEAR = 10n ** 24n

/** Minimal fake node: accounts, access keys, a NEP-141 contract, gas price, send_tx capture. */
export function fakeNode(opts: { balance?: bigint; usdt?: bigint; registered?: string[]; accounts?: string[]; failOnChain?: string; storageMin?: unknown } = {}) {
  const sent: string[] = []
  const accounts = new Set(opts.accounts ?? [ACCOUNT0, 'alice.near', USDT])
  const registered = new Set(opts.registered ?? [ACCOUNT0])
  const rpcError = (name: string) => ({ name: 'HANDLER_ERROR', cause: { name } })
  const fetch: NearFetch = async (method, params) => {
    const p = params as Record<string, unknown>
    if (method === 'gas_price') return { gas_price: '100000000' }
    if (method === 'block') return { header: { hash: BLOCK, height: 100 } }
    if (method === 'query') {
      if (p.request_type === 'view_account') {
        if (!accounts.has(p.account_id as string)) throw new NearRpcError('query', rpcError('UNKNOWN_ACCOUNT'))
        return { amount: String(opts.balance ?? 5n * NEAR), locked: '0', storage_usage: 182 }
      }
      if (p.request_type === 'view_access_key') return { nonce: 41, permission: 'FullAccess' }
      if (p.request_type === 'call_function') {
        const args = JSON.parse(Buffer.from(p.args_base64 as string, 'base64').toString()) as Record<string, string>
        const json = (v: unknown) => ({ result: Array.from(Buffer.from(JSON.stringify(v))), logs: [] })
        if (p.method_name === 'ft_balance_of') return json(String(args.account_id === ACCOUNT0 ? (opts.usdt ?? 10_000_000n) : 0n))
        if (p.method_name === 'storage_balance_of') return json(registered.has(args.account_id!) ? { total: '1250000000000000000000', available: '0' } : null)
        if (p.method_name === 'storage_balance_bounds') return json({ min: opts.storageMin ?? '1250000000000000000000', max: '1250000000000000000000' })
      }
    }
    if (method === 'send_tx') {
      sent.push(p.signed_tx_base64 as string)
      const tx = decodeSignedTransaction(fromBase64(p.signed_tx_base64 as string))
      const fail = opts.failOnChain ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: opts.failOnChain } } } } } : { SuccessValue: '' }
      return { status: fail, transaction: { hash: 'HASH' + tx.transaction.nonce }, receipts_outcome: [{ outcome: { status: fail } }] }
    }
    if (method === 'tx') return { status: { SuccessValue: '' }, final_execution_status: 'FINAL', transaction: { hash: p.tx_hash } }
    throw new Error(`unmocked ${method} ${JSON.stringify(params)}`)
  }
  return { fetch, sent }
}

