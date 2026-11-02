import type { IWalletAccount } from '@anywalletkit/core'
import { ME, OTHER, ROUTER } from './swap-modules.js'

// A swap2 module that reviews a given source leg and then sends it, for the plan shapes the
// behaviour suite reads without tx-preview (typed orders, Tron/TON calls) or warns on (unreadable calldata).
export const ME_TRON = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
export const TRON_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
export const TRON_STRANGER = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'
const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).toLowerCase().padStart(64, '0')

type Source = { kind: 'call'; to: string; data?: string; value: bigint } | { kind: 'typed-order'; typedData: string }
export const planModule = (source: (amount: bigint) => Source) => class {
  constructor(readonly account: IWalletAccount, readonly cfg: { reviewExecution: (p: unknown) => unknown }) {}
  async quoteSwap2() { return { amountOut: 1n } }
  async swap2(o: { fromTokenAmount: bigint }) {
    const me = await this.account.getAddress()
    const plan = { recipient: me, refundAddress: me, sourceAmount: o.fromTokenAmount, approvals: [], source: source(o.fromTokenAmount) }
    await this.cfg.reviewExecution(plan)
    const s = plan.source
    return s.kind === 'call'
      ? this.account.sendTransaction({ to: s.to, data: s.data, value: s.value } as never)
      : this.account.sign(s.typedData)
  }
}

/** A Tron router call that pays `who` (the fixture's decode reads it), with the input as native value. */
export const tronCall = (to: string) => (amount: bigint): Source => ({ kind: 'call', to, data: `0x7ff36ab5${w(1n)}${w(`0x${'11'.repeat(20)}`)}`, value: amount })
export const typedOrder = (): Source => ({ kind: 'typed-order', typedData: JSON.stringify({ domain: { name: 'Order', chainId: 1 }, types: { Order: [{ name: 'receiver', type: 'address' }] }, primaryType: 'Order', message: { receiver: ME } }) })

export const planFixture = (name: string, extra: Record<string, unknown> = {}) => ({
  name, options: { fromTokenAmount: 1_000_000n, minAmountOut: 1n }, fetch: (async () => new Response('{}')) as typeof fetch,
  account: { address: ME, chain: 'eip155:1' }, callTargets: [ROUTER], decode: () => [ME], ...extra,
})
export { ME, OTHER, ROUTER }
