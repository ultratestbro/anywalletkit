import type { HistoryQuery } from '@forgewallet/core'
import { AlchemyClient } from './alchemy.js'
import { BlockscoutClient } from './blockscout.js'
import {
  ALCHEMY_NETWORKS,
  ALCHEMY_INTERNAL_CHAIN_IDS,
  ALCHEMY_TRANSFERS_CHAIN_IDS,
  ALCHEMY_URL_TEMPLATE,
  BLOCKSCOUT_PRO_API,
  BLOCKSCOUT_URLS,
  ETHERSCAN_COMPAT_URLS,
  ETHERSCAN_V2_API,
  ETHERSCAN_V2_CHAINLIST,
  ETHERSCAN_V2_CHAIN_IDS_FALLBACK,
  NO_EXPLORER_CHAIN_IDS,
  explorerTxUrl as explorerTxUrlFor,
} from './chains.js'
import { decodeCursor, encodeCursor, type WindowCursor } from './cursor.js'
import { HistoryUnavailableError } from './errors.js'
import { EtherscanClient } from './etherscan.js'
import { defaultFetch, fetchJson } from './http.js'
import { windowPage, type ListSpec } from './paginate.js'
import { sharedBucket } from './rate-limit.js'
import { buildTx, mergeRows, type ExplorerRows, type InternalRow, type MergeContext, type TokenRow, type TxRow } from './rows.js'
import type { EvmChainTx, EvmHistoryOptions, EvmHistoryPage, EvmHistorySource, FetchLike, HistoryBackend } from './types.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 15_000

interface Backend {
  readonly backend: HistoryBackend
  listSpecs(address: string): ListSpec<{ block: number }>[]
  /** Window rows keyed by list → the three explorer lists. Default: lists are already `tx` / `tokens` / `internal`. */
  toRows?(rows: Map<string, { block: number }[]>): Promise<ExplorerRows>
  getTransaction(hash: string): Promise<{ tx: TxRow; tokens: TokenRow[]; internal?: InternalRow[] } | undefined>
}

function defaultRows(rows: Map<string, { block: number }[]>): ExplorerRows {
  return {
    tx: (rows.get('tx') ?? []) as TxRow[],
    tokens: (rows.get('tokens') ?? []) as TokenRow[],
    internal: (rows.get('internal') ?? []) as InternalRow[],
  }
}

// --- Etherscan v2 chainlist, fetched once per process (fallback table when it fails) ---

let chainlistPromise: Promise<Set<number>> | undefined

export function etherscanServedChains(fetchFn: FetchLike, timeoutMs: number): Promise<Set<number>> {
  if (!chainlistPromise) {
    chainlistPromise = (async () => {
      try {
        const res = await fetchJson(fetchFn, 'etherscan', ETHERSCAN_V2_CHAINLIST, timeoutMs)
        const result = (res.body as { result?: unknown } | undefined)?.result
        if (res.status === 200 && Array.isArray(result) && result.length > 0) {
          const ids = new Set<number>()
          for (const r of result as { chainid?: unknown }[]) {
            const id = Number(r.chainid)
            if (Number.isFinite(id)) ids.add(id)
          }
          return ids
        }
      } catch {
        /* fall through to the table */
      }
      return new Set(ETHERSCAN_V2_CHAIN_IDS_FALLBACK)
    })()
  }
  return chainlistPromise
}

/** Tests only. */
export function resetEtherscanChainlistCache(): void {
  chainlistPromise = undefined
}

/**
 * A `HistorySource` for one EVM chain. Backends, in order: Etherscan v2 (only
 * with an API key and only for chains the v2 chainlist serves) → Blockscout PRO
 * (with its key; Etherscan-format, one key for every Blockscout chain) → Alchemy
 * (with its key, on chains whose Transfers API is documented or with an explicit
 * `alchemyNetwork`) → keyless Etherscan-format mirror (Routescan, where one
 * exists) → Blockscout instance (where a public one exists). `prefer:
 * 'blockscout'` / `prefer: 'alchemy'` moves that backend first.
 */
export function createEvmHistory(options: EvmHistoryOptions): EvmHistorySource {
  const { chainId } = options
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('@forgewallet/history-evm: chainId must be a positive integer')
  const chain = `eip155:${chainId}`
  const fetchFn = options.fetch ?? defaultFetch()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const apiKey = options.etherscanApiKey

  const compatUrl = options.etherscanCompatUrl === null ? undefined : (options.etherscanCompatUrl ?? ETHERSCAN_COMPAT_URLS[chainId])
  const blockscoutUrl = options.blockscoutUrl === null ? undefined : (options.blockscoutUrl ?? BLOCKSCOUT_URLS[chainId])
  const alchemyNetwork = options.alchemyNetwork ?? (ALCHEMY_TRANSFERS_CHAIN_IDS.includes(chainId) ? ALCHEMY_NETWORKS[chainId] : undefined)
  const alchemyOn = Boolean(options.alchemyApiKey && alchemyNetwork)
  // No explorer API at all (and no override): answer locally, never touch the network.
  const noExplorer = NO_EXPLORER_CHAIN_IDS.includes(chainId) && !compatUrl && !blockscoutUrl && !options.blockscoutProApiKey && !alchemyOn

  let resolved: Promise<Backend[]> | undefined
  const resolveBackends = (): Promise<Backend[]> => {
    if (resolved) return resolved
    resolved = (async () => {
      const list: Backend[] = []
      if (apiKey) {
        const served = await etherscanServedChains(fetchFn, timeoutMs)
        if (served.has(chainId)) {
          list.push(
            new EtherscanClient({
              backend: 'etherscan',
              baseUrl: options.etherscanUrl ?? ETHERSCAN_V2_API,
              chainId,
              apiKey,
              fetch: fetchFn,
              bucket: sharedBucket(`etherscan:${apiKey}`, options.rateLimit ?? 3), // free tier = 3 calls/s per key, shared by every chain
              timeoutMs,
            }),
          )
        }
      }
      if (options.blockscoutProApiKey) {
        list.push(
          new EtherscanClient({
            backend: 'blockscout-pro',
            baseUrl: options.blockscoutProUrl ?? BLOCKSCOUT_PRO_API,
            chainId,
            chainParam: 'chain_id',
            apiKey: options.blockscoutProApiKey,
            fetch: fetchFn,
            bucket: sharedBucket(`blockscout-pro:${options.blockscoutProApiKey}`, options.blockscoutProRateLimit ?? 5),
            timeoutMs,
          }),
        )
      }
      if (alchemyOn) {
        const apiKey = options.alchemyApiKey!
        list.push(
          new AlchemyClient({
            network: alchemyNetwork!,
            apiKey,
            urlTemplate: options.alchemyUrl ?? ALCHEMY_URL_TEMPLATE,
            internal: ALCHEMY_INTERNAL_CHAIN_IDS.includes(chainId),
            fetch: fetchFn,
            bucket: sharedBucket(`alchemy:${apiKey}`, options.alchemyRateLimit ?? 5),
            timeoutMs,
          }),
        )
      }
      if (compatUrl) {
        list.push(new EtherscanClient({ backend: 'routescan', baseUrl: compatUrl, fetch: fetchFn, bucket: sharedBucket(`compat:${compatUrl}`, 2), timeoutMs }))
      }
      if (blockscoutUrl) {
        list.push(new BlockscoutClient({ baseUrl: blockscoutUrl, fetch: fetchFn, bucket: sharedBucket(`blockscout:${blockscoutUrl}`, 5), timeoutMs }))
      }
      const first = options.prefer
      if (first === 'blockscout' || first === 'alchemy') list.sort((a, b) => (a.backend === first ? -1 : b.backend === first ? 1 : 0))
      return list
    })()
    return resolved
  }

  const noBackendReason = (): string => {
    if (NO_EXPLORER_CHAIN_IDS.includes(chainId)) return `chain ${chainId} has no public explorer API (no Etherscan v2, Blockscout or Routescan)`
    if (!apiKey && !options.blockscoutProApiKey && !options.alchemyApiKey) return `chain ${chainId} has no keyless explorer; pass etherscanApiKey, blockscoutProApiKey or alchemyApiKey (all have free tiers)`
    if (options.alchemyApiKey && !alchemyOn) return `Etherscan v2 does not serve chain ${chainId}, Alchemy's Transfers API is not documented for it and no Blockscout / Routescan instance is known; pass blockscoutUrl or alchemyNetwork`
    return `Etherscan v2 does not serve chain ${chainId} and no Blockscout / Routescan instance is known; pass blockscoutUrl or alchemyApiKey`
  }

  const ctxFor = (address: string, source: HistoryBackend): MergeContext => ({ chain, chainId, address, source })

  return {
    chain,
    chainId,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<EvmHistoryPage> {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      if (noExplorer) return { items: [], note: noBackendReason() }
      const backends = await resolveBackends()
      if (backends.length === 0) throw new HistoryUnavailableError(chain, noBackendReason())
      const ordered = cursor ? [...backends].sort((a, b) => (a.backend === cursor.b ? -1 : b.backend === cursor.b ? 1 : 0)) : backends
      const attempts: string[] = []
      for (const backend of ordered) {
        try {
          let win: WindowCursor | undefined
          if (cursor) {
            // Same backend: resume its list cursors; another backend: resume from the block window only.
            win = cursor.b === backend.backend ? { lists: cursor.lists, ...(cursor.w !== undefined ? { w: cursor.w } : {}) } : cursor.w !== undefined ? { w: cursor.w, lists: {} } : undefined
          }
          const res = await windowPage(backend.listSpecs(address), win, limit)
          const rows = backend.toRows ? await backend.toRows(res.rows) : defaultRows(res.rows)
          let items = mergeRows(ctxFor(address, backend.backend), rows)
          let next = res.next
          if (query.since !== undefined) {
            // `since` is applied client-side (explorers page by block, not time); once a page reaches older rows there is no next page.
            const since = query.since
            if (items.some((t) => t.time < since)) next = undefined
            items = items.filter((t) => t.time >= since)
          }
          const page: EvmHistoryPage = { items, backend: backend.backend }
          if (next) page.cursor = encodeCursor({ v: 1, b: backend.backend, lists: next.lists, ...(next.w !== undefined ? { w: next.w } : {}) })
          return page
        } catch (e) {
          attempts.push(`${backend.backend}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      throw new HistoryUnavailableError(chain, attempts[attempts.length - 1] ?? 'every backend failed', attempts)
    },

    async getTransaction(hash: string, address: string): Promise<EvmChainTx | undefined> {
      if (noExplorer) return undefined
      const backends = await resolveBackends()
      if (backends.length === 0) throw new HistoryUnavailableError(chain, noBackendReason())
      const attempts: string[] = []
      for (const backend of backends) {
        try {
          const found = await backend.getTransaction(hash)
          if (!found) return undefined
          return buildTx(ctxFor(address, backend.backend), found.tx.hash, found.tx, found.tokens, found.internal ?? [])
        } catch (e) {
          attempts.push(`${backend.backend}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      throw new HistoryUnavailableError(chain, attempts[attempts.length - 1] ?? 'every backend failed', attempts)
    },

    explorerTxUrl(hash: string): string {
      return explorerTxUrlFor(chainId, hash)
    },
  }
}
