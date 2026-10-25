import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastUnknownError, NearRpcError, WalletManagerNear, decodeSignedTransaction, fromBase64 } from '../src/index.js'
import { SEED, fakeNode } from './fake-node.js'

// Audit 2026-10-25, finding 10: an RPC that never answered hung every call (no timeout, so
// failover never ran); a send_tx whose answer was lost must end as "maybe sent", not be re-sent.

const A = 'https://a.example'
const B = 'https://b.example'
const TIMEOUT_MS = 60
const HANGS = Symbol('hangs')
type Behave = (method: string, params: unknown) => unknown

/** Route global fetch (JSON-RPC over POST) by URL; HANGS never answers until the request's signal aborts. */
function stubFetch(routes: Record<string, Behave>) {
  const hits: Array<{ url: string; method: string; params: unknown }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: string; method: string; params: unknown }
    hits.push({ url, method, params })
    let out: unknown
    try { out = await routes[url]!(method, params) } catch (e) {
      if (e instanceof NearRpcError) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: e.cause }), { status: 200 })
      throw e
    }
    if (out === HANGS) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: out }), { status: 200 })
  })
  return hits
}
const node = fakeNode()
const serve: Behave = (method, params) => node.fetch(method, params)
const hangs: Behave = () => HANGS
const hangsOnSend: Behave = (method, params) => (method === 'send_tx' ? HANGS : node.fetch(method, params))
const sentTxs = (hits: Array<{ method: string; params: unknown }>) => hits.filter((h) => h.method === 'send_tx').map((h) => (h.params as { signed_tx_base64: string }).signed_tx_base64)

afterEach(() => { vi.unstubAllGlobals() })

describe('NEAR transport: timeouts and failover', () => {
  it('the first RPC hangs → the answer comes from the second', async () => {
    const hits = stubFetch({ [A]: hangs, [B]: serve })
    const a = await new WalletManagerNear(SEED, { provider: [A, B], timeoutMs: TIMEOUT_MS }).getAccount(0)
    const t = Date.now()
    expect(await a.getBalance()).toBe(5n * 10n ** 24n)
    expect(Date.now() - t).toBeLessThan(2_000)
    expect(hits.map((h) => h.url)).toEqual([A, B])
  })

  it('one RPC that hangs fails after the timeout instead of never', async () => {
    stubFetch({ [A]: hangs })
    const a = await new WalletManagerNear(SEED, { provider: A, timeoutMs: TIMEOUT_MS }).getAccount(0)
    await expect(a.getBalance()).rejects.toThrow()
  })

  it('send_tx without an answer → BroadcastUnknownError with the local hash, not re-sent to the next RPC', async () => {
    const hits = stubFetch({ [A]: hangsOnSend, [B]: serve })
    const a = await new WalletManagerNear(SEED, { provider: [A, B], timeoutMs: TIMEOUT_MS }).getAccount(0)
    const err = await a.transfer({ recipient: 'alice.near', amount: 1n }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BroadcastUnknownError)
    const sent = sentTxs(hits)
    expect(sent).toHaveLength(1) // one attempt, one transaction
    expect(hits.filter((h) => h.method === 'send_tx').map((h) => h.url)).toEqual([A])
    const signed = decodeSignedTransaction(fromBase64(sent[0]!))
    expect(err).toMatchObject({ maybeSent: true, hash: (await import('../src/index.js')).WalletAccountReadOnlyNear.txHash(signed.transaction) })
  })

  it('a node TIMEOUT on send_tx is "maybe sent" too', async () => {
    const timeout: Behave = (method, params) => {
      if (method === 'send_tx') throw new NearRpcError('send_tx', { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } })
      return node.fetch(method, params)
    }
    const hits = stubFetch({ [A]: timeout, [B]: serve })
    const a = await new WalletManagerNear(SEED, { provider: [A, B], timeoutMs: TIMEOUT_MS }).getAccount(0)
    await expect(a.transfer({ recipient: 'alice.near', amount: 1n })).rejects.toBeInstanceOf(BroadcastUnknownError)
    expect(sentTxs(hits)).toHaveLength(1)
  })

  it('a node\'s definitive refusal is a clean failure', async () => {
    const invalid: Behave = (method, params) => {
      if (method === 'send_tx') throw new NearRpcError('send_tx', { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: 'InvalidNonce' } } })
      return node.fetch(method, params)
    }
    stubFetch({ [A]: invalid })
    const a = await new WalletManagerNear(SEED, { provider: A, timeoutMs: TIMEOUT_MS }).getAccount(0)
    const err = await a.transfer({ recipient: 'alice.near', amount: 1n }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NearRpcError)
    expect(err).not.toBeInstanceOf(BroadcastUnknownError)
  })
})
