import { describe, expect, it } from 'vitest'
import { keccak256, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { DEFAULT_MAX_FEE_RATE_MULTIPLIER, MIN_FEE_RATE_CEILING_WEI, UnsafeTransactionError, WalletManagerEvm, type EvmConfig } from '../src/index.js'

// A fee rate the caller set is signed as given, so it is held against the network's current quote:
// above maxFeeRateMultiplier (default 10) × the quote, and above 10 gwei, it is refused before
// signing. Fees the account fills in, signing without a provider and an unreadable quote are not
// checked, so a flaky RPC adds no new failure.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const GWEI = 10n ** 9n
const hex = (n: bigint) => '0x' + n.toString(16)

/** A chain whose base fee is `base` (undefined = no EIP-1559) with tip `tip` and eth_gasPrice `gasPrice`. */
function chain(o: { base?: bigint; tip?: bigint; gasPrice?: bigint; feesFail?: boolean }) {
  const sent: Hex[] = []
  const calls: string[] = []
  const block = { number: '0x10', ...(o.base !== undefined ? { baseFeePerGas: hex(o.base) } : {}), gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
  const fail = () => { throw Object.assign(new Error('upstream request timeout'), { code: -32000 }) }
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => (o.feesFail ? fail() : block),
    eth_maxPriorityFeePerGas: () => (o.feesFail ? fail() : hex(o.tip ?? GWEI)),
    eth_gasPrice: () => (o.feesFail ? fail() : hex(o.gasPrice ?? (o.base ?? 0n) + (o.tip ?? GWEI))),
    eth_estimateGas: () => '0x5208', eth_getTransactionCount: () => '0x7', eth_getBalance: () => hex(10n ** 24n), eth_call: () => '0x',
    eth_getTransactionByHash: () => null,
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return keccak256(p[0] as Hex) },
  }
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => { calls.push(method); return handlers[method]!((params as unknown[]) ?? []) } } as unknown as EIP1193Provider
  return { provider, sent, calls }
}

const account = (config: EvmConfig) => new WalletManagerEvm(SEED, { retries: 0, ...config }).getAccount(0)
const tx1559 = (maxFeePerGas: bigint, maxPriorityFeePerGas = GWEI) => ({ to: TO, value: 1n, nonce: 0, gasLimit: 30_000_000n, maxFeePerGas, maxPriorityFeePerGas })

describe('EVM fee-rate ceiling on caller-set fees', () => {
  it('defaults: 10× the quote, never below 10 gwei', () => {
    expect(DEFAULT_MAX_FEE_RATE_MULTIPLIER).toBe(10)
    expect(MIN_FEE_RATE_CEILING_WEI).toBe(10n * GWEI)
  })

  it('maxFeePerGas 10,000 gwei on a 20 gwei chain is refused by signTransaction and sendTransaction; nothing is broadcast', async () => {
    const net = chain({ base: 20n * GWEI })
    const a = await account({ provider: net.provider })
    await expect(a.signTransaction(tx1559(10_000n * GWEI))).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(a.sendTransaction({ to: TO, value: 1n, maxFeePerGas: 10_000n * GWEI, maxPriorityFeePerGas: GWEI })).rejects.toThrow(/maxFeeRateMultiplier/)
    expect(net.sent).toHaveLength(0)
  })

  it('a huge tip alone is refused too', async () => {
    const a = await account({ provider: chain({ base: 20n * GWEI }).provider })
    await expect(a.sendTransaction({ to: TO, value: 1n, maxPriorityFeePerGas: 10_000n * GWEI })).rejects.toBeInstanceOf(UnsafeTransactionError)
  })

  it('a legacy gasPrice is held against eth_gasPrice on a chain without EIP-1559', async () => {
    const net = chain({ gasPrice: 5n * GWEI })
    const a = await account({ provider: net.provider })
    await expect(a.signTransaction({ to: TO, value: 1n, nonce: 0, gasLimit: 21_000n, gasPrice: 10_000n * GWEI })).rejects.toBeInstanceOf(UnsafeTransactionError)
    const raw = await a.signTransaction({ to: TO, value: 1n, nonce: 0, gasLimit: 21_000n, gasPrice: 40n * GWEI })
    expect(parseTransaction(raw as Hex).gasPrice).toBe(40n * GWEI)
  })

  it('normal use is signed: 9× the quote, a spike the quote already shows, a 30M-gas call', async () => {
    const calm = await account({ provider: chain({ base: 20n * GWEI }).provider })
    // quote = 20 × 1.2 + 1 = 25 gwei
    await expect(calm.signTransaction(tx1559(225n * GWEI))).resolves.toMatch(/^0x02/)
    const spike = await account({ provider: chain({ base: 800n * GWEI, tip: 50n * GWEI }).provider })
    await expect(spike.signTransaction(tx1559(2_000n * GWEI, 100n * GWEI))).resolves.toMatch(/^0x02/)
  })

  it('a fixed few-gwei price on a chain at a fraction of a gwei is under the 10 gwei floor', async () => {
    const a = await account({ provider: chain({ base: 5_000_000n, tip: 1_000_000n }).provider }) // 0.005 gwei
    await expect(a.signTransaction(tx1559(3n * GWEI, 1n * GWEI))).resolves.toMatch(/^0x02/)
    await expect(a.signTransaction(tx1559(10n * GWEI, 1n * GWEI))).resolves.toMatch(/^0x02/)
    await expect(a.signTransaction(tx1559(11n * GWEI, 1n * GWEI))).rejects.toBeInstanceOf(UnsafeTransactionError)
  })

  it('maxFeeRateMultiplier changes it; null or Infinity turns it off', async () => {
    const strict = await account({ provider: chain({ base: 20n * GWEI }).provider, maxFeeRateMultiplier: 2 })
    await expect(strict.signTransaction(tx1559(75n * GWEI))).rejects.toBeInstanceOf(UnsafeTransactionError)
    await expect(strict.signTransaction(tx1559(50n * GWEI))).resolves.toMatch(/^0x02/)
    for (const off of [null, Infinity]) {
      const a = await account({ provider: chain({ base: 20n * GWEI }).provider, maxFeeRateMultiplier: off })
      await expect(a.signTransaction(tx1559(10_000n * GWEI))).resolves.toMatch(/^0x02/)
    }
  })

  it('an unreadable quote refuses nothing', async () => {
    const a = await account({ provider: chain({ base: 20n * GWEI, feesFail: true }).provider })
    await expect(a.signTransaction({ ...tx1559(10_000n * GWEI), chainId: 1 })).resolves.toMatch(/^0x02/)
  })

  it('without a provider (offline signing) there is no quote: transactionMaxFee is the cap there', async () => {
    const offline = await account({ chainId: 1 })
    await expect(offline.signTransaction({ ...tx1559(10_000n * GWEI), chainId: 1 })).resolves.toMatch(/^0x02/)
    const capped = await account({ chainId: 1, transactionMaxFee: 10n ** 16n })
    await expect(capped.signTransaction({ ...tx1559(10_000n * GWEI), chainId: 1 })).rejects.toThrow(/maximum fee/)
  })

  it('fees the account fills in are not checked and cost no extra fee reads', async () => {
    const net = chain({ base: 20n * GWEI })
    const a = await account({ provider: net.provider })
    const r = await a.sendTransaction({ to: TO, value: 1n })
    expect(r.hash).toBe(keccak256(net.sent[0]!))
    expect(net.calls.filter((m) => m === 'eth_gasPrice')).toHaveLength(0)
  })
})
