import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// JSON-RPC -32002 (resource unavailable) is what a gateway answers when its upstream node is not
// reachable. Like -32603 and -32005 it is a refusal only in a node's exact words.

// node's exact words. Ordinary -32000 refusals are read as before.

const SEED = 'test test test test test test test test test test test junk'
const RPC = 'https://evm-a.example/rpc'
const TO = '0x000000000000000000000000000000000000bEEF'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
const HANGS = Symbol('hangs')
type Out = typeof HANGS | { status: number; body: string } | Error

function stub(onSend: () => Out) {
  const sent: Hex[] = []
  const handlers: Record<string, (p: unknown[]) => unknown> = {
    eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
    eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
    eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(64),
    eth_getTransactionByHash: () => null, eth_feeHistory: () => ({ oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
  }
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params?: unknown[] }
    if (req.method !== 'eth_sendRawTransaction') {
      const h = handlers[req.method]
      if (!h) return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `no ${req.method}` } }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: h(req.params ?? []) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    sent.push(req.params![0] as Hex)
    const out = onSend()
    if (out === HANGS) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))))
    if (out instanceof Error) throw out
    return new Response(out.body, { status: out.status, headers: { 'content-type': out.body.startsWith('{') ? 'application/json' : 'text/html' } })
  })
  return sent
}
afterEach(() => { vi.unstubAllGlobals() })

const json = (status: number, error: { code: number; message: string }) => ({ status, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error }) })

async function send(onSend: () => Out) {
  const sent = stub(onSend)
  const a = await new WalletManagerEvm(SEED, { provider: RPC }).getAccount(0)
  return { e: await a.sendTransaction({ to: TO, value: 1n }).catch((x: unknown) => x), sent }
}


describe('EVM broadcast: JSON-RPC -32002 is a gateway code', () => {
  const lost: Array<[string, number, string]> = [
    ['HTTP 503, -32002 mentioning a nonce', 503, 'resource not ready: nonce tracker'],
    ['HTTP 200, -32002 mentioning a tip', 200, 'resource busy reading tip'],
    ['HTTP 200, -32002 mentioning a fee cap', 200, 'fee cap oracle not ready'],
  ]
  for (const [name, status, message] of lost) {
    it(`${name}: BroadcastUnknownError`, async () => {
      const { e, sent } = await send(() => json(status, { code: -32002, message }))
      expect(e).toBeInstanceOf(BroadcastUnknownError)
      expect(e).toMatchObject({ maybeSent: true, hash: keccak256(sent[0]!) })
      expect(sent).toHaveLength(1)
    }, 60_000)
  }
  it('control: -32002 in a node\'s exact words is a plain refusal', async () => {
    const { e } = await send(() => json(200, { code: -32002, message: 'insufficient funds for gas * price + value' }))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)
  it('control: -32000 with the same loose word is still a refusal', async () => {
    const { e } = await send(() => json(200, { code: -32000, message: 'fee cap too low' }))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)
})
