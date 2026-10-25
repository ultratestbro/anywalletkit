import { describe, expect, it } from 'vitest'
import { parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { WalletManagerEvm } from '../src/index.js'

// Audit 2026-10-25, finding 2: the fee cap was checked on a network quote while the
// caller's own gasPrice / maxFeePerGas was signed. The cap now holds for what is signed.

const SEED = 'test test test test test test test test test test test junk'
const SPENDER = '0x000000000000000000000000000000000000bEEF'
const GWEI = 1_000_000_000n
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }

/**
 * Mainnet-like RPC: base fee 1 gwei, tip 1 gwei (viem's cap = 1.2 × base + tip = 2.2 gwei),
 * gasPrice 30 gwei, estimateGas 21 000 (× 1.2 headroom = 25 200 signed).
 */
function fakeProvider(over: Record<string, (p: unknown[]) => unknown> = {}) {
  const sent: Hex[] = []
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1',
    eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00',
    eth_gasPrice: () => '0x6fc23ac00',
    eth_estimateGas: () => '0x5208',
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_getTransactionCount: () => '0x7',
    eth_call: () => '0x',
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return '0x' + 'ab'.repeat(32) },
    ...over,
  }
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      const h = handlers[method]
      if (!h) throw new Error(`unmocked ${method}`)
      return h((params as unknown[]) ?? [])
    },
  } as unknown as EIP1193Provider
  return { provider, sent }
}

const GAS = 25_200n // 21 000 estimated × 1.2
const NETWORK_COST = GAS * 2_200_000_000n // 5.544e13 wei
const LIMIT = 100_000_000_000_000n // 1e14 wei: the network fee fits, ×2 of it does not

async function account(limits: { transactionMaxFee?: bigint; transferMaxFee?: bigint }, over?: Record<string, (p: unknown[]) => unknown>) {
  const fake = fakeProvider(over)
  const a = await new WalletManagerEvm(SEED, { provider: fake.provider, ...limits }).getAccount(0)
  return { a, sent: fake.sent }
}

describe('the fee cap holds for what is signed', () => {
  it('a network-priced send within the cap goes out, and reports gas × the signed cap', async () => {
    const { a, sent } = await account({ transactionMaxFee: LIMIT })
    const res = await a.sendTransaction({ to: SPENDER, value: 1n })
    expect(sent).toHaveLength(1)
    const tx = parseTransaction(sent[0]!)
    expect(res.fee).toBe(tx.gas! * tx.maxFeePerGas!)
    expect(res.fee).toBe(NETWORK_COST)
  })

  it('legacy: a caller gasPrice above the cap is refused before signing', async () => {
    const { a, sent } = await account({ transactionMaxFee: LIMIT })
    await expect(a.sendTransaction({ to: SPENDER, value: 1n, gasPrice: 100n * GWEI })).rejects.toThrow(/Exceeded maximum fee cost for transaction/)
    await expect(a.sendTransaction({ to: SPENDER, value: 1n, type: 1, gasPrice: 100n * GWEI })).rejects.toThrow(/Exceeded maximum fee cost/)
    expect(sent).toHaveLength(0)
  })

  it('EIP-1559: a caller maxFeePerGas above the cap is refused before signing', async () => {
    const { a, sent } = await account({ transactionMaxFee: LIMIT })
    await expect(a.sendTransaction({ to: SPENDER, value: 1n, maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: GWEI })).rejects.toThrow(/Exceeded maximum fee cost/)
    await expect(a.sendTransaction({ to: SPENDER, value: 1n, maxFeePerGas: 100n * GWEI })).rejects.toThrow(/Exceeded maximum fee cost/)
    expect(sent).toHaveLength(0)
  })

  it('a caller tip above the network\'s lifts the cap with it — and that cap is checked', async () => {
    const { a, sent } = await account({ transactionMaxFee: LIMIT })
    await expect(a.sendTransaction({ to: SPENDER, value: 1n, maxPriorityFeePerGas: 100n * GWEI })).rejects.toThrow(/Exceeded maximum fee cost/)
    expect(sent).toHaveLength(0)
    // within the cap: signed with cap = 1.2 × base + the caller's tip, never a tip above the cap
    await a.sendTransaction({ to: SPENDER, value: 1n, maxPriorityFeePerGas: 2n * GWEI })
    const tx = parseTransaction(sent[0]!)
    expect(tx.maxPriorityFeePerGas).toBe(2n * GWEI)
    expect(tx.maxFeePerGas).toBe(3_200_000_000n)
  })

  it('the mainnet tip floor counts: a cap between the quote and the floored cap is refused', async () => {
    // Quiet blocks: network tip 0 → quote 1.2 gwei; signed with the 0.05 gwei floor → 1.25 gwei.
    const quiet = { eth_maxPriorityFeePerGas: () => '0x0' }
    const between = GAS * 1_220_000_000n
    const { a, sent } = await account({ transferMaxFee: between }, quiet)
    await expect(a.transfer({ recipient: SPENDER, amount: 1n })).rejects.toThrow(/Exceeded maximum fee cost for transfer/)
    expect(sent).toHaveLength(0)
    const ok = await account({ transferMaxFee: GAS * 1_250_000_000n }, quiet)
    await expect(ok.a.transfer({ recipient: SPENDER, amount: 1n })).resolves.toMatchObject({ fee: GAS * 1_250_000_000n })
  })

  it('signTransaction checks the cap on the signed fields, online and offline', async () => {
    const { a } = await account({ transactionMaxFee: LIMIT })
    await expect(a.signTransaction({ to: SPENDER, value: 1n, gasLimit: 21_000n, gasPrice: 100n * GWEI })).rejects.toThrow(/Exceeded maximum fee cost/)
    const offline = await new WalletManagerEvm(SEED, { chainId: 1, transactionMaxFee: LIMIT }).getAccount(0)
    const full = { to: SPENDER, value: 1n, nonce: 0, gasLimit: 21_000n, maxPriorityFeePerGas: GWEI }
    await expect(offline.signTransaction({ ...full, maxFeePerGas: 100n * GWEI })).rejects.toThrow(/Exceeded maximum fee cost/)
    await expect(offline.signTransaction({ ...full, maxFeePerGas: 2n * GWEI })).resolves.toMatch(/^0x02/)
  })

  it('quoteSendTransaction prices the caller\'s fee fields (what the kit maxFee policy reads)', async () => {
    const { a } = await account({})
    const base = { to: SPENDER, value: 1n, gasLimit: 21_000n }
    expect((await a.quoteSendTransaction(base)).fee).toBe(21_000n * 2_200_000_000n)
    expect((await a.quoteSendTransaction({ ...base, gasPrice: 100n * GWEI })).fee).toBe(21_000n * 100n * GWEI)
    expect((await a.quoteSendTransaction({ ...base, maxFeePerGas: 50n * GWEI })).fee).toBe(21_000n * 50n * GWEI)
    expect((await a.quoteSendTransaction({ ...base, maxPriorityFeePerGas: 100n * GWEI })).fee).toBe(21_000n * 101_200_000_000n)
  })

  it('a chain without EIP-1559 still quotes a plain tx at gasPrice', async () => {
    const { a } = await account({}, { eth_getBlockByNumber: () => ({ ...BLOCK, baseFeePerGas: undefined }) })
    expect((await a.quoteSendTransaction({ to: SPENDER, value: 1n, gasLimit: 21_000n })).fee).toBe(21_000n * 30n * GWEI)
  })
})
