import { describe, expect, it, vi } from 'vitest'
import { ApprovalQueue, DEFAULT_NETWORKS, ReviewDeclined, ReviewGate, earnPlanMatchers, memoryApprovalWindow, reviewEarnPlan, type EarnApproval, type EarnPlan } from '../src/index.js'

const ETH = DEFAULT_NETWORKS[0]!
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const SELF = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const flush = () => new Promise((r) => setTimeout(r, 0))
const plan: EarnPlan = {
  approvals: [{ to: USDC, data: `0x095ea7b3${POOL.slice(2).toLowerCase().padStart(64, '0')}${(1_000_000n).toString(16).padStart(64, '0')}`, value: '0' }],
  tx: { to: POOL, data: '0x617ba037deadbeef', value: '0' },
}
const meta = { origin: 'chrome-extension://x', account: SELF, module: 'Aave v3', action: 'Supply', network: ETH, facts: [{ k: 'Asset', v: '1 USDC' }, { k: 'APY', v: '4.1 %' }] }

describe('reviewEarnPlan', () => {
  it('a module deposit signs only after the sheet is approved, and only the plan passes', async () => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window)
    const gate = new ReviewGate()
    const sent: string[] = []
    // the reviewed account the module writes through: passes only pre-approved calls
    const account = {
      sendTransaction: vi.fn(async (tx: { to: string; data?: string; value: bigint }) => {
        if (!gate.consume({ kind: 'evm-tx', account: SELF, caip2: ETH.caip2, to: tx.to, ...(tx.data ? { data: tx.data } : {}), value: tx.value })) throw new Error('not reviewed')
        sent.push(tx.to)
        return { hash: `0x${sent.length}`, fee: 1n }
      }),
    }
    // the module: plan → (adapter reviews) → execute approvals then the call
    const supply = async () => {
      await reviewEarnPlan(approvals, gate, meta, plan)
      for (const a of plan.approvals) await account.sendTransaction({ to: a.to, data: a.data!, value: BigInt(a.value) })
      return account.sendTransaction({ to: plan.tx.to, data: plan.tx.data!, value: 0n })
    }
    const declined = supply()
    await flush()
    const shown = window.opened[0]!
    expect(shown.kind).toBe('earn')
    const payload = shown.payload as EarnApproval
    expect(payload).toMatchObject({ module: 'Aave v3', action: 'Supply', approvals: [{ to: USDC }], tx: { to: POOL }, facts: meta.facts })
    expect(payload.checks.map((c) => c.label)).toEqual(['Built by the Aave v3 module'])
    approvals.decline(shown.id)
    await expect(declined).rejects.toBeInstanceOf(ReviewDeclined)
    expect(account.sendTransaction).not.toHaveBeenCalled()
    expect(gate.pending).toBe(0)

    const approved = supply()
    await flush()
    approvals.resolve(window.opened[1]!.id, null)
    expect(await approved).toEqual({ hash: '0x2', fee: 1n })
    expect(sent).toEqual([USDC, POOL])
    await expect(account.sendTransaction({ to: POOL, data: '0x617ba037deadbeef', value: 0n })).rejects.toThrow('not reviewed') // spent
  })

  it('matchers are exact per call; an unexpected non-approve pre-call is flagged', () => {
    const m = earnPlanMatchers(ETH, plan)
    expect(m).toHaveLength(2)
    expect(m[0]!({ kind: 'evm-tx', caip2: ETH.caip2, to: USDC, data: plan.approvals[0]!.data!, value: 0n })).toBe(true)
    expect(m[0]!({ kind: 'evm-tx', caip2: ETH.caip2, to: USDC, data: `${plan.approvals[0]!.data!.slice(0, -1)}1`, value: 0n })).toBe(false)
    expect(m[1]!({ kind: 'evm-tx', caip2: 'eip155:8453', to: POOL, data: plan.tx.data!, value: 0n })).toBe(false)
  })
})
