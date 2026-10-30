// Scan 2026-10-30 F17: the direct CCIP-Read path (ensCcipRequest, default for ensResolver({ rpcUrl }) on Node)
// checked only the URL text (isPublicHttpsUrl): a public-looking host whose DNS answer is loopback / private was
// connected to anyway. Now, on Node without ccip.fetch, gateways go through createEnsCcipHandler's pinned transport
// (every DNS answer checked, the connection pinned to it, no redirects, capped, timed).
// Here the global fetch's DNS is replaced (undici Agent connect.lookup → 127.0.0.1), as is node:dns (vi.mock), and a
// real HTTPS server listens on 127.0.0.1 with a self-signed cert; rejectUnauthorized:false stands in for the
// precondition "the private service presents a certificate trusted for that host name". No public network is used.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { EnsNameError, ensCcipRequest } from '../src/index.js'
import { createEnsCcipHandler } from '../src/server.js'

// node:dns as the pinned transport sees it: `answers` per host (default: loopback, the rebinding stand-in).
const dns = vi.hoisted(() => ({ answers: new Map<string, Array<{ address: string; family: number }>>(), asked: [] as string[] }))
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => { dns.asked.push(host); return dns.answers.get(host) ?? [{ address: '127.0.0.1', family: 4 }] },
}))

const require = createRequire(import.meta.url)
// undici is not a dependency of this package: take the copy the workspace already has (the one Node's fetch is built on).
const pnpmDir = join(__dirname, '../../../node_modules/.pnpm')
const undiciDir = readdirSync(pnpmDir).filter((d) => /^undici@\d/.test(d)).sort().pop()!
interface Undici { Agent: new (o: unknown) => unknown; fetch: (url: string, init: unknown) => Promise<Response> }
const undici = require(join(pnpmDir, undiciDir, 'node_modules/undici')) as Undici

const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as const
const CALLDATA = '0x9061b923' as Hex
let server: Server
let port = 0
const hits: string[] = []

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f17-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=gw.rebind.example', '-days', '1',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
  server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    res.end('{"data":"0xdeadbeef"}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { vi.unstubAllGlobals(); server?.close() })
afterEach(() => { dns.answers.clear(); dns.asked.length = 0 })

describe('F17: direct CCIP path connects to a public-looking host that resolves to loopback', () => {
  it('the private server is not asked', async () => {
    // The runtime's DNS answers 127.0.0.1 for every host (split-horizon / rebinding stand-in).
    const agent = new undici.Agent({
      connect: {
        rejectUnauthorized: false,
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as never,
      },
    })
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => undici.fetch(url, { ...(init as object), dispatcher: agent }))
    const gw = `https://gw.rebind.example:${port}/{sender}/{data}.json`
    const out = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [gw] }).catch((e: unknown) => e)
    // Before: hits = ['GET gw.rebind.example:<port> /0x231b…/0x9061b923.json'] and out = '0xdeadbeef'.
    expect(hits).toEqual([])
    expect(out).toBeInstanceOf(EnsNameError)
    expect(String((out as Error).message)).toMatch(/answer was not used: gateway host resolves to a private address/)
    expect(dns.asked).toEqual(['gw.rebind.example'])
  })

  it('a host whose records mix public and private addresses is refused; the next gateway is still tried', async () => {
    dns.answers.set('mixed.example', [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.7', family: 4 }])
    const out = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://mixed.example/{data}', `https://gw.rebind.example:${port}/{data}`] }).catch((e: unknown) => e)
    expect(dns.asked).toEqual(['mixed.example', 'gw.rebind.example'])
    expect(String((out as Error).message)).toMatch(/private address/)
    expect(hits).toEqual([])
  })

  it('the global fetch is not used for gateways on Node, and the caller can abort', async () => {
    const globalFetch = vi.fn(async () => new Response('{"data":"0xdeadbeef"}', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', globalFetch)
    // TEST-NET-1: public to the check, unroutable, so the pinned connect hangs without leaving this machine.
    dns.answers.set('slow.example', [{ address: '192.0.2.1', family: 4 }])
    const ac = new AbortController()
    const p = ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://slow.example/{data}'], requestOptions: { signal: ac.signal } } as never)
    setTimeout(() => ac.abort(new Error('caller gave up')), 100)
    await expect(p).rejects.toThrow('caller gave up')
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('the pinned transport has the same deadline (timeoutMs)', async () => {
    dns.answers.set('slow.example', [{ address: '192.0.2.1', family: 4 }])
    const out = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://slow.example/{data}'] }, { timeoutMs: 200 }).catch((e: unknown) => e)
    // Two timers of the same length: the lookup's own or the handler's reports it.
    expect(String((out as Error).message)).toMatch(/did not answer within 0\.2 s|not used: gateway (timed out|unavailable)/)
  })

  it('ccip.fetch replaces the pinned transport (proxies, split-horizon DNS the app trusts)', async () => {
    const asked: string[] = []
    const fetch = async (url: string) => { asked.push(url); return new Response('{"data":"0xabcdef"}', { headers: { 'content-type': 'application/json' } }) }
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] }, { fetch })).toBe('0xabcdef')
    expect(asked).toEqual(['https://gw.example/0x9061b923'])
    expect(dns.asked).toEqual([])
  })
})

describe('F17 control: the server handler checks the DNS answer', () => {
  it('refuses the same host when it resolves to 127.0.0.1', async () => {
    const handle = createEnsCcipHandler({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] })
    const before = hits.length
    const r = await handle({ url: `https://gw.rebind.example:${port}/x.json`, method: 'GET' })
    expect(r).toEqual({ status: 403, body: { error: 'gateway host resolves to a private address' } })
    expect(hits.length).toBe(before)
  })
})
