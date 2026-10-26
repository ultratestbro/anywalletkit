import { describe, expect, it } from 'vitest'
import { RpcClient, RpcError, big } from '../src/rpc.js'

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
const fail = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }))

describe('RpcClient', () => {
  it('URL providers: fails over on HTTP errors and rate limits, stops on a node-side rejection', async () => {
    const hits: string[] = []
    const fetchImpl = (async (url: string) => {
      hits.push(url)
      if (url === 'https://a') return new Response('busy', { status: 503 })
      if (url === 'https://b') return fail(429, 'Too many requests')
      return ok(42)
    }) as unknown as typeof fetch
    expect(await new RpcClient(['https://a', 'https://b', 'https://c'], { fetch: fetchImpl }).call('getSlot')).toBe(42)
    expect(hits).toEqual(['https://a', 'https://b', 'https://c'])

    const final = (async () => fail(-32602, 'Invalid params')) as unknown as typeof fetch
    await expect(new RpcClient(['https://x', 'https://y'], { fetch: final }).call('getSlot')).rejects.toBeInstanceOf(RpcError)
  })

  it('times out a hung provider and moves on', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === 'https://hung') return await new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      return ok('fine')
    }) as unknown as typeof fetch
    const t0 = Date.now()
    expect(await new RpcClient(['https://hung', 'https://ok'], { fetch: fetchImpl, timeoutMs: 50 }).call('getSlot')).toBe('fine')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('a @solana/rpc client is called by method even though every property of its Proxy is a function', async () => {
    const calls: string[] = []
    const kit = new Proxy({}, {
      get: (_t, method: string) => (...params: unknown[]) => ({ send: async () => { calls.push(method); return { method, params } } }),
    })
    expect(await new RpcClient([kit]).call('getEpochInfo', [{ commitment: 'confirmed' }])).toEqual({ method: 'getEpochInfo', params: [{ commitment: 'confirmed' }] })
    expect(calls).toEqual(['getEpochInfo'])
  })

  it('kit clients and { request } providers fail over on transport errors; malformed requests are final', async () => {
    const kitDown = new Proxy({}, { get: () => () => ({ send: async () => { throw Object.assign(new Error('HTTP error (503)'), { context: { __code: 8100002 } }) } }) })
    const fetchFailed = { request: async () => { throw new TypeError('fetch failed') } }
    const backup = { request: async () => 'backup' }
    expect(await new RpcClient([kitDown, backup]).call('getSlot')).toBe('backup')
    expect(await new RpcClient([fetchFailed, backup]).call('getSlot')).toBe('backup')
    const methodMissing = { request: async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }) } }
    expect(await new RpcClient([methodMissing, backup]).call('getProgramAccounts')).toBe('backup')
    const badParams = { request: async () => { throw Object.assign(new Error('Invalid params'), { code: -32602 }) } }
    await expect(new RpcClient([badParams, backup]).call('getSlot')).rejects.toBeInstanceOf(RpcError)
  })

  it('{ request } providers', async () => {
    const p = { request: async (m: string, params: unknown[]) => ({ m, params }) }
    expect(await new RpcClient([p]).call('getBalance', ['x'])).toEqual({ m: 'getBalance', params: ['x'] })
  })

  it('no provider: a clear error', async () => {
    await expect(new RpcClient([]).call('getSlot')).rejects.toThrow(/needs a Solana RPC/)
  })

  it('big() reads numbers, bigints and decimal strings, and refuses the rest', () => {
    expect(big(5)).toBe(5n)
    expect(big(5n)).toBe(5n)
    expect(big('18446744073709551615')).toBe(18446744073709551615n)
    expect(() => big(1.5)).toThrow()
    expect(() => big(null)).toThrow()
  })
})
