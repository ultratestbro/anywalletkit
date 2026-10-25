import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRpcProxy } from '../src/rpc.ts'
import { createRateLimiter, createServer } from '../src/server.ts'

// Audit 2026-10-25, finding 13: the reference RPC proxy passed any eth_getLogs range, state
// overrides and responses of any size, charged an eth_getLogs like an eth_chainId, and its rate
// limiter kept every caller it ever saw.

const URL_KEY = 'https://eth.example/key/SECRET'
let calls = 0
let responseBytes = 100
const upstream = (async (_url: string, init: RequestInit) => {
  calls++
  const req = JSON.parse(String(init.body)) as { id: number }
  const pad = 'a'.repeat(Math.max(0, responseBytes - 60))
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: pad }), { headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

const proxy = createRpcProxy({ upstreams: { 'eip155:1': [URL_KEY] }, fetchImpl: upstream, maxLogsRange: 5_000, maxResponseBytes: 64 * 1024 })
const rpc = (method: string, params: unknown[]) => proxy('eip155:1', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
const status = async (method: string, params: unknown[]) => (await rpc(method, params)).status

describe('RPC proxy budgets', () => {
  it('eth_getLogs: block ranges are bounded', async () => {
    expect(await status('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1312d00' }])).toBe(403) // 20M blocks
    expect(await status('eth_getLogs', [{ fromBlock: 'earliest', toBlock: 'latest' }])).toBe(403)
    expect(await status('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }])).toBe(403)
    expect(await status('eth_getLogs', [{ toBlock: '0x10' }])).toBe(403)
    expect(await status('eth_getLogs', [{ fromBlock: '0x2000', toBlock: '0x1000' }])).toBe(403)
    expect(await status('eth_getLogs', [{ fromBlock: '0x1000', toBlock: '0x2000', address: '0x1' }])).toBe(200) // 4096 blocks
    expect(await status('eth_getLogs', [{ blockHash: `0x${'ab'.repeat(32)}` }])).toBe(200)
    expect(await status('eth_getLogs', [{ fromBlock: 'latest', toBlock: 'latest' }])).toBe(200)
    expect(await status('eth_getLogs', [{}])).toBe(200) // latest..latest
  })

  it('state and block overrides are refused', async () => {
    const tx = { to: '0x1', data: '0x' }
    expect(await status('eth_call', [tx, 'latest', { '0x1': { code: '0x60' } }])).toBe(403)
    expect(await status('eth_call', [tx, 'latest', null, { number: '0x1' }])).toBe(403)
    expect(await status('eth_estimateGas', [tx, 'latest', { '0x1': { balance: '0xffff' } }])).toBe(403)
    expect(await status('eth_createAccessList', [tx, 'latest', { '0x1': { balance: '0xffff' } }])).toBe(403)
    expect(await status('eth_simulateV1', [{ blockStateCalls: [{ stateOverrides: { '0x1': { balance: '0x1' } }, calls: [tx] }] }, 'latest'])).toBe(403)
    expect(await status('eth_simulateV1', [{ blockStateCalls: [{ blockOverrides: { time: '0x1' }, calls: [tx] }] }, 'latest'])).toBe(403)
    expect(await status('eth_call', [tx, 'latest'])).toBe(200)
    expect(await status('eth_simulateV1', [{ blockStateCalls: [{ calls: [tx] }] }, 'latest'])).toBe(200)
  })

  it('a batch with one refused call is refused whole, before any upstream call', async () => {
    const before = calls
    const out = await proxy('eip155:1', JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] },
    ]))
    expect(out.status).toBe(403)
    expect(calls).toBe(before)
  })

  it('an upstream answer above the size cap is not relayed, and the error names no URL', async () => {
    responseBytes = 200 * 1024
    const out = await rpc('eth_chainId', [])
    responseBytes = 100
    expect(out.status).toBe(502)
    expect(out.body).not.toContain('SECRET')
    expect(out.body.length).toBeLessThan(500)
  })

  it('charge() sees the methods before the upstream is called and can refuse', async () => {
    const seen: string[][] = []
    const before = calls
    const out = await proxy('eip155:1', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{}] }), {
      charge: (methods) => { seen.push([...methods]); throw Object.assign(new Error('slow down'), { status: 429 }) },
    }).catch((e: unknown) => e)
    expect(seen).toEqual([['eth_getLogs']])
    expect(out).toMatchObject({ status: 429 })
    expect(calls).toBe(before)
  })
})

describe('rate limiter', () => {
  it('forgets callers whose window ended', () => {
    let t = 0
    const limiter = createRateLimiter({ windowMs: 60_000, now: () => t })
    for (let i = 0; i < 1_000; i++) limiter.take(`caller-${i}`, 10)
    expect(limiter.size).toBe(1_000)
    t = 61_000
    limiter.take('one-more', 10)
    expect(limiter.size).toBe(1)
  })

  it('refuses above the limit within a window and lets the next window through', () => {
    let t = 0
    const limiter = createRateLimiter({ windowMs: 60_000, now: () => t })
    limiter.take('a', 2)
    limiter.take('a', 2)
    expect(() => limiter.take('a', 2)).toThrow(/too many/)
    t = 60_001
    expect(() => limiter.take('a', 2)).not.toThrow()
  })
})

describe('server: expensive RPC methods have their own budget', () => {
  let server: Server
  let base = ''
  beforeAll(async () => {
    server = createServer({
      providers: [], upstreams: { 'eip155:1': [URL_KEY] }, sealSecret: 'test-seal-secret-that-is-at-least-32-bytes-long', apiToken: 't',
      limits: { live: 10, display: 10, status: 10, rpc: 100, rpcHeavy: 2 }, fetchImpl: upstream,
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('eth_getLogs runs out before eth_chainId does', async () => {
    const post = (method: string, params: unknown[]) => fetch(`${base}/rpc/eip155:1`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    expect((await post('eth_getLogs', [{}])).status).toBe(200)
    expect((await post('eth_getLogs', [{}])).status).toBe(200)
    expect((await post('eth_getLogs', [{}])).status).toBe(429)
    expect((await post('eth_chainId', [])).status).toBe(200)
  })
})
