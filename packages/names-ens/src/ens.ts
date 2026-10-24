import { createPublicClient, http, isAddress, getAddress, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { NameError, type NameResolver, type NameWarning, type ResolvedName } from '@anywalletkit/core'
import { coinTypeFor, decodeAddressRecord } from './coins.js'
import { warningsFor } from './warnings.js'

/** Options for `ensResolver`: an Ethereum-mainnet client or RPC URL, and caching. */
export interface EnsResolverOptions {
  /** A viem client on Ethereum mainnet (the registry + universal resolver live there). */
  client?: PublicClient
  /** …or a mainnet RPC URL to build one from. One of the two is required. */
  rpcUrl?: string
  /** Cache TTL for resolutions, reverse lookups and avatars. Default 5 min. */
  cacheTtlMs?: number
  /** IPFS gateway for `ipfs://` avatars. Default ipfs.io. Point it at your own proxy to keep users' IPs private. */
  ipfsGateway?: string
  /** TLDs this resolver should leave to others (`sol`, `near`, `ton` …). Default: those three plus `t.me`. */
  foreignTlds?: readonly string[]
}

interface Entry<T> { value: T; expires: number }

export class EnsNameError extends NameError {}

/** Names ENS can serve: `.eth` and any DNS name (cb.id, uni.eth subnames, imported DNS). */
export function ensResolver(opts: EnsResolverOptions): NameResolver {
  const client = opts.client ?? (opts.rpcUrl ? createPublicClient({ chain: mainnet, transport: http(opts.rpcUrl) }) : null)
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

  const resolve = async (input: string, chain: string): Promise<ResolvedName> => {
    const { name, warnings } = normalized(input)
    const coinType = coinTypeFor(chain)
    if (coinType === null) throw new NameError('unsupported', `ENS has no address record type for ${chain}`, { name, chain })
    const key = `r:${name}:${chain}`
    const hit = recall<ResolvedName>(key)
    if (hit) return hit
    let raw: string | null
    try {
      raw = await client.getEnsAddress({ name, coinType })
    } catch (e) {
      throw new NameError('lookup-failed', `Could not look up ${name}: ${e instanceof Error ? e.message : String(e)}`, { name, chain, cause: e })
    }
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
      const url = await client.getEnsAvatar({ name, assetGatewayUrls: { ipfs } })
      return remember(key, url ?? null)
    } catch {
      return remember(key, null)
    }
  }

  return { id: 'ens', supports, resolve, reverse, avatar }
}
