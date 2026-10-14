import type { ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@forgewallet/core'

/** Which explorer family answered. `routescan` = keyless Etherscan-format mirror. */
export type HistoryBackend = 'etherscan' | 'routescan' | 'blockscout'

/** The subset of WHATWG `fetch` this package uses; lets tests and hosts inject their own. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
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
  /** Blockscout instance root (`https://eth.blockscout.com`). Overrides / adds to the built-in table; `null` disables the built-in entry. */
  blockscoutUrl?: string | null
  /** Keyless Etherscan-format endpoint (Routescan style). Overrides / adds to the built-in table; `null` disables the built-in entry. */
  etherscanCompatUrl?: string | null
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: FetchLike
  /** Etherscan requests per second for this key. Default 5 with a key, 1 without. Shared by every source using the same key. */
  rateLimit?: number
  /** Try Blockscout before Etherscan when both exist (saves Etherscan quota). Default: Etherscan first. */
  prefer?: 'etherscan' | 'blockscout'
  /** Per-request timeout, ms. Default 15 000. */
  timeoutMs?: number
}

/** The explorer rows a `ChainTx` was built from, plus the spam verdict. */
export interface EvmHistoryRaw {
  source: HistoryBackend
  /** The top-level transaction row (txlist / Blockscout transaction). Absent when only a token transfer to the address was indexed. */
  tx?: unknown
  /** Token transfer rows (tokentx / Blockscout token-transfers). */
  tokens: unknown[]
  /** Internal native transfers (txlistinternal / Blockscout internal-transactions). */
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
