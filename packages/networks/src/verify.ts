/**
 * Does this endpoint really serve the network it claims? One identity call per
 * family, compared with what the CAIP-2 id declares, plus the tip and the
 * round-trip time:
 *
 * | family | identity                                   | tip                       |
 * |--------|--------------------------------------------|---------------------------|
 * | evm    | `eth_chainId` = chain id                   | `eth_blockNumber`         |
 * | solana | `getGenesisHash` starts with the reference | `getSlot`                 |
 * | ton    | config param 19 (global id) = -239 / -3    | `getMasterchainInfo` seqno|
 * | tron   | genesis block id ends with the chain id    | `wallet/getnowblock`      |
 * | btc    | esplora `/block-height/0` = genesis        | `/blocks/tip/height`      |
 * | zcash  | same (Blockchair: dashboards/block/0)      | `/stats` or esplora       |
 * | near   | `status.chain_id` = reference              | `latest_block_height`     |
 *
 * A mismatch is `chain-id-mismatch` with what the endpoint reported — the
 * table parks such an RPC: an endpoint that changes chain under us is a
 * poisoning attempt, not an outage.
 */
import { familyOf } from './catalog.js'
import type { Network, VerifyResult } from './types.js'
import { checkRpcUrl, type UrlPolicyOptions } from './url.js'

/** The part of a `fetch` response the verifier reads. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  text(): Promise<string>
  /** The final URL, when the transport reports it: a different one means the request was redirected. */
  url?: string
  redirected?: boolean
  /** `opaqueredirect` for a redirect a browser stopped under `redirect: 'manual'`. */
  type?: string
  headers?: { get(name: string): string | null }
  /** A stream lets the verifier stop reading at {@link MAX_RESPONSE_BYTES}; without one the deadline bounds the read. */
  body?: { cancel?(): unknown; getReader?(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> } } | null
}
/**
 * A `fetch`-compatible function; pass one to route checks through a proxy or a test double. The verifier
 * asks for `redirect: 'error'`: a transport that cannot refuse redirects should at least report `url` /
 * `redirected`, so a redirected answer is refused (the redirected request itself has then already gone out).
 */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown; redirect?: 'error' | 'manual' | 'follow' }) => Promise<FetchResponseLike>

/** Options for `verifyNetwork`: transport, timeout, which endpoint, and the URL policy. */
export interface VerifyOptions extends UrlPolicyOptions {
  fetch?: FetchLike
  /** Per call; default 8 s. */
  timeoutMs?: number
  /** Which endpoint to check; default the network's first. */
  rpc?: string
  now?: () => number
}

// ---- expected identities per CAIP-2 ----

const BTC_GENESIS: Record<string, string> = {
  'bitcoin:mainnet': '000000000019d6689c085ae165831e93',
  'bitcoin:testnet': '000000000933ea01ad0ee984209779ba',
  'bitcoin:testnet4': '00000000da84f2bafbbc53dee25a72ae',
  // Every signet shares one genesis block (the challenge differs); regtest's is fixed in Bitcoin Core.
  'bitcoin:signet': '00000008819873e925422c1ff0f99f7c',
  'bitcoin:regtest': '0f9188f13cb7b2c71f2a335e3a4fc328',
}
const ZCASH_GENESIS: Record<string, string> = {
  'zcash:mainnet': '00040fe8ec8471911baa1db1266ea15d',
  'zcash:testnet': '05a60a92d99d85997cce3b87616c089f',
  'zcash:regtest': '029f11d80ef9765602235e1bc9727e3e', // zcashd chainparams (CRegTestParams)
}
const SOLANA_GENESIS: Record<string, string> = {
  'solana:mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana:testnet': '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
}
/** Last 4 bytes of the genesis block id, which is how Tron's CAIP-2 references are formed. */
const TRON_GENESIS_TAIL: Record<string, string> = { mainnet: '2b6653dc', shasta: '94a9059e', nile: 'cd8690dc' }

/** What the endpoint must report for this network, or null when the id is not one we can check. */
export function expectedIdentity(caip2: string): { family: string; value: string } | null {
  const family = familyOf(caip2)
  const r = caip2.split(':')[1] ?? ''
  switch (family) {
    case 'evm': return /^\d+$/.test(r) ? { family, value: r } : null
    case 'solana': return { family, value: SOLANA_GENESIS[caip2] ?? r }
    case 'ton': return /^-?\d+$/.test(r) ? { family, value: r } : null
    case 'tron': {
      const tail = TRON_GENESIS_TAIL[r] ?? (/^0x[0-9a-f]{8}$/i.test(r) ? r.slice(2).toLowerCase() : /^\d+$/.test(r) ? Number(r).toString(16).padStart(8, '0') : null)
      return tail ? { family, value: tail } : null
    }
    // An empty expected genesis would let any endpoint through: a network we cannot identify is not verifiable.
    case 'btc': { const v = BTC_GENESIS[caip2] ?? (caip2.startsWith('bip122:') ? r.toLowerCase() : ''); return v ? { family, value: v } : null }
    case 'zcash': { const v = ZCASH_GENESIS[caip2]; return v ? { family, value: v } : null }
    case 'near': return { family, value: r }
    default: return null
  }
}

// ---- transport ----

class VerifyFailure extends Error {
  constructor(readonly code: string, message: string, readonly reported?: string) {
    super(message)
  }
}

/** Scheme + host lowercased, default port, trailing slashes and fragment dropped: what a fetch reports back for the same URL. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(u.trim())
    if (!m) return u.trim()
    const scheme = m[1]!.toLowerCase()
    const host = m[2]!.toLowerCase().replace(scheme === 'https' ? /:443$/ : scheme === 'http' ? /:80$/ : /(?!)/, '')
    return `${scheme}://${host}${m[3]!.replace(/\/+(?=\?|$)/, '')}`
  }
  return norm(a) === norm(b)
}
const hostOf = (u: string | null | undefined): string | null => (u ? (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(u)?.[1]?.replace(/^[^@]*@/, '') ?? null) : null)
/** The most an identity answer may weigh; real ones are a few hundred bytes (reaudit 2026-10-30, #5). */
export const MAX_RESPONSE_BYTES = 1024 * 1024

const tooLarge = () => new VerifyFailure('too-large', `Answer larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB.`)

/**
 * The body as text, refused past {@link MAX_RESPONSE_BYTES}: a declared `content-length` over it is not read at all,
 * a stream is dropped once it passes it. A response without a stream (React Native's fetch, test doubles) is read
 * with `text()`, which the runtime buffers: there the deadline bounds it and the cap is checked on the text.
 */
async function readCapped(res: FetchResponseLike): Promise<string> {
  const declared = Number(res.headers?.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { release(res); throw tooLarge() }
  const reader = typeof res.body?.getReader === 'function' ? res.body.getReader() : null
  if (!reader) {
    const text = await res.text()
    if (text.length > MAX_RESPONSE_BYTES) throw tooLarge()
    return text
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) { reader.cancel().catch(() => {}); throw tooLarge() }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder
  if (typeof TD === 'function') return new TD().decode(all)
  // Hermes may have no TextDecoder: an identity answer that is used is ASCII JSON, one byte per character.
  let out = ''
  for (let i = 0; i < all.length; i += 0x2000) out += String.fromCharCode.apply(null, Array.from(all.subarray(i, i + 0x2000)))
  return out
}

/** Drop an unread body so the connection is not held open; a transport without one has nothing to release. */
function release(res: FetchResponseLike): void {
  try { Promise.resolve(res.body?.cancel?.()).catch(() => {}) } catch { /* nothing to release */ }
}
const redirected = (to: string | null) =>
  new VerifyFailure('redirected', `Endpoint redirected${to ? ` to ${to}` : ''}; enter the final URL`)
/** undici rejects a `redirect: 'error'` fetch with `fetch failed` and the reason in `cause`. */
function isRedirectRefusal(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x instanceof Error && i < 4; x = (x as { cause?: unknown }).cause, i++) if (/redirect/i.test(x.message)) return true
  return false
}

/**
 * One request. Redirects are refused (scan 2026-10-30 F18): a public endpoint could send the verifier to a
 * plain-http or private address the URL policy never saw. Error texts carry the status, never the body:
 * the body is whatever the endpoint (or a service behind it) chose to say, and apps show the error to the
 * user or answer a site with it.
 */
async function call(fetchFn: FetchLike, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, timeoutMs: number): Promise<string> {
  const AC = (globalThis as { AbortController?: new () => { signal: unknown; abort(): void } }).AbortController
  const ac = AC ? new AC() : null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac?.abort()
      reject(new VerifyFailure('timeout', `No answer within ${Math.round(timeoutMs / 1000)} s.`))
    }, timeoutMs)
  })
  try {
    const res = await Promise.race([fetchFn(url, { ...init, redirect: 'error', ...(ac ? { signal: ac.signal } : {}) }), timeout])
    // A non-ASCII host comes back punycoded: such a URL is judged by `redirected` alone.
    const finalUrl = typeof res.url === 'string' && res.url !== '' && /^[\x20-\x7e]*$/.test(url) ? res.url : null
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect' || res.redirected === true || (finalUrl !== null && !sameUrl(finalUrl, url))) {
      release(res)
      throw redirected(hostOf(finalUrl !== null && !sameUrl(finalUrl, url) ? finalUrl : res.headers?.get('location')))
    }
    if (!res.ok) {
      release(res)
      throw new VerifyFailure(`http-${res.status}`, `HTTP ${res.status}`)
    }
    return await Promise.race([readCapped(res), timeout])
  } catch (e) {
    if (e instanceof VerifyFailure) throw e
    if (isRedirectRefusal(e)) throw redirected(null)
    throw new VerifyFailure('unreachable', e instanceof Error ? e.message : String(e))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new VerifyFailure('bad-json', 'Not JSON.')
  }
}

async function jsonRpc(fetchFn: FetchLike, url: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const text = await call(fetchFn, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, timeoutMs)
  const j = parseJson(text) as { result?: unknown; error?: { message?: string; code?: number } }
  if (j.error) throw new VerifyFailure('rpc-error', `${method}: ${j.error.message ?? `code ${j.error.code}`}`)
  if (j.result === undefined) throw new VerifyFailure('bad-json', `${method}: no result`)
  return j.result
}

const base = (url: string) => url.replace(/\/+$/, '')
const hexToNumber = (v: unknown): number | undefined => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? Number.parseInt(v, 16) : typeof v === 'number' ? v : undefined)

/** The int32 a TON config-param-19 cell carries (BOC with one cell, 4 data bytes), base64 in. Hermes has no atob — decode by hand. */
export function tonGlobalIdFromBoc(b64: string): number | null {
  const bytes = base64ToBytes(b64)
  if (bytes.length < 4) return null
  // Serialized BOC: magic(4) flags(1: has_idx | has_crc32c | has_cache_bits | 0 | size:3) off_bytes(1) cells(size) roots(size) absent(size) tot_cells_size(off_bytes) root_list(roots*size) [index] cells…
  if (bytes[0] !== 0xb5 || bytes[1] !== 0xee || bytes[2] !== 0x9c || bytes[3] !== 0x72) return null
  const flags = bytes[4]!
  const size = flags & 7
  const offBytes = bytes[5]!
  const readN = (at: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i]!; return v }
  const cells = readN(6, size)
  const roots = readN(6 + size, size)
  let p = 6 + size * 3 + offBytes + roots * size
  if (flags & 0x80) p += cells * offBytes // index
  const d1 = bytes[p]
  const d2 = bytes[p + 1]
  if (d1 === undefined || d2 === undefined) return null
  const dataBytes = Math.ceil(d2 / 2)
  if (dataBytes < 4) return null
  const v = readN(p + 2, 4)
  return v >= 0x80000000 ? v - 0x100000000 : v
}

function base64ToBytes(b64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    buf = (buf << 6) | alphabet.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

// ---- per family ----

async function verifyEvm(f: FetchLike, url: string, want: string, t: number): Promise<{ reported: string; tip?: number }> {
  const chainId = hexToNumber(await jsonRpc(f, url, 'eth_chainId', [], t))
  if (chainId === undefined) throw new VerifyFailure('bad-json', 'eth_chainId returned no chain id')
  if (String(chainId) !== want) throw new VerifyFailure('chain-id-mismatch', `Endpoint serves chain ${chainId}, not ${want}.`, String(chainId))
  const tip = hexToNumber(await jsonRpc(f, url, 'eth_blockNumber', [], t).catch(() => undefined))
  return { reported: String(chainId), ...(tip !== undefined ? { tip } : {}) }
}

async function verifySolana(f: FetchLike, url: string, want: string, t: number): Promise<{ reported: string; tip?: number }> {
  const hash = await jsonRpc(f, url, 'getGenesisHash', [], t)
  if (typeof hash !== 'string') throw new VerifyFailure('bad-json', 'getGenesisHash returned no hash')
  if (!hash.startsWith(want)) throw new VerifyFailure('chain-id-mismatch', `Endpoint serves genesis ${hash.slice(0, 8)}…, not ${want.slice(0, 8)}….`, hash)
  const slot = await jsonRpc(f, url, 'getSlot', [], t).catch(() => undefined)
  return { reported: hash, ...(typeof slot === 'number' ? { tip: slot } : {}) }
}

async function verifyTon(f: FetchLike, url: string, want: string, t: number): Promise<{ reported: string; tip?: number }> {
  const info = (await jsonRpc(f, url, 'getMasterchainInfo', {}, t)) as { last?: { seqno?: number } }
  const seqno = info?.last?.seqno
  const cfg = (await jsonRpc(f, url, 'getConfigParam', { config_id: 19 }, t)) as { config?: { bytes?: string } }
  const globalId = cfg?.config?.bytes ? tonGlobalIdFromBoc(cfg.config.bytes) : null
  if (globalId === null) throw new VerifyFailure('bad-json', 'getConfigParam(19) returned no global id')
  if (String(globalId) !== want) throw new VerifyFailure('chain-id-mismatch', `Endpoint serves TON global id ${globalId}, not ${want}.`, String(globalId))
  return { reported: String(globalId), ...(typeof seqno === 'number' ? { tip: seqno } : {}) }
}

async function verifyTron(f: FetchLike, url: string, want: string, t: number): Promise<{ reported: string; tip?: number }> {
  const b = base(url)
  const now = parseJson(await call(f, `${b}/wallet/getnowblock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, t)) as { block_header?: { raw_data?: { number?: number } } }
  const tip = now?.block_header?.raw_data?.number
  const genesis = parseJson(await call(f, `${b}/wallet/getblockbynum`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"num":0}' }, t)) as { blockID?: string }
  const id = genesis?.blockID
  if (typeof id !== 'string' || id.length < 8) throw new VerifyFailure('bad-json', 'wallet/getblockbynum(0) returned no block id')
  const tail = id.slice(-8).toLowerCase()
  if (tail !== want) throw new VerifyFailure('chain-id-mismatch', `Endpoint serves Tron network …${tail}, not …${want}.`, tail)
  return { reported: tail, ...(typeof tip === 'number' ? { tip } : {}) }
}

/** Esplora (`/blocks/tip/height`, `/block-height/0`), Blockbook (`/api/v2`), Blockchair (`/stats`, `/dashboards/block/0`). */
async function verifyUtxo(f: FetchLike, url: string, want: string, t: number): Promise<{ reported: string; tip?: number }> {
  const b = base(url)
  if (/api\.blockchair\.com/i.test(b)) {
    const stats = parseJson(await call(f, `${b}/stats`, {}, t)) as { data?: { blocks?: number } }
    const dash = parseJson(await call(f, `${b}/dashboards/block/0`, {}, t)) as { data?: Array<{ block?: { hash?: string } }> | Record<string, { block?: { hash?: string } }> }
    const first = Array.isArray(dash?.data) ? dash.data[0] : dash?.data?.['0']
    const hash = first?.block?.hash
    if (typeof hash !== 'string') throw new VerifyFailure('bad-json', 'Blockchair returned no genesis hash')
    return checkGenesis(hash, want, stats?.data?.blocks)
  }
  const tipText = await call(f, `${b}/blocks/tip/height`, {}, t).catch(() => null)
  if (tipText !== null && /^\d+$/.test(tipText.trim())) {
    const genesis = (await call(f, `${b}/block-height/0`, {}, t)).trim()
    return checkGenesis(genesis, want, Number(tipText.trim()))
  }
  // Blockbook root: `<base>/api/v2` (or the base IS the api root).
  const roots = b.endsWith('/api/v2') ? [b] : [`${b}/api/v2`, b]
  for (const root of roots) {
    const status = parseJson(await call(f, root, {}, t).catch(() => 'null')) as { blockbook?: { bestHeight?: number }; backend?: { chain?: string } } | null
    if (!status?.blockbook) continue
    const idx = parseJson(await call(f, `${root}/block-index/0`, {}, t)) as { blockHash?: string }
    if (typeof idx?.blockHash !== 'string') throw new VerifyFailure('bad-json', 'Blockbook returned no genesis hash')
    return checkGenesis(idx.blockHash, want, status.blockbook.bestHeight)
  }
  throw new VerifyFailure('unreachable', 'Not an Esplora, Blockbook or Blockchair endpoint.')
}

function checkGenesis(hash: string, want: string, tip: number | undefined): { reported: string; tip?: number } {
  const h = hash.toLowerCase()
  if (want && !h.startsWith(want)) throw new VerifyFailure('chain-id-mismatch', `Endpoint serves genesis ${h.slice(0, 12)}…, not ${want.slice(0, 12)}….`, h)
  return { reported: h, ...(typeof tip === 'number' ? { tip } : {}) }
}

async function verifyNear(f: FetchLike, url: string, want: string, t: number): Promise<{ reported: string; tip?: number }> {
  const s = (await jsonRpc(f, url, 'status', [], t)) as { chain_id?: string; sync_info?: { latest_block_height?: number } }
  if (typeof s?.chain_id !== 'string') throw new VerifyFailure('bad-json', 'status returned no chain_id')
  if (s.chain_id !== want) throw new VerifyFailure('chain-id-mismatch', `Endpoint serves NEAR ${s.chain_id}, not ${want}.`, s.chain_id)
  const tip = s.sync_info?.latest_block_height
  return { reported: s.chain_id, ...(typeof tip === 'number' ? { tip } : {}) }
}

// ---- entry points ----

/** Check one endpoint (`opts.rpc`, default the network's first) against the network's declared identity. Never throws. */
export async function verifyNetwork(network: Pick<Network, 'caip2' | 'family' | 'rpcs'>, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const now = opts.now ?? (() => Date.now())
  const url = opts.rpc ?? network.rpcs[0]
  if (!url) return { ok: false, latencyMs: 0, error: 'no-rpc: the network has no endpoint to check.' }
  const policy = checkRpcUrl(url, { allowHttpLocal: opts.allowHttpLocal === true })
  if (!policy.ok) return { ok: false, latencyMs: 0, error: `url-policy: ${policy.message}` }
  const fetchFn = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch)
  if (!fetchFn) return { ok: false, latencyMs: 0, error: 'no-fetch: pass `fetch` in the options.' }
  const want = expectedIdentity(network.caip2)
  if (!want || want.family !== network.family) return { ok: false, latencyMs: 0, error: `bad-network: cannot derive what ${network.caip2} should report.` }
  const t = opts.timeoutMs ?? 8_000
  const started = now()
  try {
    let r: { reported: string; tip?: number }
    switch (network.family) {
      case 'evm': r = await verifyEvm(fetchFn, policy.url, want.value, t); break
      case 'solana': r = await verifySolana(fetchFn, policy.url, want.value, t); break
      case 'ton': r = await verifyTon(fetchFn, policy.url, want.value, t); break
      case 'tron': r = await verifyTron(fetchFn, policy.url, want.value, t); break
      case 'btc':
      case 'zcash': r = await verifyUtxo(fetchFn, policy.url, want.value, t); break
      case 'near': r = await verifyNear(fetchFn, policy.url, want.value, t); break
    }
    return { ok: true, latencyMs: Math.max(0, now() - started), reported: r.reported, ...(r.tip !== undefined ? { tip: r.tip } : {}) }
  } catch (e) {
    const latencyMs = Math.max(0, now() - started)
    if (e instanceof VerifyFailure) return { ok: false, latencyMs, error: `${e.code}: ${e.message}`, ...(e.reported ? { reported: e.reported } : {}) }
    return { ok: false, latencyMs, error: `unreachable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Every endpoint of the network, in order, each checked on its own. */
export async function verifyRpcs(network: Pick<Network, 'caip2' | 'family' | 'rpcs'>, opts: Omit<VerifyOptions, 'rpc'> = {}): Promise<Array<{ rpc: string; result: VerifyResult }>> {
  return Promise.all(network.rpcs.map(async (rpc) => ({ rpc, result: await verifyNetwork(network, { ...opts, rpc }) })))
}
