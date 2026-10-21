/** Chain families a network can belong to — one per wallet package. */
export type NetworkFamily = 'evm' | 'solana' | 'ton' | 'tron' | 'btc' | 'near' | 'zcash'

/** `catalog`: a mainnet the asset catalog knows; `testnet`: a shipped test network (off until enabled); `custom`: added by the user or a site. */
export type NetworkKind = 'catalog' | 'testnet' | 'custom'

/** Who supplied the entry. A site-added network (`wallet_addEthereumChain`) carries its origin so every sheet on it can say so. */
export type NetworkSource = 'builtin' | 'user' | { origin: string; addedAt: number }

export interface Network {
  /** CAIP-2: `eip155:11155111`, `solana:EtWT…`, `bip122:<genesis>`, `ton:-3`, `tron:nile`, `near:testnet`, `zcash:testnet`. */
  caip2: string
  family: NetworkFamily
  name: string
  /** Native currency. */
  symbol: string
  decimals: number
  kind: NetworkKind
  /** Endpoints, tried in order. For a builtin entry these are the public failover list; the table prepends the user's own. */
  rpcs: string[]
  /** Explorer base URL (no trailing slash). */
  explorer?: string
  source: NetworkSource
  /** Decision 4: drop the public fallback — only the user's RPCs are used (privacy / local node). */
  onlyOwnRpc?: boolean
  /** Decision 3, phase 2 of the mobile work: read balances over the user's RPC instead of the server. */
  balancesViaOwnRpc?: boolean
  /** Testnets ship disabled; a network whose verification failed is saved disabled. */
  enabled: boolean
}

/** One JSON value under one key — the shape every small store needs (chrome.storage, AsyncStorage, memory). */
export interface JsonStorage<T> {
  get(): Promise<T | null>
  set(value: T): Promise<void>
}

/** In-memory storage for tests and smoke runs. */
export function memoryJsonStorage<T>(initial: T | null = null): JsonStorage<T> & { value: T | null } {
  const clone = (v: T): T => JSON.parse(JSON.stringify(v)) as T
  const s = {
    value: initial,
    async get() { return s.value === null ? null : clone(s.value) },
    async set(value: T) { s.value = clone(value) },
  }
  return s
}

/** Result of checking one endpoint against the network it claims to serve. */
export interface VerifyResult {
  ok: boolean
  /** Round trip of the identity call. */
  latencyMs: number
  /** Tip height / slot / seqno when the endpoint reported one. */
  tip?: number
  /** Why the endpoint was refused (`chain-id-mismatch`, `url-policy`, `http-…`, `timeout`, …). */
  error?: string
  /** What the endpoint said it is (chain id, genesis, global id, chain name) — shown next to a mismatch. */
  reported?: string
}
