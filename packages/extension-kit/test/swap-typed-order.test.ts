import { describe, expect, it } from 'vitest'
import type { Swap2ExecutionPlan } from '@anywalletkit/protocol-swap2-core'
import { typedDataHash } from '@anywalletkit/wallet-evm'
import { ApprovalQueue, DEFAULT_NETWORKS, ReviewGate, memoryApprovalWindow, planMatchers, reviewEarnPlan, reviewSwapPlan, swapApprovalPayload, type SwapApproval } from '../src/index.js'

// Audit 2026-10-25 round 3, M18: a gasless swap (Omniston EVM-source) signs an EIP-712 order. The
// swap sheet said "Signed order" without the order itself, and the gate's typed-data matcher let ANY
// typed data on the chain through once — a different order, a Permit, for any account. The sheet
// now carries the order, the matcher compares its EIP-712 hash, and every plan's pre-approvals are
// bound to the account that reviewed it.

const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const flush = () => new Promise((r) => setTimeout(r, 0))

/** As the provider sends it: EIP712Domain listed, chainId in hex. */
const order = {
  domain: { name: 'Omniston', version: '1', chainId: '0x1', verifyingContract: '0x1111111111111111111111111111111111111111' },
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Order: [{ name: 'maker', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  },
  primaryType: 'Order',
  message: { maker: A, token: USDC, amount: '1000000' },
}
/** As the engine hands it to the account: no EIP712Domain, chainId a number (normalizeTypedDomain). */
const { EIP712Domain: _d, ...signedTypes } = order.types
const signed = (message = order.message) => ({ domain: { ...order.domain, chainId: 1 }, types: signedTypes, primaryType: 'Order', message })

const plan: Swap2ExecutionPlan = {
  provider: 'omniston', fromChain: 'eip155:1', destChain: 'ton:-239', destToken: 'native', recipient: 'UQAbc', refundAddress: A,
  sourceAmount: 1_000_000n, destAmount: 3_000_000_000n, minDestAmount: 2_900_000_000n, feeUsd: 0.1, etaSeconds: 60, validUntilMs: Date.now() + 60_000,
  approvals: [], source: { kind: 'typed-order', typedData: JSON.stringify(order) },
}
const meta = { origin: 'chrome-extension://x', account: A, providerLabel: 'Omniston', fromSymbol: 'USDC', fromDecimals: 6, toSymbol: 'GRAM', toDecimals: 9, fromChainName: 'Ethereum', toChainName: 'TON', own: [A] }
const op = (typed: ReturnType<typeof signed>, account: string | null = A) => ({ kind: 'evm-typed-data' as const, caip2: 'eip155:1', typedDataHash: typedDataHash(typed), ...(account ? { account } : {}) })

describe('swap typed order: shown on the sheet, matched by its hash, bound to the account', () => {
  it('the sheet carries the order the account will sign', () => {
    const payload = swapApprovalPayload(plan, meta)
    expect(payload.source).toMatchObject({ kind: 'typed-order', typedData: { primaryType: 'Order', message: { maker: A, amount: '1000000' } } })
    expect((payload.source as Extract<SwapApproval['source'], { kind: 'typed-order' }>).text).toContain('"amount": "1000000"')
  })

  it('only the reviewed order passes the gate, once; another order or a Permit on the same chain does not', () => {
    const gate = new ReviewGate()
    gate.preApprove(planMatchers(plan))
    expect(gate.consume(op(signed({ ...order.message, amount: '9000000' })))).toBe(false)
    const permit = { domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC }, types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] }, primaryType: 'Permit', message: { owner: A, spender: B, value: '1000000' } }
    expect(gate.consume({ kind: 'evm-typed-data', caip2: 'eip155:1', typedDataHash: typedDataHash(permit) })).toBe(false)
    expect(gate.consume(op(signed()))).toBe(true) // the engine's normalized form hashes the same as the provider's JSON
    expect(gate.consume(op(signed()))).toBe(false) // spent
  })

  it('reviewSwapPlan binds the pre-approval to the reviewing account', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const p = reviewSwapPlan(approvals, gate, meta)(plan)
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await p
    expect(gate.consume(op(signed(), B))).toBe(false) // another account
    expect(gate.consume(op(signed(), null))).toBe(false) // an op that does not say whose it is
    expect(gate.consume(op(signed(), A.toLowerCase()))).toBe(true)
  })

  it('a plan whose typed order cannot be hashed is refused before any window opens', async () => {
    const window = memoryApprovalWindow()
    const gate = new ReviewGate()
    const bad = { ...plan, source: { kind: 'typed-order' as const, typedData: '{"domain":{},"types":{"A":[],"B":[]},"message":{}}' } }
    await expect(reviewSwapPlan(new ApprovalQueue(window), gate, meta)(bad)).rejects.toThrow()
    expect(window.opened).toHaveLength(0)
    expect(gate.pending).toBe(0)
  })

  it('reviewEarnPlan binds to the account too', async () => {
    const ETH = DEFAULT_NETWORKS[0]!
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const tx = { to: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', data: '0x617ba037', value: '0' }
    const p = reviewEarnPlan(approvals, gate, { origin: 'chrome-extension://x', account: A, module: 'Aave v3', action: 'Supply', network: ETH, facts: [] }, { approvals: [], tx })
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await p
    const call = { kind: 'evm-tx' as const, caip2: ETH.caip2, to: tx.to, data: tx.data, value: 0n }
    expect(gate.consume({ ...call, account: B })).toBe(false)
    expect(gate.consume({ ...call, account: A })).toBe(true)
  })
})
