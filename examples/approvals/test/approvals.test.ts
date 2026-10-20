import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import { UserRejectedError } from '@forgewallet/core'
import type { WriteIntent } from '@forgewallet/kit'
import type { WalletAccountEvm } from '@forgewallet/wallet-evm'
import ApprovalsProtocolEvm, { type Approval } from '@forgewallet/protocol-approvals-evm'
import { approvalPolicies, auditAddress, memoryCache, revokeOne, walletWithApprovals } from '../src/approvals.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const SPENDER = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const LOGS_RPC = process.env.LOGS_RPC ?? 'https://rpc.mevblocker.io'

const usdcApproval: Approval = {
  id: `1:erc20:${USDC}:${SPENDER}`, standard: 'erc20', chainId: 1, token: USDC, spender: SPENDER,
  amount: (1n << 256n) - 1n, unlimited: true, risks: ['unlimited'],
}

describe('Approvals guide (docs) — offline', () => {
  it('the kit hands out the approvals protocol over the Ethereum account', async () => {
    const wallet = walletWithApprovals(SEED, { logsRpc: LOGS_RPC, cache: memoryCache() })
    try {
      expect(await wallet.getProtocol('approvals')).toBeInstanceOf(ApprovalsProtocolEvm)
    } finally {
      wallet.dispose()
    }
  })

  it('a revoke reaches confirm as an approval of 0 to the spender, and stops there when refused', async () => {
    const seen: WriteIntent[] = []
    const wallet = walletWithApprovals(SEED, {
      logsRpc: LOGS_RPC,
      cache: memoryCache(),
      policies: approvalPolicies(async (intent) => { seen.push(intent); return false }),
    })
    try {
      await expect(revokeOne(wallet, usdcApproval)).rejects.toBeInstanceOf(UserRejectedError)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ kind: 'approval', method: 'approve', to: SPENDER, token: USDC, amount: 0n, unlimited: false })
    } finally {
      wallet.dispose()
    }
  }, 30_000)

  it('an unlimited approve gets the warning', async () => {
    const warnings: (string | undefined)[] = []
    const wallet = walletWithApprovals(SEED, {
      logsRpc: LOGS_RPC,
      cache: memoryCache(),
      policies: approvalPolicies(async (_intent, warning) => { warnings.push(warning); return false }),
    })
    try {
      const account = await wallet.getAccount<WalletAccountEvm>('eip155:1')
      await expect(account.approve({ token: USDC, spender: SPENDER, amount: (1n << 256n) - 1n })).rejects.toBeInstanceOf(UserRejectedError)
      expect(warnings[0]).toMatch(/could spend all/)
    } finally {
      wallet.dispose()
    }
  })

  it('revoke transactions are plain calldata: approve(spender, 0) and Permit2 lockdown', () => {
    const approvals = new ApprovalsProtocolEvm({ getAddress: async () => SPENDER }, { chainId: 1 })
    const erc20 = approvals.buildRevokeTransaction(usdcApproval)
    expect(erc20.to).toBe(USDC)
    expect(erc20.data.startsWith('0x095ea7b3')).toBe(true) // approve(address,uint256)
    expect(erc20.data.endsWith('0'.repeat(64))).toBe(true)
    const permit2 = approvals.buildRevokeTransaction({ ...usdcApproval, standard: 'permit2' })
    expect(permit2.to).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
  })

  it('the cache stores plain JSON', async () => {
    const store = new Map<string, string>()
    const cache = memoryCache(store)
    await cache.set('1:0xabc', { fromBlock: 1, toBlock: 2, candidates: [] })
    expect(await cache.get('1:0xabc')).toEqual({ fromBlock: 1, toBlock: 2, candidates: [] })
    expect(store.get('1:0xabc')).toBe('{"fromBlock":1,"toBlock":2,"candidates":[]}')
  })
})

// Mainnet reads, nothing signed: LIVE=1 pnpm --filter @forgewallet/example-approvals test
describe.runIf(process.env.LIVE === '1')('Approvals guide (docs) — live reads', () => {
  it('scans the recent history of an account through an RPC that serves address-less eth_getLogs', async () => {
    const approvals = new ApprovalsProtocolEvm(
      { getAddress: async () => '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
      { provider: LOGS_RPC, chainId: 1, blockRange: 50_000 },
    )
    const res = await fetch(LOGS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }) })
    const latest = Number(BigInt(((await res.json()) as { result: string }).result))
    const { approvals: list, coverage } = await approvals.getApprovals({ fromBlock: latest - 200_000 })
    console.log('coverage', coverage)
    console.log(list.map((a) => [a.standard, a.token, a.spender, a.unlimited ? 'UNLIMITED' : a.amount, a.risks]))
    expect(coverage.complete).toBe(true)
  }, 120_000)

  it.runIf(process.env.BLOCKSCOUT === '1')('audits an address through Blockscout in one request', async () => {
    const list = await auditAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    console.log(list.length, list.slice(0, 5).map((a) => [a.standard, a.token, a.spender, a.risks]))
  }, 120_000)
})
