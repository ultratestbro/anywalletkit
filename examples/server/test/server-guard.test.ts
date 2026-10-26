import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { CrossChainProvider } from '@anywalletkit/protocol-swap2-core'
import { createServer, type ServerOptions } from '../src/server.ts'

// Audit 2026-10-25 round 3, L20: the reference server (a) took `apiToken: ''` and then let every
// request without an Authorization header through (an empty token equals an empty header); (b) read
// and parsed a swap body of up to 3 MB before checking the token; (c) rate-limited by the socket's
// address, which behind a proxy is the proxy's for everyone.

const mock: CrossChainProvider = {
  name: 'mock', enabled: () => true, supportsRoute: () => true, getQuote: async () => null,
  buildDeposit: async () => { throw new Error('unused') }, trackIntent: async () => ({ state: 'pending' }),
}
const base: ServerOptions = { providers: [mock], upstreams: {}, sealSecret: 'test-seal-secret-that-is-at-least-32-bytes-long', apiToken: 'test-app-token', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch }

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))
async function start(opts: ServerOptions): Promise<string> {
  server = createServer(opts)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('reference server guard', () => {
  it('an empty (or blank) apiToken is a configuration error, not "no auth"', () => {
    expect(() => createServer({ ...base, apiToken: '' })).toThrow(/apiToken/)
    expect(() => createServer({ ...base, apiToken: '   ' })).toThrow(/apiToken/)
  })

  it('a swap request without the token is refused before its body is read', async () => {
    const url = await start(base)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent >= 2_000_000) { c.close(); return } sent += 100_000; c.enqueue(new Uint8Array(100_000).fill(0x20)) },
    })
    const res = await fetch(`${url}/swap2/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit)
    expect(res.status).toBe(401)
    expect(sent).toBeLessThan(2_000_000) // answered before the 2 MB body was consumed
  })

  it('behind a proxy, callerKey decides who is rate-limited (not the proxy address)', async () => {
    const url = await start({ ...base, limits: { live: 1, display: 1, status: 1, rpc: 1 }, upstreams: { 'eip155:1': ['https://eth.example'] }, callerKey: (req) => String(req.headers['x-test-user'] ?? 'anon') })
    const call = (user: string) => fetch(`${url}/rpc/eip155:1`, { method: 'POST', headers: { authorization: 'Bearer test-app-token', 'content-type': 'application/json', 'x-test-user': user }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })
    expect((await call('alice')).status).toBe(200)
    expect((await call('alice')).status).toBe(429)
    expect((await call('bob')).status).toBe(200) // another user behind the same proxy address
  })
})
