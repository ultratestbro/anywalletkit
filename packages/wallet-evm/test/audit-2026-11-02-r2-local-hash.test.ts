import { describe, expect, it } from 'vitest'
import { keccak256, type EIP1193Provider, type Hex } from 'viem'
import { WalletManagerEvm } from '../src/index.js'

// A successful broadcast returns keccak256 of the bytes this account signed, whatever hash the RPC echoes.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
function provider(echo: (raw: Hex) => unknown) {
  const sent: Hex[] = []
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(64),
    eth_getTransactionByHash: () => null, eth_feeHistory: () => ({ oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
    eth_sendRawTransaction: (p) => { sent.push(p[0] as Hex); return echo(p[0] as Hex) },
  }
  return { sent, provider: { request: async ({ method, params }: { method: string; params?: unknown[] }) => handlers[method]!(params ?? []) } as unknown as EIP1193Provider }
}

describe('EVM broadcast: the returned hash is the signed hash', () => {
  it('an RPC echoing a hash of another transaction', async () => {
    const p = provider(() => '0x' + 'ab'.repeat(32))
    const r = await (await new WalletManagerEvm(SEED, { provider: p.provider }).getAccount(0)).sendTransaction({ to: TO, value: 1n })
    expect(r.hash).toBe(keccak256(p.sent[0]!))
  })
  it('control: an RPC echoing the right hash', async () => {
    const p = provider((raw) => keccak256(raw))
    const r = await (await new WalletManagerEvm(SEED, { provider: p.provider }).getAccount(0)).sendTransaction({ to: TO, value: 1n })
    expect(r.hash).toBe(keccak256(p.sent[0]!))
  })
})
