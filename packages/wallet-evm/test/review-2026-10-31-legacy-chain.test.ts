import { describe, expect, it } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { WalletManagerEvm } from '../src/index.js'

// A chain without EIP-1559 (no baseFeePerGas): the quote worked at gasPrice, while transfer() and a
// sendTransaction without fee fields threw — the same transaction quoted fine and could not be sent.
// Now quote and send take one path: no type and no fee fields → a legacy transaction at gasPrice.
// An explicit type 2 / 4 or EIP-1559 fee field still fails, and the fee cap still holds.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const LEGACY_BLOCK = { number: '0x10', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x1', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }

function legacyNode(over: Record<string, (p: unknown[]) => unknown> = {}) {
  const sent: Hex[] = []
  const h: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x3d', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => LEGACY_BLOCK,
    eth_gasPrice: () => '0x1', eth_estimateGas: () => '0x5208', eth_getTransactionCount: () => '0x0',
    eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(63) + 'f', eth_getTransactionByHash: () => null,
    eth_maxPriorityFeePerGas: () => { throw Object.assign(new Error('method not found'), { code: -32601 }) },
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
    ...over,
  }
  return { sent, provider: { request: async ({ method, params }: { method: string; params?: unknown }) => { const f = h[method]; if (!f) throw new Error(`unmocked ${method}`); return f((params as unknown[]) ?? []) } } as unknown as EIP1193Provider }
}

describe('a chain without EIP-1559', () => {
  it('transfer (native + token) and sendTransaction without fee fields sign legacy at gasPrice, matching the quote', async () => {
    const net = legacyNode()
    const a = await new WalletManagerEvm(SEED, { provider: net.provider }).getAccount(0)
    const quote = await a.quoteTransfer({ recipient: TO, amount: 1n })
    const tquote = await a.quoteTransfer({ token: TOKEN, recipient: TO, amount: 1n })
    const native = await a.transfer({ recipient: TO, amount: 1n })
    const token = await a.transfer({ token: TOKEN, recipient: TO, amount: 1n } as never)
    const raw = await a.sendTransaction({ to: TO, value: 1n })
    const typed = await a.sendTransaction({ to: TO, value: 1n, type: 0 } as never)
    // same rate (gasPrice 1 wei) for the quote and every send; the signed gas carries its 1.2 × headroom
    expect(quote.fee).toBe(21_000n)
    expect(tquote.fee).toBe(21_000n)
    for (const r of [native, token, raw, typed]) expect(r.fee).toBe(25_200n)
    const txs = net.sent.map((r) => parseTransaction(r))
    expect(txs.map((t) => t.type)).toEqual(['legacy', 'legacy', 'legacy', 'legacy'])
    expect(txs.every((t) => t.gasPrice === 1n)).toBe(true)
  })

  it('an explicit type 2 / type 4 / maxFeePerGas still throws, nothing signed', async () => {
    const net = legacyNode()
    const a = await new WalletManagerEvm(SEED, { provider: net.provider }).getAccount(0)
    await expect(a.sendTransaction({ to: TO, value: 1n, type: 2 } as never)).rejects.toThrow()
    await expect(a.quoteSendTransaction({ to: TO, value: 1n, type: 2 } as never)).rejects.toThrow()
    await expect(a.sendTransaction({ to: TO, value: 1n, maxPriorityFeePerGas: 1n })).rejects.toThrow()
    await expect(a.sendTransaction({ to: TO, value: 1n, type: 4, authorizationList: [] } as never)).rejects.toThrow()
    expect(net.sent).toEqual([])
  })

  it('the fee cap holds for the legacy fallback', async () => {
    const net = legacyNode({ eth_gasPrice: () => '0x3b9aca00' /* 1 gwei */ })
    const a = await new WalletManagerEvm(SEED, { provider: net.provider, transactionMaxFee: 1000n }).getAccount(0)
    await expect(a.sendTransaction({ to: TO, value: 1n })).rejects.toThrow()
    expect(net.sent).toEqual([])
  })

  it('a transport failure while reading EIP-1559 fees is not turned into a legacy quote', async () => {
    const net = legacyNode({ eth_getBlockByNumber: () => { throw new Error('fetch failed') } })
    const a = await new WalletManagerEvm(SEED, { provider: net.provider }).getAccount(0)
    await expect(a.quoteSendTransaction({ to: TO, value: 1n, gasLimit: 21_000n })).rejects.toThrow()
  })
})
