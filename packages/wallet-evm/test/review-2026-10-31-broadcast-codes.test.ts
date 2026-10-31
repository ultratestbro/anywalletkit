import { describe, expect, it } from 'vitest'
import { keccak256, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// A gateway can answer eth_sendRawTransaction with -32603 / -32005 / -32000 "upstream request
// timeout" after the node already took the bytes. That is "maybe sent" (BroadcastUnknownError with
// the hash), never a plain refusal a caller would retry with a second signature. A node's own
// refusal (its wording, or a request-level code) stays a plain error.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }

/** The first broadcast either enters the pool (`accept`) or not, and the node answers with `err` once. */
function erroringOnce(err: { code: number; message: string }, accept: boolean) {
  const pool: Hex[] = []
  let failOnce = true
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x' + (7 + new Set(pool.map((r) => parseTransaction(r).nonce)).size).toString(16),
    eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(64), eth_getTransactionByHash: () => null,
    eth_sendRawTransaction: (p) => {
      const raw = p[0] as Hex
      if (failOnce) {
        failOnce = false
        if (accept) pool.push(raw)
        throw Object.assign(new Error(err.message), { code: err.code })
      }
      pool.push(raw)
      return keccak256(raw)
    },
  }
  return { pool, provider: { request: async ({ method, params }: { method: string; params?: unknown }) => handlers[method]!((params as unknown[]) ?? []) } as unknown as EIP1193Provider }
}

describe('eth_sendRawTransaction errors that do not prove a refusal', () => {
  for (const err of [
    { code: -32603, message: 'internal error' },
    { code: -32005, message: 'request limit exceeded' },
    { code: -32000, message: 'upstream request timeout' },
  ]) {
    it(`code ${err.code} "${err.message}" → BroadcastUnknownError with the signed hash`, async () => {
      const net = erroringOnce(err, true)
      const a = await new WalletManagerEvm(SEED, { provider: net.provider }).getAccount(0)
      const first = await a.sendTransaction({ to: TO, value: 1n }).catch((e: unknown) => e)
      expect(first).toBeInstanceOf(BroadcastUnknownError)
      expect((first as BroadcastUnknownError).maybeSent).toBe(true)
      expect((first as BroadcastUnknownError).hash).toBe(keccak256(net.pool[0]!))
      expect(net.pool.map((r) => parseTransaction(r).nonce)).toEqual([7])
    })
  }
})

describe('refusals stay plain errors (control)', () => {
  for (const err of [
    { code: -32000, message: 'insufficient funds for gas * price + value' },
    { code: -32000, message: 'transaction underpriced' },
    { code: -32700, message: 'parse error' },
    { code: -32600, message: 'invalid request' },
    { code: -32601, message: 'the method eth_sendRawTransaction does not exist' },
    { code: -32602, message: 'invalid argument 0' },
    { code: -32003, message: 'transaction rejected' },
  ]) {
    it(`code ${err.code} "${err.message}"`, async () => {
      const net = erroringOnce(err, false)
      const a = await new WalletManagerEvm(SEED, { provider: net.provider }).getAccount(0)
      const first = await a.sendTransaction({ to: TO, value: 1n }).catch((e: unknown) => e)
      expect(first).toBeInstanceOf(Error)
      expect(first).not.toBeInstanceOf(BroadcastUnknownError)
      // the caller's retry signs the same nonce again (nothing entered the pool)
      await a.sendTransaction({ to: TO, value: 1n })
      expect(net.pool.map((r) => parseTransaction(r).nonce)).toEqual([7])
    })
  }

  it('"already known" is still the same transaction, accepted', async () => {
    const net = erroringOnce({ code: -32000, message: 'already known' }, true)
    const a = await new WalletManagerEvm(SEED, { provider: net.provider }).getAccount(0)
    const r = await a.sendTransaction({ to: TO, value: 1n })
    expect(r.hash).toBe(keccak256(net.pool[0]!))
  })
})
