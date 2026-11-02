import { describe, expect, it } from 'vitest'
import { keccak256, type EIP1193Provider, type Hex } from 'viem'
import { UnsafeTransactionError, WalletManagerEvm, type EvmConfig } from '../src/index.js'

// maxFeeRateMultiplier is null, Infinity or a number >= 1. Anything below 1 (or NaN) is refused when
// the account is created; a huge finite value means "off" instead of overflowing.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const GWEI = 10n ** 9n
const hex = (n: bigint) => '0x' + n.toString(16)
const BLOCK = { number: '0x10', baseFeePerGas: hex(20n * GWEI), gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
const handlers: Record<string, (p: unknown[]) => unknown> = {
  eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
  eth_maxPriorityFeePerGas: () => hex(GWEI), eth_gasPrice: () => hex(21n * GWEI), eth_estimateGas: () => '0x5208',
  eth_getTransactionCount: () => '0x7', eth_getBalance: () => hex(10n ** 24n), eth_call: () => '0x', eth_getTransactionByHash: () => null,
  eth_sendRawTransaction: (p) => keccak256(p[0] as Hex),
}
const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => handlers[method]!((params as unknown[]) ?? []) } as unknown as EIP1193Provider
const account = (k: unknown) => new WalletManagerEvm(SEED, { provider, chainId: 1, maxFeeRateMultiplier: k } as EvmConfig).getAccount(0)
const tx = (maxFeePerGas: bigint) => ({ chainId: 1, to: TO, value: 1n, nonce: 0, gasLimit: 21_000n, maxFeePerGas, maxPriorityFeePerGas: GWEI })

describe('EVM maxFeeRateMultiplier', () => {
  for (const k of [0, -1, 0.5, Number.NaN, -Infinity, '10']) {
    it(`${String(k)} is refused when the account is created`, async () => {
      await expect(account(k)).rejects.toBeInstanceOf(RangeError)
    })
  }

  for (const k of [Number.MAX_VALUE, 1e300, 2_000_000]) {
    it(`${k} means off: a far-above-quote rate is signed, no RangeError`, async () => {
      const a = await account(k)
      await expect(a.signTransaction(tx(100_000n * GWEI))).resolves.toMatch(/^0x02/)
    })
  }

  it('control: 1 signs at the quote and refuses above it', async () => {
    const a = await account(1)
    // quote = max(1.2 × 20 + 1, 21) = 25 gwei
    await expect(a.signTransaction(tx(25n * GWEI))).resolves.toMatch(/^0x02/)
    await expect(a.signTransaction(tx(26n * GWEI))).rejects.toBeInstanceOf(UnsafeTransactionError)
  })

  for (const k of [undefined, null, Infinity, 10]) {
    it(`control: ${String(k)} is accepted`, async () => {
      await expect(account(k)).resolves.toBeTruthy()
    })
  }
})
