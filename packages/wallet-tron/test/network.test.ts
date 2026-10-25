import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastUnknownError, WalletManagerTron, toHexAddress, type TronRawTransaction } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// Audit 2026-10-25, findings 10 and 11: an RPC that never answered hung every call (no timeout,
// so failover never ran), and sun amounts went through Number().

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const A = 'https://a.example'
const B = 'https://b.example'
const TIMEOUT_MS = 60
const HANGS = Symbol('hangs')
const BROADCAST = '/wallet/broadcasttransaction'
type Behave = (path: string, body: Record<string, unknown>) => unknown

/** Route global fetch by base URL; a handler that returns HANGS never answers (until the request's signal aborts). */
function stubFetch(routes: Record<string, Behave>) {
  const hits: Array<{ base: string; path: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const base = Object.keys(routes).find((b) => url.startsWith(b))!
    const path = url.slice(base.length)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    hits.push({ base, path, body })
    const out = await routes[base]!(path, body)
    if (out === HANGS) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))))
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return hits
}
const hangs: Behave = () => HANGS
const serve = (node: ReturnType<typeof fakeNode>): Behave => (path, body) => node.fetch(path, body)
const hangsOnBroadcast = (node: ReturnType<typeof fakeNode>): Behave => (path, body) => (path === BROADCAST ? HANGS : node.fetch(path, body))

const withNow = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Tron transport: timeouts and failover', () => {
  it('the first RPC hangs → the answer comes from the second', async () => {
    const hits = stubFetch({ [A]: hangs, [B]: serve(fakeNode()) })
    const a = await new WalletManagerTron(SEED, { provider: [A, B], timeoutMs: TIMEOUT_MS }).getAccount(0)
    const t = Date.now()
    expect(await a.getBalance()).toBe(5_000_000n)
    expect(Date.now() - t).toBeLessThan(2_000)
    expect(hits.map((h) => h.base)).toEqual([A, B])
  })

  it('one RPC that hangs fails after the timeout instead of never', async () => {
    stubFetch({ [A]: hangs })
    const a = await new WalletManagerTron(SEED, { provider: A, timeoutMs: TIMEOUT_MS }).getAccount(0)
    await expect(a.getBalance()).rejects.toThrow()
  })

  it('broadcast: the first RPC hangs, the next answers DUP_TRANSACTION_ERROR → accepted, one signed transaction', async () => {
    const node = fakeNode()
    const dup: Behave = (path, body) => (path === BROADCAST ? { result: false, code: 'DUP_TRANSACTION_ERROR', message: '647570' } : node.fetch(path, body))
    const hits = stubFetch({ [A]: hangsOnBroadcast(node), [B]: dup })
    const a = await new WalletManagerTron(SEED, { provider: [A, B], timeoutMs: TIMEOUT_MS }).getAccount(0)
    const res = await withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1_000_000n }))
    const broadcasts = hits.filter((h) => h.path === BROADCAST)
    expect(broadcasts.map((h) => h.base)).toEqual([A, B])
    expect(new Set(broadcasts.map((h) => (h.body as { txID: string }).txID)).size).toBe(1) // the same bytes, never re-signed
    expect(res.hash).toBe((broadcasts[0]!.body as { txID: string }).txID)
  })

  it('broadcast: no node answers → BroadcastUnknownError with the txID, never a second transaction', async () => {
    const node = fakeNode()
    const hits = stubFetch({ [A]: hangsOnBroadcast(node), [B]: hangsOnBroadcast(node) })
    const a = await new WalletManagerTron(SEED, { provider: [A, B], timeoutMs: TIMEOUT_MS }).getAccount(0)
    const err = await withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1_000_000n })).catch((e: unknown) => e)
    const txids = new Set(hits.filter((h) => h.path === BROADCAST).map((h) => (h.body as { txID: string }).txID))
    expect(err).toBeInstanceOf(BroadcastUnknownError)
    expect(txids.size).toBe(1)
    expect(err).toMatchObject({ maybeSent: true, hash: [...txids][0] })
  })

  it('broadcast: a node\'s own refusal is a clean failure, not "maybe sent"', async () => {
    const node = fakeNode()
    const refuse: Behave = (path, body) => (path === BROADCAST ? { result: false, code: 'CONTRACT_VALIDATE_ERROR', message: '6e6f' } : node.fetch(path, body))
    stubFetch({ [A]: refuse })
    const a = await new WalletManagerTron(SEED, { provider: A, timeoutMs: TIMEOUT_MS }).getAccount(0)
    const err = await withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1_000_000n })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(BroadcastUnknownError)
    expect(String(err)).toMatch(/CONTRACT_VALIDATE_ERROR/)
  })
})

describe('Tron amounts: no Number() on sun', () => {
  const balanceText = (digits: string) => `{"address":"41aa","balance":${digits}}`

  it('getBalance reads 2^53 − 1, 2^53 and 2^53 + 1 sun exactly over HTTP', async () => {
    for (const v of [2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, 10n ** 20n]) {
      stubFetch({ [A]: (path) => (path === '/wallet/getaccount' ? balanceText(v.toString()) : {}) })
      const a = await new WalletManagerTron(SEED, { provider: A }).getAccount(0)
      expect(await a.getBalance(), v.toString()).toBe(v)
    }
  })

  it('a custom transport that already lost precision is refused, not trusted', async () => {
    const node = fakeNode({ '/wallet/getaccount': () => ({ address: '41aa', balance: 2 ** 53 + 2 }) })
    const a = await new WalletManagerTron(SEED, { provider: node.fetch }).getAccount(0)
    await expect(a.getBalance()).rejects.toThrow(/precision|safe integer/i)
    const ok = await new WalletManagerTron(SEED, { provider: fakeNode({ '/wallet/getaccount': () => ({ balance: 2 ** 53 - 1 }) }).fetch }).getAccount(0)
    expect(await ok.getBalance()).toBe(2n ** 53n - 1n)
  })

  it('a transfer above 2^53 − 1 sun is refused before the node builds it', async () => {
    const node = fakeNode({ '/wallet/getaccount': () => ({ balance: Number.MAX_SAFE_INTEGER }) })
    const a = await new WalletManagerTron(SEED, { provider: node.fetch }).getAccount(0)
    await expect(withNow(() => a.transfer({ recipient: RECIPIENT, amount: 2n ** 53n + 1n }))).rejects.toThrow(/safe integer|too large/i)
    expect(node.paths()).not.toContain('/wallet/createtransaction')
    // within range the node is asked to build exactly that amount (the balance check may refuse later)
    await withNow(() => a.transfer({ recipient: RECIPIENT, amount: 2n ** 53n - 1n })).catch(() => undefined)
    expect(node.calls.find((c) => c.path === '/wallet/createtransaction')!.body).toMatchObject({ amount: Number.MAX_SAFE_INTEGER, to_address: toHexAddress(RECIPIENT) })
  })
})

describe('parseJsonExact', () => {
  it('quotes only unsafe integer literals outside strings', async () => {
    const { parseJsonExact } = await import('../src/json.js')
    const text = '{"a":9007199254740993,"b":-9007199254740993,"c":9007199254740991,"d":"x:12345678901234567890,","e":"q\\"9007199254740993","f":1.12345678901234567890,"g":1e300,"h":[12345678901234567890],"i":12345678901234567890e2,"j":0,"k":-1}'
    expect(parseJsonExact(text)).toEqual({
      a: '9007199254740993', b: '-9007199254740993', c: 9007199254740991, d: 'x:12345678901234567890,', e: 'q"9007199254740993',
      f: 1.1234567890123457, g: 1e300, h: ['12345678901234567890'], i: 1.2345678901234568e21, j: 0, k: -1,
    })
    expect(parseJsonExact('[]')).toEqual([])
    expect(() => parseJsonExact('{"a":')).toThrow()
  })
})
