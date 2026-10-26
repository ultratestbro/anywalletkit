import { describe, expect, it } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { ERC20_ABI, WalletManagerEvm } from '../src/index.js'
import { encodeFunctionData } from 'viem'

// Audit 2026-10-25 round 3, M23: two sends started together from one account both read the
// `pending` nonce before either was broadcast and signed the same nonce: the second replaced the
// first (or was refused). prepare → sign → submit now runs one send at a time per account.

const SEED = 'test test test test test test test test test test test junk'
const SPENDER = '0x000000000000000000000000000000000000bEEF'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

/** A node that answers slowly and whose `pending` count lags our own broadcasts. */
function slowNode() {
  const sent: Hex[] = []
  const block = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
  const handlers: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => block,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x6fc23ac00',
    eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7', // never sees our sends
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_call: () => '0x' + '0'.repeat(62) + 'ff', // balanceOf = 255
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + String(sent.length).padStart(64, '0') },
  }
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => { await new Promise((r) => setTimeout(r, 2)); const h = handlers[method]; if (!h) throw new Error(`unmocked ${method}`); return h((params as unknown[]) ?? []) } } as unknown as EIP1193Provider
  return { sent, provider }
}

describe('wallet-evm: sends from one account go out one at a time', () => {
  it('two transfers started together get consecutive nonces', async () => {
    const node = slowNode()
    const m = new WalletManagerEvm(SEED, { provider: node.provider })
    const a = await m.getAccount(0)
    await Promise.all([a.transfer({ recipient: SPENDER, amount: 1n }), a.transfer({ recipient: SPENDER, amount: 2n })])
    expect(node.sent.map((r) => parseTransaction(r).nonce).sort()).toEqual([7, 8])
    m.dispose()
  })

  it('a token transfer, a send and an approve together: three distinct nonces', async () => {
    const node = slowNode()
    const m = new WalletManagerEvm(SEED, { provider: node.provider })
    const a = await m.getAccount(0)
    await Promise.all([
      a.transfer({ token: USDC, recipient: SPENDER, amount: 5n }),
      a.sendTransaction({ to: SPENDER, value: 1n }),
      a.sendTransaction({ to: USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [SPENDER, 5n] }) }),
    ])
    expect(node.sent.map((r) => parseTransaction(r).nonce).sort()).toEqual([7, 8, 9])
    m.dispose()
  })

  it('one failing send does not block the next', async () => {
    const node = slowNode()
    const m = new WalletManagerEvm(SEED, { provider: node.provider })
    const a = await m.getAccount(0)
    const [bad, good] = await Promise.allSettled([a.sendTransaction({ to: SPENDER, value: 10n ** 30n }), a.sendTransaction({ to: SPENDER, value: 1n })])
    expect(bad.status).toBe('rejected')
    expect(good.status).toBe('fulfilled')
    expect(node.sent.map((r) => parseTransaction(r).nonce)).toEqual([7])
    m.dispose()
  })
})
