import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { Wallet } from '@forgewallet/kit'
import { WalletManagerEvm, type WalletAccountEvm } from '@forgewallet/wallet-evm'
import { UserRejectedError } from '@forgewallet/core'
import type { Rpc, TxPreview } from '@forgewallet/tx-preview-evm'
import type { Swap2ExecutionPlan } from '@forgewallet/protocol-swap2-core'
import { balanceLines, previewPolicies, previewSwap, previewWrap, verdict } from '../src/preview.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ROUTER = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

/** A node that simulates every call as successful, with no logs. */
const okRpc: Rpc = async (method, params) => {
  if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: '0x10' }
  if (method === 'eth_simulateV1') {
    const calls = (params[0] as { blockStateCalls: { calls: unknown[] }[] }).blockStateCalls[0]!.calls
    return [{ calls: calls.map(() => ({ status: '0x1', gasUsed: '0x5208', logs: [] })) }]
  }
  return '0x'
}

describe('Transaction preview guide (docs) — offline', () => {
  it('kit confirm simulates an EVM write before asking: an unlimited approve shows up as a danger', async () => {
    const seen: { method: string; preview: TxPreview | null }[] = []
    const wallet = new Wallet(SEED, {
      policies: previewPolicies(() => okRpc, [ME], async (intent, preview) => { seen.push({ method: intent.method, preview }); return false }),
    })
    wallet.registerWallet('eip155:8453', WalletManagerEvm, { provider: 'https://base-rpc.publicnode.com', chainId: 8453 })
    try {
      const account = await wallet.getAccount<WalletAccountEvm>('eip155:8453')
      await expect(account.approve({ token: USDC, spender: ROUTER, amount: (1n << 256n) - 1n })).rejects.toBeInstanceOf(UserRejectedError)
      const { preview } = seen[0]!
      expect(preview?.calls[0]?.approval).toMatchObject({ spender: ROUTER.toLowerCase(), amount: null, kind: 'erc20' })
      expect(verdict(preview!)).toMatchObject({ level: 'danger' })
      expect(verdict(preview!).lines.join('\n')).toMatch(/could spend ALL/)
    } finally {
      wallet.dispose()
    }
  })

  it('a swap plan is previewed as approve → call, and an approval above the input is flagged', async () => {
    const plan = {
      provider: 'lifi', fromChain: 'eip155:8453', destChain: 'eip155:8453', destToken: 'native', recipient: ME, refundAddress: ME,
      sourceAmount: 1_000_000n, destAmount: 1n, minDestAmount: 1n, feeUsd: 0, etaSeconds: 30, validUntilMs: Date.now() + 60_000,
      approvals: [{ token: USDC, spender: ROUTER, amount: 5_000_000n }],
      source: { kind: 'call', to: ROUTER, data: '0x12345678', value: 0n },
    } satisfies Swap2ExecutionPlan
    const preview = (await previewSwap(plan, ME, okRpc))!
    expect(preview.calls.map((c) => c.method)).toEqual(['approve', '0x12345678'])
    expect(preview.checks.map((c) => c.code)).toEqual(expect.arrayContaining(['contract-known', 'simulation-ok', 'recipient-own', 'approval-excess']))
    expect(verdict(preview).level).toBe('warn')
  })

  it('a reverted simulation is a danger with the reason', () => {
    const preview: TxPreview = { calls: [], simulation: { status: 'reverted', callIndex: 0, reason: 'ERC20: transfer amount exceeds balance' }, checks: [{ code: 'simulation-reverted', status: 'warn', detail: { reason: 'ERC20: transfer amount exceeds balance', call: '0' } }] }
    expect(verdict(preview)).toEqual({ level: 'danger', lines: ['This transaction will fail: ERC20: transfer amount exceeds balance'] })
  })
})

// Base reads through eth_simulateV1, nothing signed: LIVE=1 pnpm --filter @forgewallet/example-tx-preview test
describe.runIf(process.env.LIVE === '1')('Transaction preview guide (docs) — live', () => {
  it('wrapping 0.01 ETH on Base: -ETH, +WETH, simulated on an unfunded account', async () => {
    const preview = await previewWrap(ME, 10n ** 16n)
    console.log(JSON.stringify(preview, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
    console.log(balanceLines(preview), verdict(preview))
    expect(preview.simulation.status).toBe('ok')
    expect(balanceLines(preview)).toEqual(['-0.01 ETH', '+0.01 WETH'])
  }, 60_000)
})
