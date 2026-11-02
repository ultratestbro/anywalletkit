import { describe, expect, it } from 'vitest'
import { type EIP1193Provider } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// An EIP-1193 provider's error without a JSON-RPC code reaches the account as viem's UnknownRpcError
// (code -1). Its text is not a node's answer unless it carries a node's exact refusal words; an HTTP
// status used as a code, or an HttpRequestError from another copy of viem, is a lost answer.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
const handlers: Record<string, (p: unknown[]) => unknown> = {
  eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
  eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
  eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(64),
  eth_getTransactionByHash: () => null, eth_feeHistory: () => ({ oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
}
/** Same shape as an HttpRequestError from a second copy of viem: `instanceof` does not match it. */
class ForeignHttpRequestError extends Error {
  override name = 'HttpRequestError'
  status = 502
  details = '<html>upstream nonce service timed out</html>'
  shortMessage = 'HTTP request failed.'
}
const throwing = (thrown: () => unknown) => ({
  request: async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_sendRawTransaction') throw thrown()
    return handlers[method]!((params as unknown[]) ?? [])
  },
}) as unknown as EIP1193Provider
const send = async (thrown: () => unknown) => {
  const a = await new WalletManagerEvm(SEED, { provider: throwing(thrown) }).getAccount(0)
  return a.sendTransaction({ to: TO, value: 1n }).catch((x: unknown) => x)
}

describe('EVM broadcast over an EIP-1193 provider: errors without a JSON-RPC code', () => {
  const lost: Array<[string, () => unknown]> = [
    ['a plain Error mentioning "nonce"', () => new Error('HTTP 502 Bad Gateway: <html>upstream nonce service timed out</html>')],
    ['an HTTP status used as the code', () => Object.assign(new Error('Bad Gateway: tip relay down'), { code: 502 })],
    ['an HttpRequestError from another copy of viem', () => new ForeignHttpRequestError('HTTP request failed.\n\nStatus: 502\n\nDetails: <html>upstream nonce service timed out</html>')],
    ['a plain Error with no refusal words', () => new Error('HTTP 502 Bad Gateway')],
  ]
  for (const [name, thrown] of lost) {
    it(`${name}: BroadcastUnknownError`, async () => {
      const e = await send(thrown)
      expect(e).toBeInstanceOf(BroadcastUnknownError)
      expect(e).toMatchObject({ maybeSent: true })
    }, 30_000)
  }

  const refused: Array<[string, () => unknown]> = [
    ['a JSON-RPC -32000 "insufficient funds"', () => Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 })],
    ['a JSON-RPC -32000 "fee cap" refusal', () => Object.assign(new Error('max fee per gas less than block base fee: fee cap too low'), { code: -32000 })],
    ['a plain Error with a node\'s exact words', () => new Error('nonce too high')],
    ['a plain Error "transaction underpriced"', () => new Error('transaction underpriced')],
  ]
  for (const [name, thrown] of refused) {
    it(`${name}: a plain refusal (control)`, async () => {
      const e = await send(thrown)
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(BroadcastUnknownError)
    }, 30_000)
  }
})
