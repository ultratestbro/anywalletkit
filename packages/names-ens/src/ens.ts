import { createPublicClient, http, isAddress, getAddress, type CcipRequestParameters, type Hex, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { NameError, type NameErrorCode, type NameResolver, type NameWarning, type ResolvedName } from '@anywalletkit/core'
import { isPublicHttpsUrl } from '@anywalletkit/networks/url'
import { coinTypeFor, decodeAddressRecord } from './coins.js'
import { warningsFor } from './warnings.js'
import { cancelBody, declaresMoreThan, readCapped } from './read-capped.js'
import { loadNodeTransport, type PinnedCall } from './node-transport.js'

/** Options for `ensResolver`: an Ethereum-mainnet client or RPC URL, and caching. */
export interface EnsResolverOptions {
  /**
   * A viem client on Ethereum mainnet (the registry + universal resolver live there). Create it with
   * `ccipRead: ensCcipRead` (or `ccipRead: false`): with viem's default, a name's offchain resolver
   * chooses URLs the user's device fetches — `http://192.168.1.1/…` included. A client built from
   * `rpcUrl` has it already.
   */
  client?: PublicClient
  /** …or a mainnet RPC URL to build one from. One of the two is required. */
  rpcUrl?: string
  /**
   * How the client built from `rpcUrl` asks CCIP-Read gateways (see {@link EnsCcipOptions}). On React Native, offchain
   * names resolve only with `ccip.fetch` (one that refuses redirects, e.g. through your server) or
   * `ccip.allowRedirectFollowingFetch`. With your own `client`, use `ccipRead: createEnsCcipRead(…)` instead.
   */
  ccip?: EnsCcipOptions
  /** Cache TTL for resolutions, reverse lookups and avatars. Default 5 min. */
  cacheTtlMs?: number
  /**
   * IPFS gateway for `ipfs://` avatars: an origin (`https://gw.example`, `/ipfs/<cid>` is appended, as viem did) or a
   * prefix ending in `/ipfs/`. Default `https://ipfs.io/ipfs/`. Point it at your own proxy to keep users' IPs private.
   */
  ipfsGateway?: string
  /** TLDs this resolver should leave to others (`sol`, `near`, `ton` …). Default: those three plus `t.me`. */
  foreignTlds?: readonly string[]
}

interface Entry<T> { value: T; expires: number }

/**
 * A finer reason than the {@link NameErrorCode}, for the developer rather than the user.
 * `ccip-proxy-required`: an offchain (CCIP-Read) name on React Native with no `ccip` option set (code `lookup-failed`).
 */
export type EnsNameErrorReason = 'ccip-proxy-required'

export class EnsNameError extends NameError {
  /** Set when the cause is the app's setup, not the name or the network: see {@link EnsNameErrorReason}. */
  readonly reason: EnsNameErrorReason | undefined
  constructor(code: NameErrorCode, message: string, detail: { name?: string; chain?: string; cause?: unknown } = {}, reason?: EnsNameErrorReason) {
    super(code, message, detail)
    this.reason = reason
  }
}

/** What an app on React Native must set before offchain names resolve (scan 2026-10-28 F13). */
const CCIP_PROXY_REQUIRED =
  'Offchain (CCIP-Read) names are off on React Native: its fetch follows redirects, so a gateway could send the device to a host on the user\'s network. ' +
  'Ask gateways through your server: ensResolver({ rpcUrl, ccip: { fetch: ensCcipViaProxy(<your CCIP route>) } }), with createEnsCcipHandler() ' +
  "from '@anywalletkit/names-ens/server' behind that route. Or set ccip: { allowRedirectFollowingFetch: true } to ask gateways directly and accept the risk. " +
  'See the names guide, section "React Native".'

const ccipProxyRequired = (detail: { name?: string; chain?: string } = {}) =>
  new EnsNameError('lookup-failed', CCIP_PROXY_REQUIRED, detail, 'ccip-proxy-required')

/** How `ensCcipRequest` / `createEnsCcipRead` reach CCIP-Read gateways. */
export interface EnsCcipOptions {
  /**
   * The fetch used to ask gateways, in place of the default transport. Supply one that does not follow redirects: a
   * native fetch that honours `redirect: 'manual'`/`'error'`, or one that sends the request to your own server's
   * CCIP-Read proxy (which refuses redirects and checks the address it connects to). Passing it says redirects are
   * handled, so gateways are asked on every runtime, React Native included. The https check on the URL text still
   * runs first; where the host resolves is then up to this fetch (on Node it replaces the pinned transport — pass it
   * when gateways must go through a proxy or a split-horizon DNS you trust).
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * Ask gateways with the global fetch even on a runtime whose fetch follows redirects whatever `redirect` says
   * (React Native). Default false: there, without `fetch`, offchain (CCIP-Read) names do not resolve. true brings
   * them back and accepts the trade-off: a gateway that answers with a redirect makes the device send one blind
   * request (no answer is read) to the target, a LAN or loopback host included, before the redirect is noticed.
   */
  allowRedirectFollowingFetch?: boolean
  /**
   * For one gateway: the request and the whole answer. Default 10 s. Runs alongside the caller's signal
   * (viem passes none by default), so a gateway that never finishes its answer cannot hold the lookup.
   */
  timeoutMs?: number
  /** Largest gateway answer read, in bytes; a larger one (declared or streamed) is refused. Default 1 MiB. */
  maxResponseBytes?: number
}

/** React Native's fetch (OkHttp / NSURLSession) follows redirects and ignores `redirect: 'error'`. */
const fetchFollowsRedirects = (): boolean =>
  typeof navigator !== 'undefined' && (navigator as { product?: unknown }).product === 'ReactNative'

/** Node (Bun and Deno report it too, and have `node:https`); never React Native, whatever a polyfill sets. */
const runsOnNode = (): boolean => {
  const v = (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node
  return typeof v === 'string' && v !== '' && !fetchFollowsRedirects()
}

/** The pinned Node transport, loaded once; a browser / React Native bundle has none (see node-transport.ts). */
let nodeTransport: Promise<PinnedCall> | undefined
function nodeTransportFor(): Promise<PinnedCall> | null {
  if (!loadNodeTransport) return null
  nodeTransport ??= loadNodeTransport().catch((e: unknown) => {
    nodeTransport = undefined
    throw new EnsNameError('lookup-failed', 'The pinned CCIP-Read transport for Node could not be loaded; pass ccip.fetch to ask gateways another way.', { cause: e })
  })
  return nodeTransport
}

/**
 * EIP-3668 (CCIP-Read) lookups as a wallet may make them (scan 2026-10-27 modules, F37): a name's
 * offchain resolver picks the gateway URLs, so only https URLs whose host is not, as written, a private
 * one are asked — no `http://`, no localhost / LAN / link-local / CGNAT address in any spelling, no
 * placeholder in the host — and a redirect is refused (`redirect: 'error'`). Same protocol as viem's own:
 * GET with `{data}` in the URL, POST `{data, sender}` otherwise, a hex `data` answer, at most
 * `opts.maxResponseBytes`, within `opts.timeoutMs` per gateway.
 *
 * Where the host resolves depends on the transport:
 * - `opts.fetch`: up to that fetch (e.g. `ensCcipViaProxy` to your server's `createEnsCcipHandler`).
 * - Node, no `opts.fetch` (scan 2026-10-30 F17): the pinned transport of `createEnsCcipHandler`, in process —
 *   every DNS answer is checked and the connection is pinned to it, so a public-looking name that resolves to a
 *   private address is not asked. A gateway host whose records mix public and private addresses is refused;
 *   behind a corporate split-horizon DNS or an outbound proxy, pass `opts.fetch`.
 * - A browser and other runtimes: the global fetch. The URL text is checked, the resolved address is not: no
 *   DNS-level isolation. Ask gateways through your server (`ensCcipViaProxy`) where that matters.
 * - React Native: its fetch cannot refuse a redirect, and checking the final URL afterwards is too late (the
 *   redirected request has gone out: scan 2026-10-28 F13), so no gateway is asked unless `opts.fetch` handles
 *   redirects or `opts.allowRedirectFollowingFetch` accepts the risk.
 */
export async function ensCcipRequest({ data, sender, urls, requestOptions }: CcipRequestParameters, opts: EnsCcipOptions = {}): Promise<Hex> {
  const signal = requestOptions?.signal ?? undefined
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  if (!opts.fetch && !opts.allowRedirectFollowingFetch && fetchFollowsRedirects()) {
    throw ccipProxyRequired()
  }
  const timeoutMs = opts.timeoutMs ?? 10_000
  const cap = opts.maxResponseBytes ?? 1024 * 1024
  const pinned = !opts.fetch && runsOnNode() ? await nodeTransportFor() : null
  let error: Error = new EnsNameError('lookup-failed', 'The offchain resolver names no gateway this wallet asks.')
  for (const template of urls) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const url = template.replace('{sender}', sender.toLowerCase()).replace('{data}', data)
    if (!isPublicHttpsUrl(template) || !isPublicHttpsUrl(url)) {
      error = new EnsNameError('lookup-failed', 'The offchain resolver names a gateway that is not https on a public host; it was not asked.')
      continue
    }
    const post = !template.includes('{data}')
    const call = bounded(signal, timeoutMs)
    try {
      if (pinned) {
        // The handler's own deadline (timeoutMs) covers DNS, connect and the answer; the race adds the caller's abort.
        const out = await call.race(pinned({ url, method: post ? 'POST' : 'GET', ...(post ? { body: { sender, data } } : {}) }, { timeoutMs, maxResponseBytes: cap }))
        if ('data' in out.body) return out.body.data as Hex
        error = new EnsNameError('lookup-failed', `The offchain gateway's answer was not used: ${out.body.error}.`)
        continue
      }
      const res = await call.race(doFetch(url, {
        method: post ? 'POST' : 'GET',
        redirect: 'error',
        ...(post ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, sender }) } : {}),
        ...(call.signal ? { signal: call.signal } : {}),
      }))
      // A redirect that was followed anyway: its answer is not used (the request itself could not be stopped).
      if (res.redirected || (res.status >= 300 && res.status < 400) || (typeof res.url === 'string' && res.url !== '' && !isPublicHttpsUrl(res.url))) {
        cancelBody(res)
        error = new EnsNameError('lookup-failed', 'The offchain gateway redirected; the answer was not used.')
        continue
      }
      // Status and size first: an error answer, or one larger than the cap, is not read (scan 2026-10-30 F13).
      if (!res.ok) { cancelBody(res); error = new EnsNameError('lookup-failed', `The offchain gateway answered HTTP ${res.status}.`); continue }
      const tooLarge = () => new EnsNameError('lookup-failed', `The offchain gateway's answer is larger than ${cap} bytes; it was not used.`)
      if (declaresMoreThan(res, cap)) { cancelBody(res); error = tooLarge(); continue }
      const text = await call.race(readCapped(res, cap))
      if (text === null) { error = tooLarge(); continue }
      let result: unknown = text
      if ((res.headers.get('content-type') ?? '').startsWith('application/json')) {
        try { result = (JSON.parse(text) as { data?: unknown } | null)?.data } catch { result = undefined }
      }
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) { error = new EnsNameError('lookup-failed', 'The offchain gateway answered something that is not hex data.'); continue }
      return result as Hex
    } catch (e) {
      if (signal?.aborted) throw e
      error = e instanceof Error ? e : new Error(String(e))
    } finally {
      call.done()
    }
  }
  throw error
}

/**
 * One gateway call's deadline, merged with the caller's signal by hand: Hermes has AbortController but not
 * AbortSignal.timeout / .any. `race` settles with the work, the deadline or the caller's abort, whichever is
 * first; the deadline and the abort also abort `signal`, which stops the request and its body stream.
 */
function bounded(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal | undefined; race<T>(p: Promise<T>): Promise<T>; done(): void } {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let fail: (e: unknown) => void = () => {}
  const stop = new Promise<never>((_, reject) => { fail = reject })
  stop.catch(() => undefined) // a cleared timer can still fire on the Hermes CLI
  const onAbort = () => { fail(outer?.reason ?? new Error('aborted')); controller?.abort() }
  if (outer?.aborted) onAbort()
  else outer?.addEventListener?.('abort', onAbort)
  const timer = setTimeout(() => {
    fail(new EnsNameError('lookup-failed', `The offchain gateway did not answer within ${Math.round(timeoutMs / 100) / 10} s.`)) // first, so the race reports it
    controller?.abort()
  }, timeoutMs)
  return {
    signal: controller?.signal ?? outer,
    race: <T,>(p: Promise<T>) => Promise.race([p, stop]),
    done: () => { clearTimeout(timer); outer?.removeEventListener?.('abort', onAbort) },
  }
}

const isProxyRequired = (e: unknown): boolean => e instanceof EnsNameError && e.reason === 'ccip-proxy-required'

/** The refusal anywhere in an error's cause chain (viem wraps it in OffchainLookupError and a contract error). */
function causedByProxyRequired(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 8; cur = (cur as { cause?: unknown }).cause, depth++) if (isProxyRequired(cur)) return true
  return false
}

/** viem's `ccipRead` option with {@link ensCcipRequest} and `opts`: `createPublicClient({ chain: mainnet, transport, ccipRead: createEnsCcipRead({ fetch: viaMyServer }) })`. */
export function createEnsCcipRead(opts: EnsCcipOptions = {}): { readonly request: (p: CcipRequestParameters) => Promise<Hex> } {
  return Object.freeze({ request: (p: CcipRequestParameters) => ensCcipRequest(p, opts) })
}

/** viem's `ccipRead` option with {@link ensCcipRequest}'s defaults: `createPublicClient({ chain: mainnet, transport, ccipRead: ensCcipRead })`. */
export const ensCcipRead = createEnsCcipRead()

/**
 * An `avatar` text record as a URL an app may load: an https URL on a public host as written, or an
 * `ipfs://` one through `ipfsGateway`. Anything else — an NFT reference (resolving it means fetching the
 * NFT's metadata URL, which its issuer chooses), `http://`, `data:`, a private host — is `null`: nothing
 * is fetched to decide (scan 2026-10-27 modules, F37).
 */
export function avatarUrl(record: string | null | undefined, ipfsGateway = 'https://ipfs.io/ipfs/'): string | null {
  const r = typeof record === 'string' ? record.trim() : ''
  if (!r || r.length > 2048) return null
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{10,100}(?:\/[A-Za-z0-9._~%-]+)*)$/.exec(r)
  if (ipfs) return `${ipfsPrefix(ipfsGateway)}${ipfs[1]}`
  return isPublicHttpsUrl(r) ? r : null
}

/** The path a CID follows on `gateway`, given as an origin or as a prefix ending in `/ipfs/`. */
function ipfsPrefix(gateway: string): string {
  const g = gateway.replace(/\/+$/, '')
  return /\/ipfs$/i.test(g) ? `${g}/` : `${g}/ipfs/`
}

/** Names ENS can serve: `.eth` and any DNS name (cb.id, uni.eth subnames, imported DNS). */
export function ensResolver(opts: EnsResolverOptions): NameResolver {
  // Refusals of the React Native default, counted so that a lookup they broke says what to set (viem's batch
  // gateway turns a thrown error into a revert string, so the error itself does not always come back).
  let ccipRefusals = 0
  const ccipRead = {
    request: (p: CcipRequestParameters) => ensCcipRequest(p, opts.ccip).catch((e: unknown) => {
      if (isProxyRequired(e)) ccipRefusals++
      throw e
    }),
  }
  const client = opts.client ?? (opts.rpcUrl ? createPublicClient({ chain: mainnet, transport: http(opts.rpcUrl), ccipRead }) : null)
  if (!client) throw new Error('names-ens: pass a mainnet client or rpcUrl')
  const ttl = opts.cacheTtlMs ?? 5 * 60_000
  const ipfs = opts.ipfsGateway ?? 'https://ipfs.io/ipfs/'
  const foreign = new Set((opts.foreignTlds ?? ['sol', 'near', 'ton', 'me']).map((t) => t.toLowerCase()))
  const cache = new Map<string, Entry<unknown>>()
  const remember = <T,>(key: string, value: T): T => {
    cache.set(key, { value, expires: Date.now() + ttl })
    if (cache.size > 500) for (const [k, e] of cache) if (e.expires < Date.now()) cache.delete(k)
    return value
  }
  const recall = <T,>(key: string): T | undefined => {
    const e = cache.get(key)
    if (!e) return undefined
    if (e.expires < Date.now()) { cache.delete(key); return undefined }
    return e.value as T
  }

  /** ENSIP-15 normalization; the thrown reason is what the user sees. */
  const normalized = (name: string): { name: string; warnings: NameWarning[] } => {
    const trimmed = name.trim()
    if (!trimmed || !trimmed.includes('.')) throw new NameError('invalid-name', `"${trimmed}" is not a name`, { name: trimmed })
    let n: string
    try {
      n = normalize(trimmed)
    } catch (e) {
      throw new NameError('invalid-name', `"${trimmed}" is not a valid ENS name: ${e instanceof Error ? e.message : String(e)}`, { name: trimmed, cause: e })
    }
    if (n.split('.').some((l) => !l)) throw new NameError('invalid-name', `"${trimmed}" has an empty label`, { name: trimmed })
    return { name: n, warnings: warningsFor(n) }
  }

  const supports = (name: string): boolean => {
    const s = name.trim().toLowerCase()
    if (!s.includes('.') || /\s/.test(s) || isAddress(s)) return false
    const labels = s.split('.')
    if (labels.length < 2 || labels.some((l) => !l)) return false
    const tld = labels[labels.length - 1]!
    if (foreign.has(tld)) return false
    try { normalize(s) } catch { return false }
    return true
  }

  const resolve = async (input: string, chain: string, options?: { fresh?: boolean }): Promise<ResolvedName> => {
    const { name, warnings } = normalized(input)
    const coinType = coinTypeFor(chain)
    if (coinType === null) throw new NameError('unsupported', `ENS has no address record type for ${chain}`, { name, chain })
    const key = `r:${name}:${chain}`
    const hit = options?.fresh ? undefined : recall<ResolvedName>(key) // `fresh`: the signing-time check, never cached
    if (hit) return hit
    let raw: string | null
    const refusalsBefore = ccipRefusals
    try {
      raw = await client.getEnsAddress({ name, coinType })
    } catch (e) {
      if (ccipRefusals !== refusalsBefore || causedByProxyRequired(e)) throw ccipProxyRequired({ name, chain })
      throw new NameError('lookup-failed', `Could not look up ${name}: ${e instanceof Error ? e.message : String(e)}`, { name, chain, cause: e })
    }
    if (ccipRefusals !== refusalsBefore && (!raw || /^0x0*$/.test(raw))) throw ccipProxyRequired({ name, chain })
    if (!raw || /^0x0*$/.test(raw)) {
      // Distinguish "no such name" from "no record for this chain": the mainnet
      // record is the one almost every name has.
      const eth = coinType === 60n ? null : await client.getEnsAddress({ name }).catch(() => null)
      if (coinType !== 60n && eth) {
        throw new NameError('no-address-for-chain', `${name} has no address for ${chain} (it only has an Ethereum address — not used here on purpose)`, { name, chain })
      }
      throw new NameError('not-found', `${name} is not registered or has no address`, { name, chain })
    }
    const address = decodeAddressRecord(chain, raw, name)
    return remember(key, { name, chain, address, resolver: 'ens', warnings })
  }

  const reverse = async (address: string, chain: string): Promise<string | null> => {
    const coinType = coinTypeFor(chain)
    if (coinType === null || !chain.startsWith('eip155:')) return null
    if (!isAddress(address)) return null
    const key = `n:${chain}:${address.toLowerCase()}`
    const hit = recall<string | null>(key)
    if (hit !== undefined) return hit
    let name: string | null
    try {
      // ENSIP-19: L2 primary names ride the same call with the chain's coin type.
      name = await client.getEnsName({ address: getAddress(address), ...(coinType === 60n ? {} : { coinType }) })
    } catch {
      return null
    }
    if (!name) return remember(key, null)
    // A primary name counts only when it resolves forward to the same address.
    const forward = await resolve(name, chain).catch(() => null)
    return remember(key, forward && forward.address.toLowerCase() === address.toLowerCase() ? forward.name : null)
  }

  const avatar = async (input: string): Promise<string | null> => {
    const { name } = normalized(input)
    const key = `a:${name}`
    const hit = recall<string | null>(key)
    if (hit !== undefined) return hit
    try {
      // The record itself, filtered — not viem's getEnsAvatar, which fetches whatever URL the record or an NFT's metadata names.
      return remember(key, avatarUrl(await client.getEnsText({ name, key: 'avatar' }), ipfs))
    } catch {
      return remember(key, null)
    }
  }

  return { id: 'ens', supports, resolve, reverse, avatar }
}
