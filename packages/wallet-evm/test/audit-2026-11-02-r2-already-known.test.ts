import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// "already known" means the node holds these exact bytes, so the send is accepted. An HTTP error page
// (no JSON-RPC body) that happens to say "already known" is not a node's answer: BroadcastUnknownError.

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

describe('EVM broadcast: "already known" only from a node', () => {
  it('HTTP 503 html page saying "already known": BroadcastUnknownError, not a success', async () => {
    const { e, sent } = await send(() => ({ status: 503, body: '<html>503: relay busy, request already known to queue</html>' }))
    expect(e).toBeInstanceOf(BroadcastUnknownError)
    expect(e).toMatchObject({ maybeSent: true, hash: keccak256(sent[0]!) })
  }, 60_000)

  it('HTTP 502 json body without a JSON-RPC code saying "known transaction": BroadcastUnknownError', async () => {
    const { e } = await send(() => ({ status: 502, body: JSON.stringify({ message: 'known transaction cache offline' }) }))
    expect(e).toBeInstanceOf(BroadcastUnknownError)
  }, 60_000)

  for (const status of [200, 400, 500]) {
    it(`control: HTTP ${status}, JSON-RPC -32000 "already known": accepted with the signed hash`, async () => {
      const { e, sent } = await send(() => json(status, { code: -32000, message: 'already known' }))
      expect(e).not.toBeInstanceOf(Error)
      expect(e).toMatchObject({ hash: keccak256(sent[0]!) })
    }, 30_000)
  }
})
