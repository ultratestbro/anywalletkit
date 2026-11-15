import { describe, expect, it } from 'vitest'
import { PERMIT2_ADDRESS, type CrossChainProvider, type Swap2ExecutionPlan, type TxRequest } from '@anywalletkit/protocol-swap2-core'
import { SingleProviderSwap2 } from '@anywalletkit/protocol-swap2-core/swap2/single'
import { typedDataHash } from '@anywalletkit/wallet-evm'
import { ApprovalQueue, ReviewGate, evmSignedCallMatcher, memoryApprovalWindow, planMatchers, reviewSwapPlan, swapApprovalPayload, type GatedOp, type SwapApproval } from '../src/index.js'

// SDK-25 / review 2026-11-15 F1: a Permit2 signature-transfer swap (0x) is three operations — the permit signature,
// the approval to Permit2, and the call carrying the signature. The sheet showed none of the permit, the gate
// pre-approved no typed data and matched the call by its UNSIGNED calldata (which the engine never sends), so the
// permit and the signed call each stopped for a raw second review and one pre-approval stayed unused in the gate.
// The engine below is the real one; the account records each operation and asks the gate, as the extension does.

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const SITE = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SETTLER = '0x103502909141F7025a94b7b99A276dCD128e21a8'
const CAIP2 = 'eip155:8453'
const AMOUNT = 1_000_000n
const DATA = `0x1fff991f${'00'.repeat(96)}`
const SIG = `0x${'cd'.repeat(65)}`
const flush = () => new Promise((r) => setTimeout(r, 0))
const seconds = () => Math.floor(Date.now() / 1000)

const permit = (over: { amount?: string; spender?: string } = {}) => JSON.stringify({
  domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2_ADDRESS },
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  },
  primaryType: 'PermitTransferFrom',
  message: { permitted: { token: USDC, amount: over.amount ?? AMOUNT.toString() }, spender: over.spender ?? SETTLER, nonce: '77', deadline: String(seconds() + 300) },
})
const request = (): TxRequest => ({ to: SETTLER, data: DATA, value: '0', chainId: 8453, gasLimit: '400000', approvalAddress: PERMIT2_ADDRESS, permit2Transfer: permit() })
const provider: CrossChainProvider = {
  name: 'zeroex', enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
  getQuote: async (params) => ({
    provider: 'zeroex', intentId: 'zeroex:8453:x', depositAddress: '', depositMemo: null, txRequest: request(),
    sourceAmount: params.amountIn, destAmount: '400000000000000', minDestAmount: '398000000000000', feeUsd: 0, etaSeconds: 15, reliability: 1, validUntilMs: Date.now() + 30_000,
  }),
  buildDeposit: async (q) => ({ chain: '', to: q.txRequest!.to!, value: '0', data: q.txRequest!.data!, chainId: 8453, gasLimit: q.txRequest!.gasLimit!, approvalAddress: PERMIT2_ADDRESS, permit2Transfer: q.txRequest!.permit2Transfer! }),
  trackIntent: async () => ({ state: 'pending' }),
}
const options = { fromToken: 'USDC', toToken: '0x0000000000000000000000000000000000000000', toChain: 8453, recipient: ME, fromTokenAmount: AMOUNT, minAmountOut: 398_000_000_000_000n }
const meta = { origin: 'chrome-extension://x', account: ME, providerLabel: '0x', fromSymbol: 'USDC', fromDecimals: 6, toSymbol: 'ETH', toDecimals: 18, fromChainName: 'Base', toChainName: 'Base', own: [ME] }

/** An account whose every operation asks the gate first, as the extension's signing path does; `stopped` = would open a second window. */
function gatedAccount(gate: ReviewGate) {
  const passed: string[] = []
  const stopped: string[] = []
  const ask = (op: GatedOp, label: string) => { (gate.consume({ ...op, account: ME }) ? passed : stopped).push(label) }
  return {
    passed, stopped,
    account: {
      getAddress: async () => ME, getChainId: async () => 8453, getBalance: async () => 10n ** 18n, getAllowance: async () => 0n,
      quoteSendTransaction: async () => ({ fee: 1n }), waitForTransaction: async () => {},
      signTypedData: async (typed: unknown) => { ask({ kind: 'evm-typed-data', caip2: CAIP2, typedDataHash: typedDataHash(typed as Parameters<typeof typedDataHash>[0]) }, 'permit'); return SIG },
      sendTransaction: async (tx: { to?: string; data?: string; value?: bigint }) => {
        ask({ kind: 'evm-tx', caip2: CAIP2, to: tx.to!, ...(tx.data ? { data: tx.data } : {}), value: tx.value ?? 0n }, tx.to!.toLowerCase() === USDC.toLowerCase() ? 'approve' : 'swap')
        return { hash: `0x${'1'.repeat(64)}` }
      },
    },
  }
}
class Swap extends SingleProviderSwap2 {
  protected readonly provider = provider
  protected chainSupported(): boolean { return true }
}

describe('Permit2 swap: one sheet, then the permit, the approval and the signed call pass without a second window', () => {
  it('the real engine run through reviewSwapPlan: every operation is pre-approved, none is left over', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const review = reviewSwapPlan(approvals, gate, meta)
    const g = gatedAccount(gate)
    const run = new Swap(g.account as never, { fromChain: CAIP2, reviewExecution: review }).swap2(options)
    await flush()
    approvals.resolve(window.opened[0]!.id, null)
    await run
    expect(g.stopped).toEqual([])
    expect(g.passed).toEqual(['permit', 'approve', 'swap'])
    expect(gate.pending).toBe(0)
  })

  it('the sheet shows the permit: token, exact amount, the one contract that may use it, and the Permit2 approval', async () => {
    let plan: Swap2ExecutionPlan | undefined
    await new Swap(gatedAccount(new ReviewGate()).account as never, { fromChain: CAIP2, reviewExecution: (p: Swap2ExecutionPlan) => { plan = p } }).swap2(options)
    const sheet = swapApprovalPayload(plan!, meta)
    const source = sheet.source as Extract<SwapApproval['source'], { kind: 'call' }>
    expect(source.permit2Transfer).toMatchObject({ token: USDC.toLowerCase(), amount: '1000000', spender: SETTLER.toLowerCase() })
    expect(source.permit2Transfer!.text).toContain('"PermitTransferFrom"')
    expect(source.permit2Transfer!.deadline).toBeGreaterThan(seconds())
    expect(sheet.checks.find((c) => c.label.startsWith('Permit2 signature'))).toMatchObject({ status: 'ok' })
    expect(sheet.checks.find((c) => c.label.startsWith('Permit2 signature'))!.label).toMatch(/^Permit2 signature: exactly the amount sold, usable only by 0x1035…21a8 in this swap, expires in [45] min$/)
    expect(sheet.checks.some((c) => c.label.startsWith('Approval goes to Permit2'))).toBe(true)
  })

  it('a permit that does not match the plan is flagged on the sheet', () => {
    const plan = { provider: 'zeroex', fromChain: CAIP2, destChain: CAIP2, destToken: '0x0000000000000000000000000000000000000000', recipient: ME, refundAddress: ME, sourceAmount: AMOUNT, destAmount: 1n, minDestAmount: 1n, feeUsd: 0, etaSeconds: 15, validUntilMs: Date.now() + 30_000, approvals: [], source: { kind: 'call' as const, to: SETTLER, data: DATA, value: 0n, permit2Transfer: permit({ amount: '2000000' }) } }
    expect(swapApprovalPayload(plan, meta).checks).toContainEqual({ status: 'warn', label: 'Permit2 signature does not match this swap (amount or contract)' })
  })

  it('only the reviewed permit and the call with exactly one signature appended pass — not the unsigned call, another permit, or extra bytes', () => {
    const plan = { provider: 'zeroex', fromChain: CAIP2, destChain: CAIP2, destToken: '0x0000000000000000000000000000000000000000', recipient: ME, refundAddress: ME, sourceAmount: AMOUNT, destAmount: 1n, minDestAmount: 1n, feeUsd: 0, etaSeconds: 15, validUntilMs: Date.now() + 30_000, approvals: [], source: { kind: 'call' as const, to: SETTLER, data: DATA, value: 0n, permit2Transfer: permit() } }
    const gate = new ReviewGate()
    gate.preApprove(planMatchers(plan))
    const call = (data: string, value = 0n, to = SETTLER): GatedOp => ({ kind: 'evm-tx', caip2: CAIP2, to, data, value })
    const len = (n: number) => n.toString(16).padStart(64, '0')
    expect(gate.consume(call(DATA))).toBe(false) // the unsigned calldata the engine never sends
    expect(gate.consume(call(`${DATA}${len(65)}${'cd'.repeat(64)}`))).toBe(false) // length word says more than is there
    expect(gate.consume(call(`${DATA}${len(65)}${'cd'.repeat(65)}00`))).toBe(false) // extra bytes after the signature
    expect(gate.consume(call(`${DATA}${len(32)}${'cd'.repeat(32)}`))).toBe(false) // too short to be a signature
    expect(gate.consume(call(`${DATA}${len(65)}${'cd'.repeat(65)}`, 1n))).toBe(false) // native value
    expect(gate.consume(call(`${DATA}${len(65)}${'cd'.repeat(65)}`, 0n, SITE))).toBe(false) // another contract
    const other = JSON.parse(permit({ spender: SITE })) as Parameters<typeof typedDataHash>[0]
    expect(gate.consume({ kind: 'evm-typed-data', caip2: CAIP2, typedDataHash: typedDataHash(other) })).toBe(false)
    const reviewed = JSON.parse(permit()) as Parameters<typeof typedDataHash>[0]
    expect(gate.consume({ kind: 'evm-typed-data', caip2: CAIP2, typedDataHash: typedDataHash(reviewed) })).toBe(true)
    expect(gate.consume(call(`${DATA}${len(65)}${'CD'.repeat(65)}`))).toBe(true)
    expect(gate.pending).toBe(0)
  })

  it('evmSignedCallMatcher takes a contract account signature up to 2048 bytes, no more', () => {
    const m = evmSignedCallMatcher({ caip2: CAIP2, to: SETTLER, data: DATA, value: 0n })
    const len = (n: number) => n.toString(16).padStart(64, '0')
    expect(m({ kind: 'evm-tx', caip2: CAIP2, to: SETTLER, data: `${DATA}${len(64)}${'ab'.repeat(64)}`, value: 0n })).toBe(true)
    expect(m({ kind: 'evm-tx', caip2: CAIP2, to: SETTLER, data: `${DATA}${len(2048)}${'ab'.repeat(2048)}`, value: 0n })).toBe(true)
    expect(m({ kind: 'evm-tx', caip2: CAIP2, to: SETTLER, data: `${DATA}${len(2049)}${'ab'.repeat(2049)}`, value: 0n })).toBe(false)
    expect(m({ kind: 'evm-tx', caip2: 'eip155:1', to: SETTLER, data: `${DATA}${len(65)}${'ab'.repeat(65)}`, value: 0n })).toBe(false)
  })

  it('a plan whose permit is not a PermitTransferFrom is refused before any window opens', async () => {
    const window = memoryApprovalWindow()
    const gate = new ReviewGate()
    const bad = { provider: 'zeroex', fromChain: CAIP2, destChain: CAIP2, destToken: '0x0000000000000000000000000000000000000000', recipient: ME, refundAddress: ME, sourceAmount: AMOUNT, destAmount: 1n, minDestAmount: 1n, feeUsd: 0, etaSeconds: 15, validUntilMs: Date.now() + 30_000, approvals: [], source: { kind: 'call' as const, to: SETTLER, data: DATA, value: 0n, permit2Transfer: '{"domain":{},"types":{},"primaryType":"PermitSingle","message":{}}' } }
    await expect(reviewSwapPlan(new ApprovalQueue(window), gate, meta)(bad)).rejects.toThrow()
    expect(window.opened).toHaveLength(0)
    expect(gate.pending).toBe(0)
  })
})
