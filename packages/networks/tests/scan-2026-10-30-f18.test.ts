// Scan 2026-10-30 F18: verifyNetwork checked only the first URL (checkRpcUrl) and then called the global fetch
// without `redirect`, so a public https endpoint could 307/302 the verifier to a plain-http / private target that
// parseAddChainParams would have refused (e.g. a site's wallet_addEthereumChain rpcUrls). On top of the blind
// request, the target's answer leaked back in `result.error` (`HTTP 500: <120 chars>` / `Not JSON: <80 chars>`).
// Now: `redirect: 'error'`, a reported redirect (3xx, `redirected`, a different `url`) is `redirected`, and
// error texts carry no body.
// Network: undici Agent with connect.lookup → 127.0.0.1 stands in for public DNS; an https server (self-signed,
// rejectUnauthorized:false) plays the attacker's public endpoint; a plain-http server on 127.0.0.1 plays the
// internal service. The fake-fetch cases below cover transports that follow redirects anyway.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer as createHttps, type Server as HttpsServer } from 'node:https'
import { createServer as createHttp, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseAddChainParams, verifyNetwork, isAddChainError, type FetchLike } from '../src/index.js'

const require = createRequire(import.meta.url)
// undici is not a dependency of this package: take the copy the workspace already has (the one Node's fetch is built on).
const pnpmDir = join(__dirname, '../../../node_modules/.pnpm')
const undiciDir = readdirSync(pnpmDir).filter((d) => /^undici@\d/.test(d)).sort().pop()!
interface Undici { Agent: new (o: unknown) => unknown; fetch: (url: string, init: unknown) => Promise<unknown> }
const undici = require(join(pnpmDir, undiciDir, 'node_modules/undici')) as Undici

let attacker: HttpsServer
let internal: HttpServer
let aPort = 0
let iPort = 0
const internalHits: string[] = []
let redirectStatus = 307

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f18-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=rpc.attacker.example', '-days', '1',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
  internal = createHttp((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      internalHits.push(`${req.method} ${req.url} ${body}`)
      res.statusCode = 500
      res.end('INTERNAL-SECRET: admin panel v1.2, token=abc123')
    })
  })
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r))
  iPort = (internal.address() as AddressInfo).port
  attacker = createHttps({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
    req.resume()
    res.statusCode = redirectStatus
    res.setHeader('location', `http://127.0.0.1:${iPort}/admin/reboot`)
    res.end()
  })
  await new Promise<void>((r) => attacker.listen(0, '127.0.0.1', r))
  aPort = (attacker.address() as AddressInfo).port
  const agent = new undici.Agent({
    connect: {
      rejectUnauthorized: false,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as never,
    },
  })
  // The verifier's default: globalThis.fetch (opts.fetch not passed).
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => undici.fetch(url, { ...(init as object), dispatcher: agent }))
})
afterAll(() => { vi.unstubAllGlobals(); attacker?.close(); internal?.close() })

const chain = () => ({ chainId: '0x1e240', chainName: 'Evil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: [`https://rpc.attacker.example:${aPort}/`] })

describe('F18: verifyNetwork does not follow a redirect outside the URL policy', () => {
  it('the direct private target is refused by parseAddChainParams (baseline)', () => {
    const p = parseAddChainParams({ ...chain(), rpcUrls: [`http://127.0.0.1:${iPort}/admin/reboot`] }, { origin: 'https://evil.example', known: () => true })
    expect(isAddChainError(p)).toBe(true)
  })

  it.each([307, 302])('a %i from the site-supplied https RPC does not reach the internal http service', async (status) => {
    redirectStatus = status
    internalHits.length = 0
    const parsed = parseAddChainParams(chain(), { origin: 'https://evil.example', known: () => true })
    expect(isAddChainError(parsed)).toBe(false) // public https: accepted
    const r = await verifyNetwork(parsed as Exclude<typeof parsed, { code: number }>)
    // Before: internalHits = ['POST /admin/reboot {"jsonrpc":"2.0",…eth_chainId…}'] (307) or ['GET /admin/reboot '] (302)
    // and r.error = 'http-500: HTTP 500: INTERNAL-SECRET: admin panel v1.2, token=abc123'.
    expect(r.ok).toBe(false)
    expect(r.error).toBe('redirected: Endpoint redirected; enter the final URL')
    expect(internalHits).toEqual([])
  })
})

// Transports that follow redirects whatever `redirect` says (or that pass `manual` through) still report it.
const body = (chainIdHex: string, method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? chainIdHex : '0x10' })
const node = (extra: (url: string) => Record<string, unknown>, seen: Array<{ url: string; redirect?: string }> = []): FetchLike => async (url, init) => {
  seen.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) })
  const { method } = JSON.parse(init!.body!) as { method: string }
  return { ok: true, status: 200, text: async () => body('0x1', method), ...extra(url) } as never
}
const mainnet = (rpc: string) => ({ caip2: 'eip155:1', family: 'evm' as const, rpcs: [rpc] })

describe('F18: a redirect any transport reports is refused, honest endpoints still verify', () => {
  it('asks the transport for redirect: error and verifies an honest endpoint (url echoed, case and slash normalised)', async () => {
    const seen: Array<{ url: string; redirect?: string }> = []
    const r = await verifyNetwork(mainnet('https://RPC.Example.org:443'), { fetch: node(() => ({ url: 'https://rpc.example.org/' }), seen) })
    expect(r).toMatchObject({ ok: true, reported: '1', tip: 16 })
    expect(seen.every((s) => s.redirect === 'error')).toBe(true)
  })

  it('verifies an honest endpoint whose transport reports no url (test doubles, older polyfills)', async () => {
    expect((await verifyNetwork(mainnet('https://rpc.example.org/v2/key'), { fetch: node(() => ({})) })).ok).toBe(true)
    expect((await verifyNetwork(mainnet('https://rpc.example.org/v2/key?x=1'), { fetch: node((u) => ({ url: u, redirected: false })) })).ok).toBe(true)
  })

  it('refuses an answer from a different url, naming the host', async () => {
    const r = await verifyNetwork(mainnet('https://rpc.example.org/'), { fetch: node(() => ({ url: 'http://10.0.0.5:8545/admin' })) })
    expect(r).toMatchObject({ ok: false, error: 'redirected: Endpoint redirected to 10.0.0.5:8545; enter the final URL' })
    const path = await verifyNetwork(mainnet('https://rpc.example.org/a'), { fetch: node(() => ({ url: 'https://rpc.example.org/b' })) })
    expect(path.error).toMatch(/^redirected: Endpoint redirected to rpc\.example\.org;/)
  })

  it('refuses redirected: true and a 3xx / opaqueredirect answer', async () => {
    expect((await verifyNetwork(mainnet('https://rpc.example.org'), { fetch: node(() => ({ redirected: true })) })).error).toMatch(/^redirected:/)
    const manual: FetchLike = async () => ({ ok: false, status: 302, text: async () => '', headers: { get: (n: string) => (n === 'location' ? 'http://127.0.0.1:9/x' : null) } })
    expect((await verifyNetwork(mainnet('https://rpc.example.org'), { fetch: manual })).error).toBe('redirected: Endpoint redirected to 127.0.0.1:9; enter the final URL')
    const opaque: FetchLike = async () => ({ ok: false, status: 0, type: 'opaqueredirect', text: async () => '' })
    expect((await verifyNetwork(mainnet('https://rpc.example.org'), { fetch: opaque })).error).toBe('redirected: Endpoint redirected; enter the final URL')
  })

  it('carries no body text in http-<status> and bad-json errors, and does not read an error body', async () => {
    let read = false
    let cancelled = false
    const err: FetchLike = async () => ({ ok: false, status: 500, text: async () => { read = true; return 'INTERNAL-SECRET token=abc' }, body: { cancel: () => { cancelled = true; return Promise.reject(new Error('x')) } } })
    expect((await verifyNetwork(mainnet('https://rpc.example.org'), { fetch: err })).error).toBe('http-500: HTTP 500')
    expect(read).toBe(false)
    expect(cancelled).toBe(true)
    const html: FetchLike = async () => ({ ok: true, status: 200, text: async () => '<html>INTERNAL-SECRET</html>' })
    expect((await verifyNetwork(mainnet('https://rpc.example.org'), { fetch: html })).error).toBe('bad-json: Not JSON.')
  })

  it('still reports chain-id-mismatch for an endpoint on another chain', async () => {
    const r = await verifyNetwork({ caip2: 'eip155:8453', family: 'evm', rpcs: ['https://rpc.example.org'] }, { fetch: node((u) => ({ url: u })) })
    expect(r).toMatchObject({ ok: false, reported: '1' })
    expect(r.error).toMatch(/^chain-id-mismatch/)
  })
})
