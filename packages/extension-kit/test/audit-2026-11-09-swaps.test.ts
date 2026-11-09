/**
 * Extension audit 2026-11-09:
 * - E2: the wallet's own slippage — a route whose provider minimum sits further under its quote than the requested
 *   slippage is flagged (never refused, never hidden) and cannot be BEST; the swap sheet warns about it.
 * - E6: deposit-address routes (NEAR Intents 1Click) pay an address the provider's server assigned — flagged, not BEST
 *   while a route with verifiable calldata exists, warned on the sheet, and the recipient check does not pass on
 *   `plan.recipient` alone.
 */
import { describe, expect, it } from 'vitest'
import type { CrossChainProvider, Quote, QuoteParams, Swap2ExecutionPlan } from '@anywalletkit/protocol-swap2-core'
import { quoteRoutes, rank, swapApprovalPayload } from '../src/index.js'

const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const params: QuoteParams = { sourceChain: 'eip155:1', sourceToken: 'ETH', destChain: 'eip155:8453', destToken: USDC, amountIn: '1000000000000000000', destAddress: A }

/** A quote whose minimum is `minBps` under its output. */
function quote(provider: string, dest: bigint, minBps: bigint, eta = 60): Quote {
  return { provider, intentId: `${provider}-1`, depositAddress: '', depositMemo: null, sourceAmount: params.amountIn, destAmount: dest.toString(), minDestAmount: ((dest * (10_000n - minBps)) / 10_000n).toString(), feeUsd: 1, etaSeconds: eta, reliability: 0.9, validUntilMs: Date.now() + 60_000 }
}

function provider(name: string, q: Quote): CrossChainProvider {
  return { name, enabled: () => true, supportsRoute: () => true, getQuote: async () => q, buildDeposit: async () => ({}) as never, trackIntent: async () => ({ state: 'pending' as const }) }
}

describe('E2 — wallet-side slippage in the route list', () => {
  it('a route whose minimum is below the requested slippage is flagged and never BEST, even with the highest output', () => {
    const routes = rank([quote('thorchain', 3_100_000_000n, 9_000n), quote('lifi', 3_000_000_000n, 50n)], { slippageBps: 50 })
    expect(routes.map((r) => r.provider)).toEqual(['lifi', 'thorchain'])
    expect(routes[0]!.tags).toContain('best')
    expect(routes[1]!.tags).not.toContain('best')
    expect(routes[1]!.warnings).toEqual([{ kind: 'min-below-slippage', slippageBps: 50, minGapBps: 9_000 }])
    expect(routes[0]!.warnings ?? []).toEqual([])
  })

  it('without a slippage nothing is flagged (the previous ranking by output)', () => {
    const routes = rank([quote('thorchain', 3_100_000_000n, 9_000n), quote('lifi', 3_000_000_000n, 50n)])
    expect(routes.map((r) => [r.provider, r.tags])).toEqual([['thorchain', ['best', 'fastest']], ['lifi', []]])
    expect(routes.every((r) => (r.warnings ?? []).length === 0)).toBe(true)
  })

  it('quoteRoutes keeps (warns about) a quote under the slippage floor instead of refusing it', async () => {
    const view = await quoteRoutes([provider('chainflip', quote('chainflip', 3_100_000_000n, 400n)), provider('lifi', quote('lifi', 3_000_000_000n, 50n))], { ...params, slippageBps: 50 })
    expect(view.refusals).toEqual({})
    expect(Object.keys(view.quotes).sort()).toEqual(['chainflip', 'lifi'])
    expect(view.routes.map((r) => [r.provider, r.tags.includes('best'), (r.warnings ?? []).map((w) => w.kind)])).toEqual([['lifi', true, []], ['chainflip', false, ['min-below-slippage']]])
  })

  it('a minimum exactly at the slippage floor (provider rounding) is not flagged', () => {
    const dest = 1_234_567n
    const q = { ...quote('lifi', dest, 0n), minDestAmount: ((dest * 9_950n) / 10_000n).toString() }
    expect(rank([q], { slippageBps: 50 })[0]!.warnings ?? []).toEqual([])
  })

  it('the swap sheet warns loudly when the plan minimum is below the slippage — and still builds (warn, never block)', () => {
    const below = swapApprovalPayload({ ...plan, destAmount: 1_000_000n, minDestAmount: 900_000n }, { ...meta, slippageBps: 50 })
    expect(below.slippage).toEqual({ bps: 50, minGapBps: 1_000, below: true })
    expect(below.checks.filter((c) => c.status === 'warn').map((c) => c.label)).toEqual(['Minimum is 10% under the quote — more than your 0.5% slippage'])
    const within = swapApprovalPayload({ ...plan, destAmount: 1_000_000n, minDestAmount: 995_000n }, { ...meta, slippageBps: 50 })
    expect(within.slippage).toEqual({ bps: 50, minGapBps: 50, below: false })
    expect(within.checks.filter((c) => c.status === 'warn')).toEqual([])
    expect(within.checks.map((c) => c.label)).toContain('Minimum within your 0.5% slippage')
  })
})

describe('E6 — deposit addresses assigned by the provider server', () => {
  it('a deposit-address route is flagged and not BEST while a route with verifiable calldata exists', () => {
    const routes = rank([quote('near_intents', 3_100_000_000n, 50n, 30), quote('lifi', 3_000_000_000n, 50n)], { slippageBps: 50, depositAddressProviders: ['near_intents'] })
    expect(routes.map((r) => r.provider)).toEqual(['lifi', 'near_intents'])
    expect(routes[0]!.tags).toContain('best')
    expect(routes[1]!.tags).toEqual(['fastest'])
    expect(routes[1]!.warnings).toEqual([{ kind: 'deposit-address' }])
  })

  it('it stays available, and is BEST when it is the only route', () => {
    const routes = rank([quote('near_intents', 3_100_000_000n, 50n)], { depositAddressProviders: ['near_intents'] })
    expect(routes.map((r) => [r.provider, r.tags])).toEqual([['near_intents', ['best', 'fastest']]])
    expect(routes[0]!.warnings).toEqual([{ kind: 'deposit-address' }])
  })

  it('quoteRoutes takes the deposit-address providers from the app', async () => {
    const view = await quoteRoutes([provider('near_intents', quote('near_intents', 3_100_000_000n, 50n)), provider('lifi', quote('lifi', 3_000_000_000n, 50n))], params, { depositAddressProviders: ['near_intents'] })
    expect(view.routes.map((r) => [r.provider, r.tags.includes('best')])).toEqual([['lifi', true], ['near_intents', false]])
  })

  it('the sheet warns that the server assigned the deposit address, and the recipient check is not OK on plan.recipient', () => {
    const deposit: Swap2ExecutionPlan = { ...plan, provider: 'near_intents', approvals: [], source: { kind: 'token-transfer', token: USDC, recipient: '0x000000000000000000000000000000000000dEaD', amount: 1_000_000n } }
    const p = swapApprovalPayload(deposit, { ...meta, providerLabel: 'NEAR Intents', depositAddressAssignedByProvider: true })
    expect(p.depositAssignedByProvider).toBe(true)
    expect(p.checks.find((c) => c.label.startsWith('Deposit address'))).toEqual({ status: 'warn', label: 'Deposit address assigned by the NEAR Intents server — funds go to an address the wallet cannot verify' })
    expect(p.checks.some((c) => c.status === 'ok' && c.label === 'Funds arrive at your address')).toBe(false)
    expect(p.checks.find((c) => c.status === 'unknown')).toEqual({ status: 'unknown', label: 'Delivery to your address is the NEAR Intents server’s promise — this transaction does not enforce it' })
    // A deposit address on a route the app did not mark keeps the previous wording.
    const plain = swapApprovalPayload(deposit, { ...meta, providerLabel: 'THORChain' })
    expect(plain.checks.map((c) => c.label)).toContain('Deposit address from the THORChain quote')
    expect(plain.checks.map((c) => c.label)).toContain('Funds arrive at your address')
  })
})

// Round two (owner decision 3): the same flag per ROUTE, not only per provider — a THORChain inbound vault on a non-EVM
// source chain or a Chainflip Bitcoin deposit address is the provider server's word exactly like a 1Click deposit
// address, while the same provider's EVM routes carry verifiable calldata. Which routes these are is the app's policy.
describe('E6 — the deposit-address flag per route (app predicate)', () => {
  const TRON = 'tron:728126428'
  const fromTron: QuoteParams = { ...params, sourceChain: TRON, sourceToken: 'TRX' }
  // The app's policy in these tests: 1Click always, THORChain only from a non-EVM source.
  const policy = (q: Quote, p: QuoteParams) => q.provider === 'near_intents' || (q.provider === 'thorchain' && !p.sourceChain.startsWith('eip155:'))

  it('rank: a route the predicate marks is flagged and never BEST while an unmarked route exists', () => {
    const routes = rank([quote('thorchain', 3_100_000_000n, 50n, 30), quote('lifi', 3_000_000_000n, 50n)], { slippageBps: 50, depositAddressRoute: (q) => q.provider === 'thorchain' })
    expect(routes.map((r) => [r.provider, r.tags, (r.warnings ?? []).map((w) => w.kind)])).toEqual([['lifi', ['best'], []], ['thorchain', ['fastest'], ['deposit-address']]])
  })

  it('rank: when every route is marked, the best of them is BEST (and all stay listed with the warning)', () => {
    const routes = rank([quote('chainflip', 2_900_000_000n, 50n), quote('thorchain', 3_100_000_000n, 50n), quote('near_intents', 3_000_000_000n, 50n)], { depositAddressProviders: ['near_intents'], depositAddressRoute: (q) => q.provider !== 'near_intents' })
    expect(routes.map((r) => [r.provider, r.tags.includes('best')])).toEqual([['thorchain', true], ['near_intents', false], ['chainflip', false]])
    expect(routes.every((r) => (r.warnings ?? []).some((w) => w.kind === 'deposit-address'))).toBe(true)
  })

  it('rank: the provider list and the predicate add up; a route marked by both is flagged once', () => {
    const routes = rank([quote('near_intents', 3_100_000_000n, 50n), quote('lifi', 3_000_000_000n, 50n)], { depositAddressProviders: ['near_intents'], depositAddressRoute: (q) => q.provider === 'near_intents' })
    expect(routes[1]!.warnings).toEqual([{ kind: 'deposit-address' }])
    expect(routes[0]!.provider).toBe('lifi')
  })

  it('rank: a predicate that throws counts as marked — the warning is the safe side', () => {
    const routes = rank([quote('thorchain', 3_100_000_000n, 50n), quote('lifi', 3_000_000_000n, 50n)], { depositAddressRoute: (q) => { if (q.provider === 'thorchain') throw new Error('boom'); return false } })
    expect(routes.map((r) => [r.provider, r.tags.includes('best'), (r.warnings ?? []).map((w) => w.kind)])).toEqual([['lifi', true, []], ['thorchain', false, ['deposit-address']]])
  })

  it('quoteRoutes hands the predicate the request too: THORChain from Tron is marked, THORChain from Ethereum is not', async () => {
    const providers = [provider('thorchain', quote('thorchain', 3_100_000_000n, 50n)), provider('lifi', quote('lifi', 3_000_000_000n, 50n))]
    const tron = await quoteRoutes(providers, fromTron, { depositAddressRoute: policy })
    expect(tron.routes.map((r) => [r.provider, r.tags.includes('best'), (r.warnings ?? []).map((w) => w.kind)])).toEqual([['lifi', true, []], ['thorchain', false, ['deposit-address']]])
    const evm = await quoteRoutes(providers, params, { depositAddressRoute: policy })
    expect(evm.routes.map((r) => [r.provider, r.tags.includes('best'), r.warnings ?? []])).toEqual([['thorchain', true, []], ['lifi', false, []]])
  })

  it('quoteRoutes: every update the app sees while quotes stream is ranked with the predicate', async () => {
    const seen: string[][] = []
    await quoteRoutes([provider('thorchain', quote('thorchain', 3_100_000_000n, 50n))], fromTron, { depositAddressRoute: policy, onUpdate: (v) => seen.push(v.routes.flatMap((r) => (r.warnings ?? []).map((w) => `${r.provider}:${w.kind}:${r.tags.includes('best')}`))) })
    // Alone on the pair it is BEST, and still carries the warning.
    expect(seen.at(-1)).toEqual(['thorchain:deposit-address:true'])
  })
})

const plan: Swap2ExecutionPlan = {
  provider: 'lifi', fromChain: 'eip155:1', destChain: 'eip155:8453', destToken: USDC, recipient: A, refundAddress: A,
  sourceAmount: 1_000_000n, destAmount: 990_000n, minDestAmount: 980_000n, feeUsd: 0.4, etaSeconds: 120, validUntilMs: Date.now() + 60_000,
  approvals: [],
  source: { kind: 'call', to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0xdeadbeef', value: 0n },
}
const meta = { origin: 'chrome-extension://x', account: A, providerLabel: 'LI.FI', fromSymbol: 'USDC', fromDecimals: 6, toSymbol: 'USDC', toDecimals: 6, fromChainName: 'Ethereum', toChainName: 'Base', own: [A] }
