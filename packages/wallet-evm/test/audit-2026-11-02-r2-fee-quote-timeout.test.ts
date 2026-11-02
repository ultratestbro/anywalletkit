import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, type EIP1193Provider, type Hex } from 'viem'
import { FEE_QUOTE_TIMEOUT_MS, UnsafeTransactionError, WalletManagerEvm, type EvmConfig } from '../src/index.js'

// The fee-rate check waits at most FEE_QUOTE_TIMEOUT_MS for the network quote; a silent RPC makes it
// skip the check, as an unreadable quote does, instead of holding up the signature.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const GWEI = 10n ** 9n
const hex = (n: bigint) => '0x' + n.toString(16)

function chain(o: { base?: bigint; tip?: bigint; gasPrice?: bigint; hangFees?: boolean; chainId?: number }) {
  const calls: string[] = []
  const block = { number: '0x10', ...(o.base !== undefined ? { baseFeePerGas: hex(o.base) } : {}), gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
  const never = () => new Promise(() => {})
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => hex(BigInt(o.chainId ?? 1)), eth_blockNumber: () => '0x10',
    eth_getBlockByNumber: () => (o.hangFees ? never() : block),
    eth_maxPriorityFeePerGas: () => (o.hangFees ? never() : hex(o.tip ?? GWEI)),
    eth_gasPrice: () => (o.hangFees ? never() : hex(o.gasPrice ?? (o.base ?? 0n) + (o.tip ?? GWEI))),
    eth_estimateGas: () => '0x5208', eth_getTransactionCount: () => '0x7', eth_getBalance: () => hex(10n ** 24n), eth_call: () => '0x',
    eth_getTransactionByHash: () => null,
    eth_sendRawTransaction: (p) => keccak256(p[0] as Hex),
  }
  const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => { calls.push(method); return handlers[method]!((params as unknown[]) ?? []) } } as unknown as EIP1193Provider
  return { provider, calls }
}
const account = (config: EvmConfig) => new WalletManagerEvm(SEED, { retries: 0, ...config }).getAccount(0)
const tx = (maxFeePerGas: bigint, maxPriorityFeePerGas = GWEI) => ({ chainId: 1, to: TO, value: 1n, nonce: 0, gasLimit: 21_000n, maxFeePerGas, maxPriorityFeePerGas })

afterEach(() => { vi.useRealTimers() })

describe('EVM fee-rate check: bounded quote reads', () => {
  it('a provider that never answers the fee reads: signTransaction signs after the timeout', async () => {
    const net = chain({ base: 20n * GWEI, hangFees: true })
    const a = await account({ provider: net.provider, chainId: 1 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let done = false
    const signing = a.signTransaction(tx(30n * GWEI)).then((raw) => { done = true; return raw })
    await vi.advanceTimersByTimeAsync(FEE_QUOTE_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(signing).resolves.toMatch(/^0x02/)
    expect(net.calls).toEqual(expect.arrayContaining(['eth_gasPrice']))
  })

  it('control: an answering provider still refuses a rate far above the quote', async () => {
    const a = await account({ provider: chain({ base: 20n * GWEI }).provider, chainId: 1 })
    await expect(a.signTransaction(tx(1_000n * GWEI))).rejects.toBeInstanceOf(UnsafeTransactionError)
  })

  it('control: an answering provider signs a rate near the quote', async () => {
    const a = await account({ provider: chain({ base: 20n * GWEI }).provider, chainId: 1 })
    await expect(a.signTransaction(tx(30n * GWEI))).resolves.toMatch(/^0x02/)
  })
})
