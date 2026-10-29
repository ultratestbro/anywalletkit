import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isPrivateHost, isPublicHttpsUrl, parseUrl } from '@anywalletkit/networks/url'

/**
 * The server side of `ensCcipViaProxy` (`@anywalletkit/names-ens`): asks one CCIP-Read (EIP-3668) gateway on behalf of an app
 * whose own fetch cannot refuse redirects (React Native), so the gateway a name's resolver chooses never
 * reaches the user's device or network.
 *
 * Framework-free: wire `handle(body)` into any HTTP route that receives `POST /ccip` with the JSON
 * `{ url, method, body? }` that `ensCcipViaProxy` sends, and send back `{status, body}` as JSON
 * (`{ data: '0x…' }` on success, `{ error }` otherwise).
 *
 * What it guarantees:
 * - the gateway URL is https, without credentials, on a public host (the same check the device runs,
 *   `isPublicHttpsUrl`), and parses to the same host under the WHATWG parser that connects;
 * - the host's DNS answers are checked: a name with any private, loopback, link-local, CGNAT, multicast
 *   or IPv4-carrying IPv6 (mapped, NAT64, 6to4) address is refused. The connection is pinned to the
 *   checked address (TLS still verifies the certificate for the host name), so a second DNS answer
 *   cannot move it (DNS rebinding). With `opts.fetch` there is no pinning: the override connects itself;
 * - redirects are never followed: any 3xx is a failure;
 * - GET with no body, or POST with exactly `{sender, data}` (rebuilt, not forwarded), as EIP-3668 defines;
 * - no header or cookie of the caller is forwarded; the gateway sees this server and two fixed headers;
 * - a timeout covers DNS, connect and the whole answer, and the answer is read to at most
 *   `maxResponseBytes`; only hex `data` comes back to the app.
 *
 * What it does NOT do, and you must: authenticate the caller and rate-limit per user/IP in your route
 * before calling `handle`, and cap the raw request size before parsing (`maxRequestBytes` checks the
 * parsed fields). Without that it is an open https fetcher for anyone.
 *
 * Server-only (Node ≥ 22: `node:https`, `node:dns`). Never import it into an app.
 */
export interface EnsCcipHandlerOptions {
  /** Only these hosts are asked (a host matches an entry it equals or is a subdomain of). Default: any public host. */
  allowHosts?: readonly string[]
  /** Never these hosts (same matching); checked before `allowHosts`. */
  denyHosts?: readonly string[]
  /** For the whole gateway call: DNS, connect, answer. Default 10 s. */
  timeoutMs?: number
  /** Largest gateway answer read, in bytes; a larger one is refused (502). Default 1 MiB. */
  maxResponseBytes?: number
  /** Longest gateway URL and `data`, in characters. Default 64 KiB each. */
  maxRequestBytes?: number
  /** DNS resolution (tests): every address of a host. Default `dns.lookup(host, { all: true })`. */
  lookup?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>
  /**
   * Ask the gateway with this fetch instead of the pinned `node:https` request (tests, or a runtime without
   * `node:https`). It gets `redirect: 'manual'`; the DNS check still runs first, but the connection is not pinned.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export interface EnsCcipResponse {
  status: number
  body: { data: string } | { error: string }
}

const HEX = /^0x[0-9a-fA-F]*$/
const SENDER = /^0x[0-9a-fA-F]{40}$/
const REQUEST_KEYS = new Set(['url', 'method', 'body'])

class Refusal extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const matches = (host: string, entries: readonly string[]): boolean =>
  entries.some((e) => {
    const d = e.trim().toLowerCase().replace(/\.$/, '')
    return d !== '' && (host === d || host.endsWith(`.${d}`))
  })

/** `createEnsCcipHandler(opts)(body)` → `{ status, body }` for one CCIP-Read gateway call. */
export function createEnsCcipHandler(opts: EnsCcipHandlerOptions = {}): (body: unknown) => Promise<EnsCcipResponse> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxResponse = opts.maxResponseBytes ?? 1024 * 1024
  const maxRequest = opts.maxRequestBytes ?? 64 * 1024
  const lookup = opts.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }))

  return async function handle(input: unknown): Promise<EnsCcipResponse> {
    try {
      const call = validated(input, maxRequest)
      const host = call.host
      if (opts.denyHosts && matches(host, opts.denyHosts)) throw new Refusal(403, 'gateway host is not allowed')
      if (opts.allowHosts && !matches(host, opts.allowHosts)) throw new Refusal(403, 'gateway host is not allowed')

      const deadline = Date.now() + timeoutMs
      const pinned = await withDeadline(deadline, () => checkedAddress(host, lookup))
      const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9' }
      let body: string | undefined
      if (call.method === 'POST') {
        headers['content-type'] = 'application/json'
        body = JSON.stringify({ data: call.data, sender: call.sender }) // rebuilt from the checked fields
      }
      const answer = opts.fetch
        ? await viaFetch(opts.fetch, call.url, call.method, headers, body, deadline, maxResponse)
        : await viaPinnedHttps(call, pinned, headers, body, deadline, maxResponse)
      if (answer.status >= 300 && answer.status < 400) throw new Refusal(502, 'gateway redirected; redirects are not followed')
      if (answer.text === null) throw new Refusal(502, 'gateway answer too large')
      if (answer.status < 200 || answer.status >= 300) throw new Refusal(502, `gateway answered HTTP ${answer.status}`)
      let data: unknown = answer.text
      if (answer.contentType.toLowerCase().startsWith('application/json')) {
        try { data = (JSON.parse(answer.text) as { data?: unknown } | null)?.data } catch { throw new Refusal(502, 'gateway answered invalid JSON') }
      }
      if (typeof data !== 'string' || !HEX.test(data)) throw new Refusal(502, 'gateway answered something that is not hex data')
      return { status: 200, body: { data } }
    } catch (e) {
      if (e instanceof Refusal) return { status: e.status, body: { error: e.message } }
      // Network errors carry addresses and hosts: answer without them.
      return { status: 502, body: { error: 'gateway unavailable' } }
    }
  }
}

interface Call { url: string; host: string; port: number; path: string; method: 'GET' | 'POST'; sender?: string; data?: string }

/** The request as the handler will make it, or a 400 / 403 / 405. */
function validated(input: unknown, maxRequest: number): Call {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Refusal(400, 'body must be a JSON object')
  const o = input as Record<string, unknown>
  for (const k of Object.keys(o)) if (!REQUEST_KEYS.has(k)) throw new Refusal(400, `unexpected key: ${k.slice(0, 40)}`)
  if (o.method !== 'GET' && o.method !== 'POST') throw new Refusal(405, 'method must be GET or POST')
  if (typeof o.url !== 'string' || o.url.length > maxRequest) throw new Refusal(400, 'url must be a string of reasonable length')
  if (!isPublicHttpsUrl(o.url)) throw new Refusal(403, 'gateway must be https on a public host')
  // The WHATWG parser is the one that connects: it must see the host the check saw (scan 2026-10-28 F12).
  let u: URL
  try { u = new URL(o.url) } catch { throw new Refusal(400, 'url does not parse') }
  const checked = parseUrl(o.url)!
  const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (u.protocol !== 'https:' || u.username || u.password || hostname !== checked.host) {
    throw new Refusal(403, 'gateway must be https on a public host')
  }
  const base = { url: u.href, host: hostname, port: u.port ? Number(u.port) : 443, path: `${u.pathname}${u.search}` || '/' }
  if (o.method === 'GET') {
    if (o.body !== undefined) throw new Refusal(400, 'a GET carries no body')
    return { ...base, method: 'GET' }
  }
  const b = o.body as Record<string, unknown> | undefined
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'sender' && k !== 'data')) throw new Refusal(400, 'a POST body is exactly { sender, data }')
  if (typeof b.sender !== 'string' || !SENDER.test(b.sender)) throw new Refusal(400, 'sender must be an address')
  if (typeof b.data !== 'string' || !HEX.test(b.data) || b.data.length % 2 !== 0 || b.data.length > maxRequest) throw new Refusal(400, 'data must be hex bytes of reasonable length')
  return { ...base, method: 'POST', sender: b.sender, data: b.data }
}

/** The one address to connect to: the literal itself, or the host's DNS answer when none of it is private. */
async function checkedAddress(host: string, lookup: NonNullable<EnsCcipHandlerOptions['lookup']>): Promise<{ address: string; family: number }> {
  const literal = isIP(host)
  if (literal) return { address: host, family: literal }
  let addresses: ReadonlyArray<{ address: string; family: number }>
  try { addresses = await lookup(host) } catch { throw new Refusal(502, 'gateway host does not resolve') }
  if (!addresses.length) throw new Refusal(502, 'gateway host does not resolve')
  // Any private answer refuses the host: a name that mixes public and private addresses is a rebinding setup.
  for (const a of addresses) if (!isIP(a.address) || isPrivateHost(a.address)) throw new Refusal(403, 'gateway host resolves to a private address')
  return { address: addresses[0]!.address, family: addresses[0]!.family === 6 ? 6 : 4 }
}

async function withDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Refusal(504, 'gateway timed out')), Math.max(0, deadline - Date.now())) })
  try { return await Promise.race([run(), late]) } finally { clearTimeout(timer) }
}

interface Answer { status: number; contentType: string; text: string | null }

/** `node:https` to the checked address: `lookup` hands back that address, so nothing resolves the host again. */
function viaPinnedHttps(call: Call, pinned: { address: string; family: number }, headers: Record<string, string>, body: string | undefined, deadline: number, cap: number): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    let settled = false
    const done = (f: () => void) => { if (!settled) { settled = true; clearTimeout(timer); f() } }
    const req = httpsRequest({
      host: call.host,
      port: call.port,
      path: call.path,
      method: call.method,
      headers: body === undefined ? headers : { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      agent: false,
      ...(isIP(call.host) ? {} : { servername: call.host }),
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
        o?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)) as never,
    }, (res) => {
      const status = res.statusCode ?? 0
      const contentType = String(res.headers['content-type'] ?? '')
      if (status >= 300 && status < 400) { res.destroy(); return done(() => resolve({ status, contentType, text: '' })) }
      const declared = Number(res.headers['content-length'] ?? Number.NaN)
      if (Number.isFinite(declared) && declared > cap) { res.destroy(); return done(() => resolve({ status, contentType, text: null })) }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > cap) { res.destroy(); done(() => resolve({ status, contentType, text: null })) } else chunks.push(c)
      })
      res.on('end', () => done(() => resolve({ status, contentType, text: Buffer.concat(chunks).toString('utf8') })))
      res.on('error', (e) => done(() => reject(e)))
    })
    const timer = setTimeout(() => { req.destroy(); done(() => reject(new Refusal(504, 'gateway timed out'))) }, Math.max(0, deadline - Date.now()))
    req.on('error', (e) => done(() => reject(e)))
    req.end(body)
  })
}

/** The fetch override: no redirects, the same deadline and answer cap. */
async function viaFetch(doFetch: NonNullable<EnsCcipHandlerOptions['fetch']>, url: string, method: string, headers: Record<string, string>, body: string | undefined, deadline: number, cap: number): Promise<Answer> {
  const controller = new AbortController()
  return withDeadline(deadline, async () => {
    const res = await doFetch(url, { method, headers, redirect: 'manual', signal: controller.signal, ...(body === undefined ? {} : { body }) })
    const contentType = res.headers.get('content-type') ?? ''
    // `manual` gives an opaque redirect (status 0) in a browser-style fetch, the 3xx itself elsewhere.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) { await res.body?.cancel(); return { status: res.status || 302, contentType, text: '' } }
    return { status: res.status, contentType, text: await readCapped(res, cap) }
  }).catch((e: unknown) => { controller.abort(); throw e }) // on the deadline: stop the request too
}

/** The body, or null when larger than `cap` (read as a stream, never buffered past it). */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > cap) { await res.body?.cancel(); return null }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
