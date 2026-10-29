// Scan 2026-10-28 F13, the safe path: on React Native a gateway's redirect cannot be refused on the device, so
// the app sends each CCIP-Read gateway call to its own server (ensCcipViaProxy), and the server asks the gateway
// (createEnsCcipHandler): https only, public addresses only (DNS answers included, the connection pinned to the
// checked one), no redirects, a timeout and an answer cap, GET/POST as EIP-3668 defines them, no caller headers.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { encodeErrorResult, encodeFunctionData, parseAbi, type Hex } from 'viem'
import { mainnet } from 'viem/chains'
import { EnsNameError, ensCcipRequest, ensCcipViaProxy, ensResolver } from '../src/index.js'
import { createEnsCcipHandler, type EnsCcipHandlerOptions } from '../src/server.js'

afterEach(() => vi.unstubAllGlobals())

const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63'
const CALLDATA = '0x9061b923' as Hex
const PUBLIC = [{ address: '93.184.215.14', family: 4 }]
const asReactNative = () => vi.stubGlobal('navigator', { product: 'ReactNative' })
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })

/** A handler whose gateway is a recorded fetch double and whose DNS answers PUBLIC. */
function handlerWith(gateway: (url: string, init: RequestInit) => Promise<Response>, opts: EnsCcipHandlerOptions = {}) {
  const asked: Array<{ url: string; init: RequestInit }> = []
  const handle = createEnsCcipHandler({
    lookup: async () => PUBLIC,
    ...opts,
    fetch: async (url, init) => { asked.push({ url, init }); return gateway(url, init) },
  })
  return { handle, asked }
}
const ok = () => json({ data: '0xabcdef' })

describe('createEnsCcipHandler refuses', () => {
  it.each([
    ['http', 'http://gw.example/x'],
    ['loopback literal', 'https://127.0.0.1/x'],
    ['LAN literal', 'https://192.168.1.1/x'],
    ['IPv4 spelling', 'https://0x7f.1/x'],
    ['link-local metadata', 'https://169.254.169.254/latest'],
    ['CGNAT', 'https://100.64.0.1/x'],
    ['mapped IPv6', 'https://[::ffff:10.0.0.1]/x'],
    ['6to4', 'https://[2002:c0a8:101::]/x'],
    ['localhost', 'https://localhost/x'],
    ['credentials', 'https://user:pw@gw.example/x'],
    ['backslash host', 'https://gw.example\\@127.0.0.1/x'],
    ['a host the connecting parser reads differently', 'https://134744072/x'],
  ])('%s', async (_why, url) => {
    const { handle, asked } = handlerWith(async () => ok())
    const out = await handle({ url, method: 'GET' })
    expect(out.status).toBe(403)
    expect(asked).toEqual([])
  })

  it.each([
    ['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['LAN', [{ address: '10.1.2.3', family: 4 }]],
    ['link-local', [{ address: '169.254.169.254', family: 4 }]],
    ['CGNAT', [{ address: '100.100.0.1', family: 4 }]],
    ['IPv6 loopback', [{ address: '::1', family: 6 }]],
    ['unique-local IPv6', [{ address: 'fd00::1', family: 6 }]],
    ['mapped IPv6', [{ address: '::ffff:192.168.0.1', family: 6 }]],
    ['6to4 of a LAN address', [{ address: '2002:c0a8:0101::1', family: 6 }]],
    ['NAT64 of loopback', [{ address: '64:ff9b::7f00:1', family: 6 }]],
    ['one private among public ones', [...PUBLIC, { address: '192.168.1.1', family: 4 }]],
  ])('a public name that resolves to a %s address (stubbed DNS)', async (_why, addresses) => {
    const { handle, asked } = handlerWith(async () => ok(), { lookup: async () => addresses })
    const out = await handle({ url: 'https://rebind.example/{x}', method: 'GET' })
    expect(out).toEqual({ status: 403, body: { error: 'gateway host resolves to a private address' } })
    expect(asked).toEqual([])
  })

  it('a host that does not resolve', async () => {
    const { handle } = handlerWith(async () => ok(), { lookup: async () => { throw new Error('ENOTFOUND gw.example') } })
    expect(await handle({ url: 'https://gw.example/x', method: 'GET' })).toEqual({ status: 502, body: { error: 'gateway host does not resolve' } })
  })

  it.each([301, 302, 303, 307, 308])('a %i redirect: never followed, the answer not used', async (status) => {
    const { handle, asked } = handlerWith(async () => new Response('{"data":"0x01"}', { status, headers: { location: 'http://192.168.1.1/apply.cgi', 'content-type': 'application/json' } }))
    const out = await handle({ url: 'https://gw.example/x', method: 'GET' })
    expect(out).toEqual({ status: 502, body: { error: 'gateway redirected; redirects are not followed' } })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.init.redirect).toBe('manual')
  })

  it('an answer over maxResponseBytes, declared or streamed', async () => {
    const big = `{"data":"0x${'ab'.repeat(600)}"}`
    const declared = handlerWith(async () => new Response(big, { headers: { 'content-type': 'application/json', 'content-length': String(big.length) } }), { maxResponseBytes: 1000 })
    expect(await declared.handle({ url: 'https://gw.example/x', method: 'GET' })).toEqual({ status: 502, body: { error: 'gateway answer too large' } })
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode(big.slice(i * 400, (i + 1) * 400))); c.close() } })
    const streamed = handlerWith(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }), { maxResponseBytes: 1000 })
    expect(await streamed.handle({ url: 'https://gw.example/x', method: 'GET' })).toEqual({ status: 502, body: { error: 'gateway answer too large' } })
  })

  it('a gateway that does not answer in time (and the request is aborted)', async () => {
    let aborted = false
    const { handle } = handlerWith((_u, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })), { timeoutMs: 50 })
    const t0 = Date.now()
    expect(await handle({ url: 'https://gw.example/x', method: 'GET' })).toEqual({ status: 504, body: { error: 'gateway timed out' } })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(aborted).toBe(true)
  })

  it('DNS that does not answer in time', async () => {
    const { handle, asked } = handlerWith(async () => ok(), { timeoutMs: 50, lookup: () => new Promise(() => undefined) })
    expect((await handle({ url: 'https://gw.example/x', method: 'GET' })).status).toBe(504)
    expect(asked).toEqual([])
  })

  it.each([
    [405, { url: 'https://gw.example/x', method: 'PUT' }],
    [405, { url: 'https://gw.example/x', method: 'DELETE' }],
    [405, { url: 'https://gw.example/x', method: 'get' }],
    [400, { url: 'https://gw.example/x', method: 'GET', body: { sender: SENDER, data: CALLDATA } }],
    [400, { url: 'https://gw.example/x', method: 'POST' }],
    [400, { url: 'https://gw.example/x', method: 'POST', body: { sender: SENDER, data: CALLDATA, extra: 1 } }],
    [400, { url: 'https://gw.example/x', method: 'POST', body: { sender: 'alice', data: CALLDATA } }],
    [400, { url: 'https://gw.example/x', method: 'POST', body: { sender: SENDER, data: 'not hex' } }],
    [400, { url: 'https://gw.example/x', method: 'POST', body: { sender: SENDER, data: '0xabc' } }],
    [400, { url: 'https://gw.example/x', method: 'GET', headers: { cookie: 'a=b' } }],
    [400, { url: 42, method: 'GET' }],
    [400, null],
    [400, [{ url: 'https://gw.example/x', method: 'GET' }]],
  ])('%i for %j', async (status, body) => {
    const { handle, asked } = handlerWith(async () => ok())
    expect((await handle(body)).status).toBe(status)
    expect(asked).toEqual([])
  })

  it('a URL or data over maxRequestBytes', async () => {
    const { handle } = handlerWith(async () => ok(), { maxRequestBytes: 100 })
    expect((await handle({ url: `https://gw.example/${'a'.repeat(200)}`, method: 'GET' })).status).toBe(400)
    expect((await handle({ url: 'https://gw.example/x', method: 'POST', body: { sender: SENDER, data: `0x${'ab'.repeat(100)}` } })).status).toBe(400)
  })

  it('hosts outside allowHosts, or in denyHosts', async () => {
    const { handle } = handlerWith(async () => ok(), { allowHosts: ['cb.id', 'offchain.example'], denyHosts: ['bad.offchain.example'] })
    expect((await handle({ url: 'https://gw.example/x', method: 'GET' })).status).toBe(403)
    expect((await handle({ url: 'https://bad.offchain.example/x', method: 'GET' })).status).toBe(403)
    expect((await handle({ url: 'https://evilcb.id/x', method: 'GET' })).status).toBe(403)
    expect((await handle({ url: 'https://api.cb.id/x', method: 'GET' })).status).toBe(200)
    expect((await handle({ url: 'https://offchain.example/x', method: 'GET' })).status).toBe(200)
  })

  it('a gateway error status or non-hex answer; network errors without their detail', async () => {
    expect(await handlerWith(async () => json({ message: 'nope' }, { status: 404 })).handle({ url: 'https://gw.example/x', method: 'GET' })).toEqual({ status: 502, body: { error: 'gateway answered HTTP 404' } })
    expect((await handlerWith(async () => json({ data: 'hello' })).handle({ url: 'https://gw.example/x', method: 'GET' })).status).toBe(502)
    expect(await handlerWith(async () => { throw new Error('connect ECONNREFUSED 93.184.215.14:443') }).handle({ url: 'https://gw.example/x', method: 'GET' })).toEqual({ status: 502, body: { error: 'gateway unavailable' } })
  })
})

describe('createEnsCcipHandler without a fetch override (node:https, pinned)', () => {
  it('resolves the host once and connects to that address: a second DNS answer is never asked for', async () => {
    let lookups = 0
    // TEST-NET-1: public to the check, unroutable, so the connection attempt times out without leaving this machine.
    const handle = createEnsCcipHandler({ timeoutMs: 300, lookup: async () => (++lookups === 1 ? [{ address: '192.0.2.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]) })
    const out = await handle({ url: 'https://rebind.example/x', method: 'GET' })
    expect([502, 504]).toContain(out.status)
    expect(lookups).toBe(1)
  })

  it('a host resolving to loopback is refused before any connection', async () => {
    const handle = createEnsCcipHandler({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
    expect((await handle({ url: 'https://localhost.example/x', method: 'GET' })).status).toBe(403)
  })
})

// A local plain-http gateway stands in for the https one: the fetch override maps https://gw.example → it.
let gateway: Server
let gatewayBase = ''
const seenByGateway: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = []
beforeAll(async () => {
  gateway = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      seenByGateway.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.method === 'POST' ? '0xbeef' : '0xabcdef' }))
    })
  })
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r))
  gatewayBase = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => gateway.close(() => r())))
const toLocalGateway = (url: string, init: RequestInit) => fetch(url.replace('https://gw.example', gatewayBase), init)

describe('createEnsCcipHandler happy path (local stub gateway, fetch override)', () => {
  it('GET and POST as EIP-3668 defines them; only hex data comes back; no caller header reaches the gateway', async () => {
    seenByGateway.length = 0
    const handle = createEnsCcipHandler({ lookup: async () => PUBLIC, fetch: toLocalGateway })
    expect(await handle({ url: `https://gw.example/${SENDER.toLowerCase()}/${CALLDATA}.json`, method: 'GET' })).toEqual({ status: 200, body: { data: '0xabcdef' } })
    expect(await handle({ url: 'https://gw.example/lookup', method: 'POST', body: { sender: SENDER, data: CALLDATA } })).toEqual({ status: 200, body: { data: '0xbeef' } })
    expect(seenByGateway.map((s) => `${s.method} ${s.url}`)).toEqual([`GET /${SENDER.toLowerCase()}/${CALLDATA}.json`, 'POST /lookup'])
    expect(JSON.parse(seenByGateway[1]!.body)).toEqual({ data: CALLDATA, sender: SENDER })
    for (const s of seenByGateway) {
      expect(s.headers.cookie).toBeUndefined()
      expect(s.headers.authorization).toBeUndefined()
    }
  })
})

describe('ensCcipViaProxy → createEnsCcipHandler end to end (local server)', () => {
  let proxy: Server
  let proxyBase = ''
  const seenByProxy: Array<string | undefined> = []
  beforeAll(async () => {
    const handle = createEnsCcipHandler({ lookup: async () => PUBLIC, fetch: toLocalGateway })
    proxy = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
      req.on('end', async () => {
        seenByProxy.push(req.headers.authorization)
        let body: unknown = null
        try { body = JSON.parse(raw) } catch { /* the handler answers 400 */ }
        const out = await handle(body)
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out.body))
      })
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => proxy.close(() => r())))

  it('on React Native, offchain lookups go device → your server → gateway, GET and POST', async () => {
    asReactNative()
    seenByGateway.length = 0
    const fetchViaProxy = ensCcipViaProxy(`${proxyBase}/ccip`, { headers: { authorization: 'Bearer app-token' }, allowInsecureProxyUrl: true })
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{sender}/{data}.json'] }, { fetch: fetchViaProxy })).toBe('0xabcdef')
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/lookup'] }, { fetch: fetchViaProxy })).toBe('0xbeef')
    expect(seenByProxy.slice(-2)).toEqual(['Bearer app-token', 'Bearer app-token'])
    expect(seenByGateway.every((s) => s.headers.authorization === undefined)).toBe(true)
  })

  it("the server's refusal comes back as the lookup's error; the next gateway is still tried", async () => {
    // A public-looking name the server finds resolving to loopback: the device check passes it, the server refuses.
    const refusing = createEnsCcipHandler({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], fetch: toLocalGateway })
    const viaRefusing = ensCcipViaProxy('https://api.example/ccip', { fetch: async (_u, init) => { const out = await refusing(JSON.parse(String(init.body))); return json(out.body, { status: out.status }) } })
    const err = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] }, { fetch: viaRefusing }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnsNameError)
    expect((err as Error).message).toMatch(/proxy got no answer from the gateway: gateway host resolves to a private address/)
    // A gateway the device refuses is skipped before the proxy; the next one goes through.
    const fetchViaProxy = ensCcipViaProxy(`${proxyBase}/ccip`, { allowInsecureProxyUrl: true })
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://192.168.1.1/{data}', 'https://gw.example/{data}'] }, { fetch: fetchViaProxy })).toBe('0xabcdef')
  })

  it('times out without AbortSignal.timeout, and honours the caller signal', async () => {
    const hang = ensCcipViaProxy('https://api.example/ccip', { timeoutMs: 50, fetch: (_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))) })
    await expect(hang('https://gw.example/x', { method: 'GET' })).rejects.toThrow(/did not answer within 50 ms/)
    const ctrl = new AbortController()
    const p = ensCcipViaProxy('https://api.example/ccip', { fetch: (_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')))) })('https://gw.example/x', { method: 'GET', signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toThrow(/aborted by caller/)
  })

  it('the proxy URL must be https (http only on this machine, opted in)', () => {
    expect(() => ensCcipViaProxy('http://api.example/ccip')).toThrow(/https proxy URL/)
    expect(() => ensCcipViaProxy('http://127.0.0.1:8787/ccip')).toThrow(/https proxy URL/)
    expect(() => ensCcipViaProxy('https://user:pw@api.example/ccip')).toThrow(/https proxy URL/)
    expect(() => ensCcipViaProxy('http://127.0.0.1:8787/ccip', { allowInsecureProxyUrl: true })).not.toThrow()
    expect(() => ensCcipViaProxy('https://api.example/ccip')).not.toThrow()
  })
})

describe('the React Native default says what to set', () => {
  const expectHelpful = (err: unknown) => {
    expect(err).toBeInstanceOf(EnsNameError)
    const e = err as EnsNameError
    expect(e.code).toBe('lookup-failed')
    expect(e.reason).toBe('ccip-proxy-required')
    expect(e.message).toMatch(/off on React Native/)
    expect(e.message).toMatch(/ccip: \{ fetch: ensCcipViaProxy\(/)
    expect(e.message).toMatch(/createEnsCcipHandler\(\) from '@anywalletkit\/names-ens\/server'/)
    expect(e.message).toMatch(/allowRedirectFollowingFetch: true/)
  }

  it('ensCcipRequest', async () => {
    asReactNative()
    expectHelpful(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] }).catch((e: unknown) => e))
  })

  // The resolver over a stubbed mainnet RPC whose universal resolver answers with OffchainLookup: the refusal
  // must reach the app as itself, not as viem's wrapped error or (batch gateway) a revert string.
  const UR = mainnet.contracts.ensUniversalResolver.address
  const offchainLookup = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)'])
  const batchQuery = parseAbi(['function query((address sender, string[] urls, bytes data)[]) returns (bool[] failures, bytes[] responses)'])
  function rpcAnswering(urls: string[], callData: Hex) {
    const revert = encodeErrorResult({ abi: offchainLookup, errorName: 'OffchainLookup', args: [UR, urls, callData, '0x12345678', '0x'] })
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { id: number; method: string }
      if (req.method === 'eth_chainId') return json({ jsonrpc: '2.0', id: req.id, result: '0x1' })
      // The first call asks for the offchain lookup; the callback (with the batch gateway's encoded failure) reverts.
      return json({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data: ++calls === 1 ? revert : '0x' } })
    }))
  }

  it.each([
    ['a gateway URL', () => rpcAnswering(['https://gw.example/{data}'], CALLDATA)],
    ['the batch gateway', () => rpcAnswering(['x-batch-gateway:true'], encodeFunctionData({ abi: batchQuery, functionName: 'query', args: [[{ sender: UR, urls: ['https://gw.example/{data}'], data: CALLDATA }]] }))],
  ])('ensResolver().resolve through %s', async (_via, stub) => {
    asReactNative()
    stub()
    const err = await ensResolver({ rpcUrl: 'https://rpc.example' }).resolve('alice.cb.id', 'eip155:1').catch((e: unknown) => e)
    expectHelpful(err)
    expect((err as EnsNameError).detail).toMatchObject({ name: 'alice.cb.id', chain: 'eip155:1' })
  })
})
