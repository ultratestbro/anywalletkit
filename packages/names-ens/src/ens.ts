import { createPublicClient, http, isAddress, getAddress, type CcipRequestParameters, type Hex, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { NameError, type NameErrorCode, type NameResolver, type NameWarning, type ResolvedName } from '@anywalletkit/core'
import { isPublicHttpsUrl } from '@anywalletkit/networks/url'
import { coinTypeFor, decodeAddressRecord } from './coins.js'
import { warningsFor } from './warnings.js'

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
  "Ask gateways through your server: ensResolver({ rpcUrl, ccip: { fetch: ensCcipViaProxy('https://your.server/ccip') } }), with createEnsCcipHandler() " +
  "from '@anywalletkit/names-ens/server' behind that route. Or set ccip: { allowRedirectFollowingFetch: true } to ask gateways directly and accept the risk. " +
  'See https://docs.anywallet.tech/guides/names/#react-native'

const ccipProxyRequired = (detail: { name?: string; chain?: string } = {}) =>
  new EnsNameError('lookup-failed', CCIP_PROXY_REQUIRED, detail, 'ccip-proxy-required')

/** How `ensCcipRequest` / `createEnsCcipRead` reach CCIP-Read gateways. */
export interface EnsCcipOptions {
  /**
   * The fetch used to ask gateways, in place of the global one. Supply one that does not follow redirects: a native
   * fetch that honours `redirect: 'manual'`/`'error'`, or one that sends the request to your own server's CCIP-Read
   * proxy (which refuses redirects and checks the address it connects to). Passing it says redirects are handled, so
   * gateways are asked on every runtime, React Native included. The https / public-host check still runs first.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * Ask gateways with the global fetch even on a runtime whose fetch follows redirects whatever `redirect` says
   * (React Native). Default false: there, without `fetch`, offchain (CCIP-Read) names do not resolve. true brings
   * them back and accepts the trade-off: a gateway that answers with a redirect makes the device send one blind
   * request (no answer is read) to the target, a LAN or loopback host included, before the redirect is noticed.
   */
  allowRedirectFollowingFetch?: boolean
}

/** React Native's fetch (OkHttp / NSURLSession) follows redirects and ignores `redirect: 'error'`. */
const fetchFollowsRedirects = (): boolean =>
  typeof navigator !== 'undefined' && (navigator as { product?: unknown }).product === 'ReactNative'

/**
 * EIP-3668 (CCIP-Read) lookups as a wallet may make them (scan 2026-10-27 modules, F37): a name's
 * offchain resolver picks the gateway URLs, and the device fetches them, so only https URLs on a public
 * host are asked — no `http://`, no localhost / LAN / link-local / CGNAT address in any spelling, no
 * placeholder in the host — and a redirect is refused (`redirect: 'error'`). React Native's fetch cannot
 * refuse a redirect, and checking the final URL afterwards is too late (the redirected request has gone out:
 * scan 2026-10-28 F13), so there no gateway is asked unless `opts.fetch` handles redirects or
 * `opts.allowRedirectFollowingFetch` accepts the risk. Same protocol as viem's own: GET with `{data}` in
 * the URL, POST `{data, sender}` otherwise, a hex `data` answer.
 */
export async function ensCcipRequest({ data, sender, urls, requestOptions }: CcipRequestParameters, opts: EnsCcipOptions = {}): Promise<Hex> {
  const signal = requestOptions?.signal ?? undefined
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  if (!opts.fetch && !opts.allowRedirectFollowingFetch && fetchFollowsRedirects()) {
    throw ccipProxyRequired()
  }
  let error: Error = new EnsNameError('lookup-failed', 'The offchain resolver names no gateway this wallet asks.')
  for (const template of urls) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    const url = template.replace('{sender}', sender.toLowerCase()).replace('{data}', data)
    if (!isPublicHttpsUrl(template) || !isPublicHttpsUrl(url)) {
      error = new EnsNameError('lookup-failed', 'The offchain resolver names a gateway that is not https on a public host; it was not asked.')
      continue
    }
    const post = !template.includes('{data}')
    try {
      const res = await doFetch(url, {
        method: post ? 'POST' : 'GET',
        redirect: 'error',
        ...(post ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, sender }) } : {}),
        ...(signal ? { signal } : {}),
      })
      // A redirect that was followed anyway: its answer is not used (the request itself could not be stopped).
      if (res.redirected || (res.status >= 300 && res.status < 400) || (typeof res.url === 'string' && res.url !== '' && !isPublicHttpsUrl(res.url))) {
        error = new EnsNameError('lookup-failed', 'The offchain gateway redirected; the answer was not used.')
        continue
      }
      const json = (res.headers.get('content-type') ?? '').startsWith('application/json')
      const result: unknown = json ? ((await res.json()) as { data?: unknown } | null)?.data : await res.text()
      if (!res.ok) { error = new EnsNameError('lookup-failed', `The offchain gateway answered HTTP ${res.status}.`); continue }
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) { error = new EnsNameError('lookup-failed', 'The offchain gateway answered something that is not hex data.'); continue }
      return result as Hex
    } catch (e) {
      if (signal?.aborted) throw e
      error = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw error
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
