import { describe, expect, it } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { WalletManagerEvm } from '../src/index.js'

// Audit 2026-10-25 round 3, M33: an EIP-7702 (type 4) transaction was simulated and gas-estimated
// WITHOUT its authorizationList — the dry run executed the account's old code, not the delegate's —
// and `{type: 4, gasPrice}` silently became a legacy transaction with the authorizations dropped.

const SEED = 'test test test test test test test test test test test junk'
const DELEGATE = '0x000000000000000000000000000000000000de1e'
const AUTH = { chainId: 1, address: DELEGATE as Hex, nonce: 8, r: ('0x' + '11'.repeat(32)) as Hex, s: ('0x' + '22'.repeat(32)) as Hex, yParity: 1 }

function node() {
  const sent: Hex[] = []
  const params: Record<string, unknown[]> = {}
  const block = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => block,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x186a0',
    eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x',
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
  }
  const provider = { request: async ({ method, params: p }: { method: string; params?: unknown }) => { params[method] = (p as unknown[]) ?? []; const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h((p as unknown[]) ?? []) } } as unknown as EIP1193Provider
  return { sent, params, provider }
}
const self = async (n: ReturnType<typeof node>) => (await new WalletManagerEvm(SEED, { provider: n.provider }).getAccount(0))

describe('EIP-7702 (type 4)', () => {
  it('the simulation and the gas estimate carry the authorizationList', async () => {
    const n = node()
    const a = await self(n)
    const me = await a.getAddress()
    const res = await a.sendTransaction({ type: 4, to: me, data: '0x', authorizationList: [AUTH] })
    expect(res.hash).toMatch(/^0x/)
    for (const method of ['eth_call', 'eth_estimateGas']) {
      const req = n.params[method]![0] as { authorizationList?: Array<{ address: string }> }
      expect(req.authorizationList, method).toHaveLength(1)
      expect(req.authorizationList![0]!.address.toLowerCase()).toBe(DELEGATE.toLowerCase())
    }
    const tx = parseTransaction(n.sent[0]!)
    expect(tx.type).toBe('eip7702')
    expect(tx.authorizationList).toHaveLength(1)
  })

  it('a type 4 with legacy fee fields is refused, never turned into a legacy transaction', async () => {
    const n = node()
    const a = await self(n)
    const me = await a.getAddress()
    await expect(a.sendTransaction({ type: 4, to: me, gasPrice: 10n ** 9n, authorizationList: [AUTH] })).rejects.toThrow(/EIP-7702.*EIP-1559 fee/)
    await expect(a.signTransaction({ type: 4, to: me, gasPrice: 10n ** 9n, nonce: 0, gasLimit: 100_000n, chainId: 1, authorizationList: [AUTH] })).rejects.toThrow(/EIP-7702.*EIP-1559 fee/)
    expect(n.sent).toHaveLength(0)
  })

  it('authorizations on a transaction that is not type 4 are refused rather than dropped', async () => {
    const n = node()
    const a = await self(n)
    const me = await a.getAddress()
    await expect(a.sendTransaction({ type: 2, to: me, authorizationList: [AUTH] })).rejects.toThrow(/authorizationList.*type 4/)
    await expect(a.sendTransaction({ to: me, gasPrice: 10n ** 9n, authorizationList: [AUTH] })).rejects.toThrow(/authorizationList.*type 4|EIP-1559 fee/)
    expect(n.sent).toHaveLength(0)
  })
})
