import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, type Hex } from 'viem'
import { BroadcastUnknownError, WalletManagerEvm } from '../src/index.js'

// With a provider list, viem's fallback hands the same signed bytes to the next endpoint and throws
// only the last error. When an earlier endpoint got the bytes and gave no answer, a refusal from a
// later one does not prove the transaction stayed off the network: BroadcastUnknownError.

const SEED = 'test test test test test test test test test test test junk'
const TO = '0x000000000000000000000000000000000000bEEF'
const A = 'https://a.example/rpc'
const B = 'https://b.example/rpc'
const BLOCK = { number: '0x10', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [], miner: '0x' + '00'.repeat(20), difficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000', receiptsRoot: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), size: '0x0', stateRoot: '0x' + '00'.repeat(32), totalDifficulty: '0x0', transactionsRoot: '0x' + '00'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32) }
const handlers: Record<string, (p: unknown[]) => unknown> = {
  eth_chainId: () => '0x1', eth_blockNumber: () => '0x10', eth_getBlockByNumber: () => BLOCK,
  eth_maxPriorityFeePerGas: () => '0x3b9aca00', eth_gasPrice: () => '0x6fc23ac00', eth_estimateGas: () => '0x5208',
  eth_getTransactionCount: () => '0x7', eth_getBalance: () => '0xde0b6b3a7640000', eth_call: () => '0x' + '0'.repeat(64),
  eth_getTransactionByHash: () => null, eth_feeHistory: () => ({ oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] }),
}
type Out = { status: number; body: string } | 'ok'
afterEach(() => { vi.unstubAllGlobals() })

function stub(onSend: (url: string) => Out) {
  const hits: Array<{ url: string; raw: Hex }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params?: unknown[] }
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (req.method !== 'eth_sendRawTransaction') return ok(handlers[req.method]!(req.params ?? []))
    const raw = req.params![0] as Hex
    hits.push({ url: String(url), raw })
    const out = onSend(String(url))
    if (out === 'ok') return ok(keccak256(raw))
    return new Response(out.body.replace('"id":1', `"id":${req.id}`), { status: out.status, headers: { 'content-type': out.body.startsWith('{') ? 'application/json' : 'text/plain' } })
  })
  return hits
}
const rpcError = (code: number, message: string): Out => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }) })
const http500: Out = { status: 500, body: 'Internal Server Error' }

async function send(onSend: (url: string) => Out, provider: string | string[] = [A, B]) {
  const hits = stub(onSend)
  const a = await new WalletManagerEvm(SEED, { provider, retries: 0 }).getAccount(0)
  return { r: await a.sendTransaction({ to: TO, value: 1n }).catch((x: unknown) => x), hits }
}

describe('EVM fallback broadcast', () => {
  const later: Array<[string, Out]> = [
    ['-32601 method not found', rpcError(-32601, 'the method eth_sendRawTransaction does not exist/is not available')],
    ['-32000 transaction underpriced', rpcError(-32000, 'transaction underpriced')],
    ['-32000 insufficient funds', rpcError(-32000, 'insufficient funds for gas * price + value')],
    ['-32003 transaction rejected', rpcError(-32003, 'transaction rejected')],
  ]
  for (const [name, out] of later) {
    it(`A answers HTTP 500, B answers ${name}: BroadcastUnknownError`, async () => {
      const { r, hits } = await send((url) => (url === A ? http500 : out))
      expect(hits.map((h) => h.url)).toEqual([A, B])
      expect(new Set(hits.map((h) => h.raw)).size).toBe(1)
      expect(r).toBeInstanceOf(BroadcastUnknownError)
      expect(r).toMatchObject({ maybeSent: true, hash: keccak256(hits[0]!.raw) })
    }, 30_000)
  }

  it('A answers "already known", B refuses: the send is accepted (A holds the bytes)', async () => {
    const { r, hits } = await send((url) => (url === A ? rpcError(-32000, 'already known') : rpcError(-32000, 'transaction underpriced')))
    expect(r).toMatchObject({ hash: keccak256(hits[0]!.raw) })
  }, 30_000)

  it('control: A and B both refuse: a plain refusal', async () => {
    const { r } = await send(() => rpcError(-32000, 'insufficient funds for gas * price + value'))
    expect(r).toBeInstanceOf(Error)
    expect(r).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)

  it('control: A answers HTTP 500, B accepts: sent', async () => {
    const { r, hits } = await send((url) => (url === A ? http500 : 'ok'))
    expect(r).toMatchObject({ hash: keccak256(hits[0]!.raw) })
  }, 30_000)

  it('control: one endpoint refusing is a plain refusal', async () => {
    const { r } = await send(() => rpcError(-32000, 'transaction underpriced'), A)
    expect(r).toBeInstanceOf(Error)
    expect(r).not.toBeInstanceOf(BroadcastUnknownError)
  }, 30_000)

  it('a second send after an ambiguous one starts with a clean record', async () => {
    let round = 0
    const hits = stub((url) => (round === 0 ? (url === A ? http500 : rpcError(-32000, 'transaction underpriced')) : rpcError(-32000, 'insufficient funds for gas * price + value')))
    const a = await new WalletManagerEvm(SEED, { provider: [A, B], retries: 0 }).getAccount(0)
    expect(await a.sendTransaction({ to: TO, value: 1n }).catch((x: unknown) => x)).toBeInstanceOf(BroadcastUnknownError)
    round = 1
    const second = await a.sendTransaction({ to: TO, value: 2n }).catch((x: unknown) => x)
    expect(second).toBeInstanceOf(Error)
    expect(second).not.toBeInstanceOf(BroadcastUnknownError)
    expect(hits.length).toBe(4)
  }, 30_000)
})
