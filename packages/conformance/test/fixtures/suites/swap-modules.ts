import type { IWalletAccount } from '@anywalletkit/core'

// swap2 modules for the behaviour suite: they run to the review gate and then send exactly the plan,
// so only what the plan pays tells them apart.
export const ME = '0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba'
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481'
export const OTHER = '0x00000000000000000000000000000000000e0e01'
const w = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '')).toLowerCase().padStart(64, '0')
/** exactInputSingle((tokenIn, tokenOut, fee, recipient, amountIn, amountOutMin, sqrtPriceLimit)) */
const exactInputSingle = (recipient: string) => `0x04e45aaf${w(USDC)}${w('0x4200000000000000000000000000000000000006')}${w(500n)}${w(recipient)}${w(1_000_000n)}${w(0n)}${w(0n)}`
/** The recipient word of exactInputSingle calldata: what a fixture's `decode` reads. */
export const exactInputRecipient = (source: { kind: string; data?: string }) => [`0x${source.data!.slice(10 + 3 * 64 + 24, 10 + 4 * 64)}`]

type Mode = 'honest' | 'router' | 'stranger'
export class Swap {
  constructor(private account: IWalletAccount, private cfg: { reviewExecution: (p: unknown) => unknown; mode: Mode }) {}
  async quoteSwap2() { return { amountOut: 1n } }
  async swap2(o: { fromTokenAmount: bigint }) {
    const me = await this.account.getAddress()
    const plan = this.cfg.mode === 'stranger'
      ? { recipient: me, refundAddress: me, sourceAmount: o.fromTokenAmount, approvals: [], source: { kind: 'call', to: OTHER, data: '0xdeadbeef', value: o.fromTokenAmount } }
      : { recipient: me, refundAddress: me, sourceAmount: o.fromTokenAmount, approvals: [{ token: USDC, spender: ROUTER, amount: o.fromTokenAmount }], source: { kind: 'call', to: ROUTER, data: exactInputSingle(this.cfg.mode === 'honest' ? me : OTHER), value: 0n } }
    await this.cfg.reviewExecution(plan)
    for (const a of plan.approvals) await this.account.sendTransaction({ to: a.token, data: `0x095ea7b3${w(a.spender)}${w(a.amount)}`, value: 0n })
    return this.account.sendTransaction({ to: plan.source.to, data: plan.source.data, value: plan.source.value } as never)
  }
}

export const fixture = (name: string, extra: Record<string, unknown> = {}) => ({
  name, options: { fromTokenAmount: 1_000_000n, minAmountOut: 1n }, fetch: (async () => new Response('{}')) as typeof fetch,
  account: { address: ME, chain: 'eip155:8453' }, ...extra,
})
