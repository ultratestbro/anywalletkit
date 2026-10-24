import { describe, expect, it, vi } from 'vitest'
import type { CrossChainProvider, Quote, QuoteParams, Swap2ExecutionPlan } from '@anywalletkit/protocol-swap2-core'
import { ApprovalQueue, ReviewDeclined, ReviewGate, encodeApproveCalldata, executionFloor, memoryApprovalWindow, planMatchers, quoteRoutes, reviewSwapPlan, swapApprovalPayload, type RouteListView, type SwapApproval } from '../src/index.js'

const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const flush = () => new Promise((r) => setTimeout(r, 0))

const params: QuoteParams = { sourceChain: 'eip155:1', sourceToken: 'ETH', destChain: 'eip155:8453', destToken: USDC, amountIn: '1000000000000000000', destAddress: A }

function quote(provider: string, dest: string, eta: number, feeUsd = 1): Quote {
  return { provider, intentId: `${provider}-1`, depositAddress: '', depositMemo: null, sourceAmount: params.amountIn, destAmount: dest, minDestAmount: (BigInt(dest) * 99n / 100n).toString(), feeUsd, etaSeconds: eta, reliability: 0.9, validUntilMs: Date.now() + 60_000 }
}

function provider(name: string, impl: Partial<CrossChainProvider> & { quote?: (p: QuoteParams) => Promise<Quote | null> }): CrossChainProvider {
  return {
    name,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: impl.quote ?? (async () => null),
    buildDeposit: async () => ({}) as never,
    trackIntent: async () => ({ state: 'pending' as const }),
    ...impl,
  }
}

describe('quoteRoutes', () => {
  it('streams quotes as providers answer, tags best and fastest, names every refusal', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((r) => { releaseSlow = r })
    const providers = [
      provider('fast', { quote: async () => quote('fast', '2990000000', 20) }),
      provider('rich', { quote: async () => { await slow; return quote('rich', '3000000000', 600, 0) } }),
      provider('refuses', { quote: async (p: QuoteParams) => { p.onRefusal?.('amount below the venue minimum'); return null } }),
      provider('throws', { quote: async () => { throw new Error('HTTP 429') } }),
      provider('dark', { enabled: () => false }),
      provider('elsewhere', { supportsRoute: () => false }),
      provider('pool', { quote: async () => ({ ...quote('pool', '2980000000', 15, 0), providerData: { poolFee: '0.05%' } }) }),
    ]
    const views: RouteListView[] = []
    const done = quoteRoutes(providers, params, { onUpdate: (v) => views.push(v) })
    await flush(); await flush()
    const mid = views.at(-1)!
    expect(mid.pending).toEqual(['rich'])
    expect(mid.routes.map((r) => r.provider)).toEqual(['fast', 'pool'])
    expect(mid.routes[0]!.tags).toEqual(['best'])
    expect(mid.routes[1]!.tags).toEqual(['fastest'])
    expect(mid.routes[1]!.feeNote).toBe('pool 0.05% in price')
    expect(mid.refusals).toMatchObject({ refuses: 'amount below the venue minimum', throws: 'HTTP 429', elsewhere: 'does not serve this pair' })
    expect('dark' in mid.refusals).toBe(false)
    releaseSlow()
    const final = await done
    expect(final.pending).toEqual([])
    expect(final.routes.map((r) => [r.provider, r.tags])).toEqual([['rich', ['best']], ['fast', []], ['pool', ['fastest']]])
    expect(Object.keys(final.quotes).sort()).toEqual(['fast', 'pool', 'rich'])
    expect(views[0]!.pending.sort()).toEqual(['fast', 'pool', 'refuses', 'rich', 'throws'])
  })

  it('times out a silent provider and refuses same-chain pairs for providers without the flag', async () => {
    const providers = [
      provider('silent', { supportsSameChain: true, quote: () => new Promise(() => undefined) }),
      provider('same', { supportsSameChain: true, quote: async () => quote('same', '1000000', 1) }),
      provider('cross-only', { quote: async () => quote('cross-only', '2000000', 1) }),
    ]
    const view = await quoteRoutes(providers, { ...params, destChain: 'eip155:1' }, { timeoutMs: 20 })
    expect(view.refusals.silent).toMatch(/no answer within/)
    expect(view.refusals['cross-only']).toBe('does not do same-chain swaps')
    expect(view.routes.map((r) => r.provider)).toEqual(['same'])
    // an invalid quote (wrong provider name) is refused, never shown
    const bad = await quoteRoutes([provider('liar', { quote: async () => quote('other', '5000000', 1) })], params)
    expect(bad.refusals.liar).toBe('returned an invalid quote')
  })

  it('execution floor rides 50 bps of drift', () => {
    expect(executionFloor(10_000n)).toBe(9_950n)
    expect(executionFloor(1n)).toBe(1n)
  })
})

const plan: Swap2ExecutionPlan = {
  provider: 'lifi', fromChain: 'eip155:1', destChain: 'eip155:8453', destToken: USDC, recipient: A, refundAddress: A,
  sourceAmount: 1_000_000n, destAmount: 990_000n, minDestAmount: 980_000n, feeUsd: 0.4, etaSeconds: 120, validUntilMs: Date.now() + 60_000,
  approvals: [{ token: USDC, spender: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', amount: 1_000_000n }],
  source: { kind: 'call', to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xdeadbeef', value: 0n },
}
const meta = { origin: 'chrome-extension://x', providerLabel: 'LI.FI', fromSymbol: 'USDC', fromDecimals: 6, toSymbol: 'USDC', toDecimals: 6, fromChainName: 'Ethereum', toChainName: 'Base', own: [A] }

describe('reviewSwapPlan', () => {
  it('builds the sheet payload and, on approval, pre-approves exactly the plan operations', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const review = reviewSwapPlan(approvals, gate, meta)
    const p = review(plan)
    await flush()
    const payload = window.opened[0]!.payload as SwapApproval
    expect(window.opened[0]!.kind).toBe('swap')
    expect(payload).toMatchObject({ provider: 'lifi', send: { symbol: 'USDC', amount: '1000000' }, receive: { amount: '990000', min: '980000' }, recipient: { address: A, isOwn: true }, approvals: [{ amount: '1000000' }], source: { kind: 'call', to: plan.source.kind === 'call' ? plan.source.to : '' } })
    expect(payload.checks.map((c) => c.label)).toEqual(['Built by the LI.FI module', 'Calls the LI.FI contract', 'Approval is exactly the amount needed', 'Funds arrive at your address'])
    expect(gate.pending).toBe(0) // nothing passes before the user answers
    approvals.resolve(window.opened[0]!.id, null)
    await p
    expect(gate.pending).toBe(2)
    // the approval, then the leg — each once, in any order, nothing else
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: USDC, data: encodeApproveCalldata(plan.approvals[0]!.spender, 1_000_000n), value: 0n })).toBe(true)
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xdeadbeef', value: 1n })).toBe(false) // different value
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xDEADBEEF', value: 0n })).toBe(true)
    expect(gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xdeadbeef', value: 0n })).toBe(false) // spent
  })

  it('decline → ReviewDeclined, nothing pre-approved; foreign recipient and oversized approval are warned', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const other = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
    const p = reviewSwapPlan(approvals, gate, meta)({ ...plan, recipient: other, approvals: [{ ...plan.approvals[0]!, amount: 2n ** 255n }] })
    await flush()
    const payload = window.opened[0]!.payload as SwapApproval
    expect(payload.checks.filter((c) => c.status === 'warn').map((c) => c.label)).toEqual(['Approval is larger than this swap needs', `Funds arrive at ${other.slice(0, 6)}…${other.slice(-4)}, not your address`])
    approvals.decline(window.opened[0]!.id)
    await expect(p).rejects.toBeInstanceOf(ReviewDeclined)
    expect(gate.pending).toBe(0)
  })

  it('matchers cover deposit-address, Solana and serialized legs', () => {
    const deposit = planMatchers({ ...plan, approvals: [], source: { kind: 'call', to: '0x000000000000000000000000000000000000dEaD', value: 5n } })
    expect(deposit).toHaveLength(1)
    expect(deposit[0]!({ kind: 'evm-tx', caip2: 'eip155:1', to: '0x000000000000000000000000000000000000dead', value: 5n })).toBe(true)
    const sol = planMatchers({ ...plan, fromChain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', approvals: [], source: { kind: 'token-transfer', token: 'EPjF', recipient: 'Dep0sit', amount: 7n } })
    expect(sol[0]!({ kind: 'solana-transfer', to: 'Dep0sit', amount: 7n, token: 'EPjF' })).toBe(true)
    expect(sol[0]!({ kind: 'solana-transfer', to: 'Dep0sit', amount: 8n, token: 'EPjF' })).toBe(false)
    const ser = planMatchers({ ...plan, fromChain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', approvals: [], source: { kind: 'serialized', serializedTx: 'AQID' } })
    expect(ser[0]!({ kind: 'solana-serialized', serializedTx: 'AQID' })).toBe(true)
    expect(ser[0]!({ kind: 'solana-serialized', serializedTx: 'BBBB' })).toBe(false)
    const payload = swapApprovalPayload({ ...plan, approvals: [], source: { kind: 'call', to: '0x000000000000000000000000000000000000dEaD', value: 5n } }, meta)
    expect(payload.source).toMatchObject({ kind: 'call', deposit: '0x000000000000000000000000000000000000dEaD' })
    expect(payload.checks.map((c) => c.label)).toContain('Deposit address from the LI.FI quote')
  })
})

describe('execution gate with a stub engine', () => {
  it('nothing is signed before the sheet is approved; after approval exactly the plan goes through', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const signed: string[] = []
    // the reviewed account: a send passes only with a pre-approval
    const account = {
      sendTransaction: vi.fn(async (tx: { to: string; data?: string; value: bigint }) => {
        if (!gate.consume({ kind: 'evm-tx', caip2: 'eip155:1', to: tx.to, ...(tx.data ? { data: tx.data } : {}), value: tx.value })) throw new Error('not reviewed')
        signed.push(tx.to)
        return { hash: `0x${signed.length}` }
      }),
    }
    // a stub of the engine's swap2(): review first, then approval + leg
    const engine = async (review: (p: Swap2ExecutionPlan) => Promise<void>) => {
      await review(plan)
      for (const a of plan.approvals) await account.sendTransaction({ to: a.token, data: encodeApproveCalldata(a.spender, a.amount), value: 0n })
      const s = plan.source as Extract<Swap2ExecutionPlan['source'], { kind: 'call' }>
      return account.sendTransaction({ to: s.to, data: s.data!, value: s.value })
    }
    const declined = engine(reviewSwapPlan(approvals, gate, meta))
    await flush()
    approvals.decline(window.opened[0]!.id)
    await expect(declined).rejects.toBeInstanceOf(ReviewDeclined)
    expect(account.sendTransaction).not.toHaveBeenCalled()

    const approved = engine(reviewSwapPlan(approvals, gate, meta))
    await flush()
    approvals.resolve(window.opened[1]!.id, null)
    expect(await approved).toEqual({ hash: '0x2' })
    expect(signed).toEqual([USDC, '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'])
    // a third, unplanned send stops again
    await expect(account.sendTransaction({ to: USDC, value: 0n })).rejects.toThrow('not reviewed')
  })
})
