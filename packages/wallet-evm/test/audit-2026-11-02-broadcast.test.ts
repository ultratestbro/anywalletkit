import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, parseTransaction, type Hex } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// Over the real viem http transport (global fetch stubbed): a node-refusal word inside an HTTP
// error (a gateway's 5xx body, its URL) is not the node's answer. eth_sendRawTransaction then ends
// as BroadcastUnknownError (maybeSent, hash); the same words in a JSON-RPC error stay a refusal.

const SEED = 'test test test test test test test test test test test junk'
const RPC = 'https://evm-a.example/rpc'
const TIP_RPC = 'https://tip-nonce.example/rpc'
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

async function send(onSend: () => Out, provider = RPC) {
  const sent = stub(onSend)
  const a = await new WalletManagerEvm(SEED, { provider }).getAccount(0)
  return { e: await a.sendTransaction({ to: TO, value: 1n }).catch((x: unknown) => x), sent }
}

describe('EVM broadcast: refusal words inside an HTTP error are not a refusal', () => {
  const cases: Array<[string, () => Out, string?]> = [
    ['HTTP 503 json body without a JSON-RPC code, "nonce"', () => ({ status: 503, body: JSON.stringify({ error: 'nonce manager unavailable, retry' }) })],
    ['HTTP 502 json body "insufficient funds"', () => ({ status: 502, body: JSON.stringify({ message: 'insufficient funds on the gateway plan', status: 502 }) })],
    ['HTTP 504 text "invalid transaction"', () => ({ status: 504, body: 'gateway timeout while relaying invalid transaction check' })],
    ['HTTP 500 html mentioning a tip', () => ({ status: 500, body: '<html>tip: retry later; underpriced plans available</html>' })],
    ['HTTP 500 from a URL with "tip" and "nonce" in it', () => ({ status: 500, body: 'Internal Server Error' }), TIP_RPC],
  ]
  for (const [name, b, provider] of cases) {
    it(name, async () => {
      const { e, sent } = await send(b, provider)
      expect(e).toBeInstanceOf(BroadcastUnknownError)
      expect(e).toMatchObject({ maybeSent: true, hash: keccak256(sent[0]!) })
      expect(new Set(sent).size).toBe(1)
    }, 30_000)
  }
})

describe('EVM broadcast: a JSON-RPC refusal on HTTP 200 stays a plain error (control)', () => {
  for (const message of ['insufficient funds for gas * price + value', 'transaction underpriced', 'intrinsic gas too low']) {
    it(message, async () => {
      const { e, sent } = await send(() => json(200, { code: -32000, message }))
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(BroadcastUnknownError)
      expect(sent.length).toBe(1)
    }, 30_000)
  }
})
