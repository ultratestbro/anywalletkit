import { describe, expect, it } from 'vitest'
import { keccak256, parseTransaction, type EIP1193Provider, type Hex } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// An EIP-1193 provider backed by another copy of viem throws that copy's HttpRequestError /
// TimeoutError. viem wraps it in UnknownRpcError, whose `details` repeat the HTTP page. Wherever an
// HTTP or timeout error sits in the chain, no text in the chain is a node's answer: not a refusal,
// not "already known", whatever the page says.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
const handlers: Record<string, (p: unknown[]) => unknown> = {
  eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
  eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
  eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(64),
  eth_getTransactionByHash: () => null, eth_feeHistory: () => ({ oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
}
const page = (words: string) => `HTTP request failed.\n\nStatus: 503\nURL: https://rpc.example\nRequest body: {}\n\nDetails: <html><body>relay busy: ${words}</body></html>`
/** An HttpRequestError from a second copy of viem: same name and fields, not the same class. */
class ForeignHttpRequestError extends Error {
  override name = 'HttpRequestError'
  body = {}
  headers = undefined
  status = 503
  url = 'https://rpc.example'
}
/** The same error after a bundler renamed the class and dropped the name: known by its fields. */
class MangledHttpRequestError extends Error {
  body = {}
  headers = undefined
  status = 503
  url = 'https://rpc.example'
}
class ForeignTimeoutError extends Error {
  override name = 'TimeoutError'
  body = {}
  url = 'https://rpc.example'
}
const throwing = (thrown: () => unknown, sent: Hex[]) => ({
  request: async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === 'eth_sendRawTransaction') { sent.push((params as Hex[])[0]!); throw thrown() }
    return handlers[method]!((params as unknown[]) ?? [])
  },
}) as unknown as EIP1193Provider
const send = async (thrown: () => unknown) => {
  const sent: Hex[] = []
  const a = await new WalletManagerEvm(SEED, { provider: throwing(thrown, sent) }).getAccount(0)
  return { e: await a.sendTransaction({ to: TO, value: 1n }).catch((x: unknown) => x), sent }
}

describe('EVM broadcast: an HTTP error from another copy of viem is never read as a node answer', () => {
  const errors: Array<[string, (msg: string) => unknown]> = [
    ['HttpRequestError (by name)', (m) => new ForeignHttpRequestError(m)],
    ['HttpRequestError (by its fields)', (m) => new MangledHttpRequestError(m)],
    ['TimeoutError (by name)', (m) => new ForeignTimeoutError(m)],
    ['HttpRequestError under a plain wrapper', (m) => new Error('provider failed', { cause: new ForeignHttpRequestError(m) })],
  ]
  for (const [kind, make] of errors) {
    for (const words of ['insufficient funds for gas * price + value', 'nonce too low', 'transaction underpriced']) {
      it(`${kind}, page says "${words}": BroadcastUnknownError`, async () => {
        const { e, sent } = await send(() => make(page(words)))
        expect(e).toBeInstanceOf(BroadcastUnknownError)
        expect(e).toMatchObject({ maybeSent: true, hash: keccak256(sent[0]!) })
        expect(sent).toHaveLength(1)
      }, 30_000)
    }
    it(`${kind}, page says "already known": BroadcastUnknownError, not a success`, async () => {
      const { e, sent } = await send(() => make(page('already known')))
      expect(e).toBeInstanceOf(BroadcastUnknownError)
      expect(e).toMatchObject({ maybeSent: true, hash: keccak256(sent[0]!) })
    }, 30_000)
  }

  it('control: a JSON-RPC -32000 "already known" from the provider is accepted', async () => {
    const { e, sent } = await send(() => Object.assign(new Error('already known'), { code: -32000 }))
    expect(e).not.toBeInstanceOf(Error)
    expect(e).toMatchObject({ hash: keccak256(sent[0]!) })
    expect(parseTransaction(sent[0]!).nonce).toBe(7)
  }, 30_000)
  it('control: a JSON-RPC -32000 "insufficient funds" is a plain refusal', async () => {
    const { e } = await send(() => Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 }))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)
  it('control: a plain provider Error with a node\'s exact words is a plain refusal', async () => {
    const { e } = await send(() => new Error('transaction underpriced'))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)
  it('control: a provider error carrying a url and a JSON-RPC code is still a node refusal', async () => {
    const { e } = await send(() => Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000, url: 'https://rpc.example', status: 200 }))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)
})
