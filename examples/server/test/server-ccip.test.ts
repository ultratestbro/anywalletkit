import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import type { CrossChainProvider } from '@anywalletkit/protocol-swap2-core'
import { ensCcipRequest, ensCcipViaProxy } from '@anywalletkit/names-ens'
import { createServer, type ServerOptions } from '../src/server.ts'
import { namesOverServer } from '../src/client.ts'

// The /ccip route (scan 2026-10-28 F13): an app on React Native asks CCIP-Read gateways through this server,
// which runs createEnsCcipHandler behind the same token check and a per-caller limit as the other routes.
// A local plain-http gateway stands in for the https one (the handler's fetch override maps the host to it),
// and DNS is stubbed.

const TOKEN = 'test-app-token'
const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'
const CALLDATA = '0x9061b923'
const mock: CrossChainProvider = {
  name: 'mock', enabled: () => true, supportsRoute: () => true, getQuote: async () => null,
  buildDeposit: async () => { throw new Error('unused') }, trackIntent: async () => ({ state: 'pending' }),
}

let gateway: Server
let gatewayBase = ''
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }> = []
let server: Server
let base = ''
const dns: Record<string, string> = { 'gw.example': '93.184.215.14', 'rebind.example': '192.168.1.1' }

beforeAll(async () => {
  gateway = createHttpServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    if (req.url === '/moved') { res.writeHead(302, { location: 'http://192.168.1.1/' }); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: '0xabcdef' }))
  })
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r))
  gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
  const opts: ServerOptions = {
    providers: [mock], upstreams: {}, sealSecret: 'test-seal-secret-that-is-at-least-32-bytes-long', apiToken: TOKEN,
    limits: { live: 10, display: 10, status: 10, rpc: 10, ccip: 6 },
    callerKey: (req) => String(req.headers['x-test-user'] ?? 'anon'),
    ccip: {
      lookup: async (host) => (dns[host] ? [{ address: dns[host], family: 4 }] : []),
      fetch: (url, init) => fetch(url.replace(/^https:\/\/[^/]+/, gatewayBase), init),
    },
  }
  server = createServer(opts)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => Promise.all([gateway, server].map((s) => new Promise<void>((r) => s.close(() => r())))))
afterEach(() => vi.unstubAllGlobals())

const post = (body: unknown, user = 'alice', headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(`${base}/ccip`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user, cookie: 'session=secret', ...headers }, body: JSON.stringify(body) })

describe('reference server /ccip', () => {
  it('without the token: 401, and nothing is fetched', async () => {
    seen.length = 0
    expect((await post({ url: 'https://gw.example/x', method: 'GET' }, 'u0', {})).status).toBe(401)
    expect(seen).toEqual([])
  })

  it("asks the gateway with none of the app's headers; refuses private addresses, redirects and other methods", async () => {
    seen.length = 0
    const ok = await post({ url: `https://gw.example/${SENDER}/${CALLDATA}.json`, method: 'GET' }, 'u1')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ data: '0xabcdef' })
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.headers.cookie).toBeUndefined()
    expect(seen[0]!.headers['x-test-user']).toBeUndefined()
    expect((await post({ url: 'https://rebind.example/x', method: 'GET' }, 'u1')).status).toBe(403)
    expect((await post({ url: 'https://192.168.1.1/x', method: 'GET' }, 'u1')).status).toBe(403)
    expect(await (await post({ url: 'https://gw.example/moved', method: 'GET' }, 'u1')).json()).toEqual({ error: 'gateway redirected; redirects are not followed' })
    expect((await post({ url: 'https://gw.example/x', method: 'PUT' }, 'u1')).status).toBe(405)
    expect((await fetch(`${base}/ccip`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'x-test-user': 'u1' }, body: '{' })).status).toBe(400)
  })

  it('rate-limits per caller', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await post({ url: 'https://gw.example/x', method: 'GET' }, 'u2')).status)
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true)
    expect(statuses[6]).toBe(429)
    expect((await post({ url: 'https://gw.example/x', method: 'GET' }, 'u3')).status).toBe(200)
  })

  it('the app side on React Native: ensCcipViaProxy through /ccip, and the resolver it builds', async () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' })
    const viaServer = ensCcipViaProxy(`${base}/ccip`, { headers: { authorization: `Bearer ${TOKEN}` }, allowInsecureProxyUrl: true })
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{sender}/{data}.json'] }, { fetch: viaServer })).toBe('0xabcdef')
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/lookup'] }, { fetch: viaServer })).toBe('0xabcdef')
    expect(namesOverServer(base, TOKEN, 'https://ethereum-rpc.publicnode.com').supports('alice.cb.id')).toBe(true)
  })
})
