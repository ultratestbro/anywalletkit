import type { ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'

/** Which explorer family answered. `routescan` = keyless Etherscan-format mirror; `alchemy` = Alchemy Transfers API + JSON-RPC. */
export type HistoryBackend = 'etherscan' | 'blockscout-pro' | 'alchemy' | 'routescan' | 'blockscout'

/** The subset of WHATWG `fetch` this package uses; lets tests and hosts inject their own. */
export type FetchLike = (
  input: string,
  init?: { method?: string; body?: string; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export interface EvmHistoryOptions {
  /** EVM chain id (1, 8453, …). The source's `chain` is `eip155:<chainId>`. */
  chainId: number
  /**
   * Etherscan v2 API key. Without it Etherscan is never called (since 2026 the
   * v2 API rejects keyless requests) and the source relies on the keyless
   * fallbacks (Routescan / Blockscout) of the chain, if any.
   */
  etherscanApiKey?: string
  /** Override the Etherscan v2 endpoint (e.g. a proxy that adds the key server-side). Default `https://api.etherscan.io/v2/api`. */
  etherscanUrl?: string
  /**
   * Blockscout PRO multichain API key (`proapi_…`, free tier 100K credits/day, 5 rps, every
   * Blockscout chain through one key). Etherscan-format (`chain_id=` instead of `chainid=`), so it
   * covers chains where the free Etherscan key is refused (Base, Optimism, BSC, Avalanche, Gnosis,
   * Arc, Robinhood) and ones Etherscan v2 lacks (Scroll, zkSync, Ink, Plume). Tried after Etherscan.
   */
  blockscoutProApiKey?: string
  /** Override the Blockscout PRO endpoint. Default `https://api.blockscout.com/v2/api`. */
  blockscoutProUrl?: string
  /** Blockscout PRO requests per second (free tier: 5). Shared per key across chains. */
  blockscoutProRateLimit?: number
  /**
   * Alchemy API key (free tier: 30M CU/month, no card). Enables the `alchemy` backend —
   * `alchemy_getAssetTransfers` (120 CU) for the lists plus one JSON-RPC batch of
   * `eth_getTransactionByHash` + `eth_getTransactionReceipt` per page for fee / status / calldata.
   * The only free source on Base and BSC. Every network must be **enabled for the app** in the
   * Alchemy dashboard first; otherwise the backend answers `<NETWORK> is not enabled for this app`
   * and the source falls through to the next backend.
   */
  alchemyApiKey?: string
  /** Alchemy network slug override (`base-mainnet`); default from `ALCHEMY_NETWORKS[chainId]`. Also enables the backend on chains the table does not list for the Transfers API. */
  alchemyNetwork?: string
  /** Override the Alchemy host template; `{network}` and `{key}` are substituted. Default `https://{network}.g.alchemy.com/v2/{key}`. */
  alchemyUrl?: string
  /** Alchemy compute units per second, shared per key across every chain (a batch costs the sum of its calls). Default 300 — the free tier's 500 CU/s with headroom. */
  alchemyComputeUnitsPerSecond?: number
  /** Blockscout instance root (`https://eth.blockscout.com`). Overrides / adds to the built-in table; `null` disables the built-in entry. */
  blockscoutUrl?: string | null
  /** Keyless Etherscan-format endpoint (Routescan style). Overrides / adds to the built-in table; `null` disables the built-in entry. */
  etherscanCompatUrl?: string | null
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
  /** Etherscan requests per second for this key. Default 3 (the free tier's limit; Lite 5, Standard 10). Shared by every source using the same key — 25 chains do not multiply it. */
  rateLimit?: number
  /** Try Blockscout (or Alchemy) before Etherscan when both exist (saves Etherscan quota / the only free source on Base). Default: Etherscan first. */
  prefer?: 'etherscan' | 'blockscout' | 'alchemy'
  /** Per-request timeout, ms. Default 15 000. */
  timeoutMs?: number
}

/** The explorer rows a `ChainTx` was built from, plus the spam verdict. */
export interface EvmHistoryRaw {
  source: HistoryBackend
  /** The top-level transaction row (txlist / Blockscout transaction / Alchemy `{ tx, receipt }`). Absent when only a token transfer to the address was indexed. */
  tx?: unknown
  /** Token transfer rows (tokentx / Blockscout token-transfers / Alchemy `erc20` transfers). */
  tokens: unknown[]
  /** Internal native transfers (txlistinternal / Blockscout internal-transactions / Alchemy `internal` transfers). */
  internal: unknown[]
  spam?: true
  /** Which rule fired: `zero-value`, `zero-value-unknown-token`, `bulk-airdrop`, `symbol-impersonation`. */
  spamReason?: string
}

/** `ChainTx` with the spam flag this source computes (also mirrored in `raw.spam`). */
export interface EvmChainTx extends ChainTx {
  spam?: boolean
  raw: EvmHistoryRaw
}

export interface EvmHistoryPage extends HistoryPage {
  items: EvmChainTx[]
  /** Which explorer served this page. */
  backend?: HistoryBackend
  /** Set when the page is empty because the chain has no explorer API at all. */
  note?: string
}

export interface EvmHistorySource extends HistorySource {
  readonly chainId: number
  listActivity(address: string, query?: HistoryQuery): Promise<EvmHistoryPage>
  getTransaction(hash: string, address: string): Promise<EvmChainTx | undefined>
}
