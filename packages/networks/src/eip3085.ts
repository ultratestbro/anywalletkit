/**
 * EIP-3085 `wallet_addEthereumChain` → {@link Network}, or the EIP-1193 error
 * to answer with. https RPC urls only (a site never gets the local-http
 * exception); by default the chain id must be in the asset catalog — pass
 * `known` to accept more (a build that lets users add any EVM chain).
 */
import { caip2FromChainId, isCatalogChain } from './catalog.js'
import type { Network } from './types.js'
import { checkRpcUrl } from './url.js'

/** EIP-1193 / EIP-1474 codes a provider answers `wallet_addEthereumChain` with. */
export const ADD_CHAIN_ERRORS = {
  invalidParams: -32602,
  /** EIP-3326/3085: the chain is not in the wallet. */
  chainNotAdded: 4902,
} as const

/** The EIP-1193 error to answer a refused `wallet_addEthereumChain` with. */
export interface AddChainError {
  code: number
  message: string
}

/** Type guard: did {@link parseAddChainParams} refuse? */
export const isAddChainError = (v: Network | AddChainError): v is AddChainError => 'code' in v && typeof v.code === 'number'

/** Options for {@link parseAddChainParams}. */
export interface ParseAddChainOptions {
  /** Which chain ids are acceptable; default: the asset catalog. */
  known?: (caip2: string) => boolean
  /** Site origin — recorded as the network's `source` so every sheet on it says who supplied the RPC. */
  origin?: string
  now?: () => number
}

/**
 * Turn `wallet_addEthereumChain` params into a {@link Network}, or into the EIP-1193 error to
 * answer with (`-32602` bad params, `4902` a chain the wallet refuses).
 */
export function parseAddChainParams(params: unknown, opts: ParseAddChainOptions = {}): Network | AddChainError {
  const known = opts.known ?? isCatalogChain
  const p = (Array.isArray(params) ? params[0] : params) as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return { code: ADD_CHAIN_ERRORS.invalidParams, message: 'wallet_addEthereumChain expects one object parameter.' }
  const caip2 = caip2FromChainId(p.chainId)
  if (!caip2) return { code: ADD_CHAIN_ERRORS.invalidParams, message: 'chainId must be a 0x-prefixed hex string.' }
  if (!known(caip2)) return { code: ADD_CHAIN_ERRORS.chainNotAdded, message: `Chain ${String(p.chainId)} is not in this wallet's catalog.` }
  const rpcs = Array.isArray(p.rpcUrls)
    ? p.rpcUrls.filter((u): u is string => typeof u === 'string').map((u) => checkRpcUrl(u)).flatMap((r) => (r.ok ? [r.url] : []))
    : []
  if (rpcs.length === 0) return { code: ADD_CHAIN_ERRORS.invalidParams, message: 'rpcUrls must contain at least one https URL.' }
  const name = typeof p.chainName === 'string' && p.chainName.trim() ? p.chainName.trim().slice(0, 64) : caip2
  const currency = p.nativeCurrency as { symbol?: unknown; decimals?: unknown } | undefined
  if (currency && currency.decimals !== undefined && currency.decimals !== 18) return { code: ADD_CHAIN_ERRORS.invalidParams, message: 'nativeCurrency.decimals must be 18.' }
  const symbol = typeof currency?.symbol === 'string' && /^[A-Za-z0-9]{1,12}$/.test(currency.symbol) ? currency.symbol : 'ETH'
  const explorers = Array.isArray(p.blockExplorerUrls) ? p.blockExplorerUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\//i.test(u)) : []
  const network: Network = {
    caip2,
    family: 'evm',
    name,
    symbol,
    decimals: 18,
    kind: 'custom',
    rpcs,
    ...(explorers[0] ? { explorer: explorers[0].replace(/\/$/, '') } : {}),
    source: opts.origin ? { origin: opts.origin, addedAt: (opts.now ?? Date.now)() } : 'user',
    enabled: true,
  }
  return network
}
