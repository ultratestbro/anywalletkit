/**
 * Per-chain explorer tables. Every entry was verified with curl on
 * 2026-10-14 (see README "Chain coverage"); re-run the probes in the README
 * when a chain is added or an explorer moves.
 */

/** Every EVM chain id the SDK's wallet / swap layers support. */
export const SUPPORTED_CHAIN_IDS: readonly number[] = [
  1, 8453, 42161, 10, 137, 56, 43114, 100, 130, 143, 999, 146, 80094, 59144, 534352, 324, 42220, 9745, 4326, 4663, 480, 1329,
  57073, 98866, 196,
]

export const ETHERSCAN_V2_API = 'https://api.etherscan.io/v2/api'
export const ETHERSCAN_V2_CHAINLIST = 'https://api.etherscan.io/v2/chainlist'
/** Blockscout PRO multichain API (Etherscan-format, `chain_id=` + `apikey=`); docs: https://docs.blockscout.com/devs/pro-api */
export const BLOCKSCOUT_PRO_API = 'https://api.blockscout.com/v2/api'
/**
 * Chains listed in Blockscout's PRO prod config (github.com/blockscout/backend-configs pro-api/prod/chains-config.json,
 * read 2026-10-14). The docs say "all chains"; the backend is tried for every chain when a key is set and
 * falls through on an "unsupported chain" answer, so this list is documentation, not a gate.
 */
export const BLOCKSCOUT_PRO_CHAIN_IDS: readonly number[] = [1, 10, 100, 130, 137, 324, 480, 534352, 4326, 4663, 5042, 8453, 42161, 42220, 57073, 98866]

/**
 * Chain ids `https://api.etherscan.io/v2/chainlist` listed on 2026-10-14 (63
 * chains total; only ours kept). Used when the live chainlist cannot be
 * fetched. NOT listed that day: Scroll 534352, zkSync Era 324, Ink 57073,
 * Plume 98866, X Layer 196.
 *
 * Note (same day): Etherscan v2 answers `Missing/Invalid API Key` without a
 * key on every chain, and `Free API access is not supported for this chain`
 * with a free-plan key on Base 8453, OP 10, BSC 56, Avalanche 43114 and
 * Gnosis 100; Celo 42220 shares a community quota (`Community Free API
 * Limit reached`). Those answers are surfaced as `HistoryUnavailableError`
 * reasons and trigger the fallbacks below.
 */
export const ETHERSCAN_V2_CHAIN_IDS_FALLBACK: readonly number[] = [
  1, 8453, 42161, 10, 137, 56, 43114, 100, 130, 143, 999, 146, 80094, 59144, 42220, 9745, 4326, 4663, 480, 1329,
]

/**
 * Public Blockscout (or Blockscout-compatible `/api/v2`) instances that
 * answered `200` JSON on `/api/v2/addresses/<a>/transactions` and
 * `/api/v2/transactions` on 2026-10-14. Base, Arbitrum and Polygon Blockscouts
 * sit behind a Cloudflare JS challenge (403 for non-browser clients) and are
 * left out on purpose; Linea, Sonic, Berachain, Monad, HyperEVM, Sei, Plasma,
 * Robinhood and BSC have no public Blockscout we could find.
 */
export const BLOCKSCOUT_URLS: Readonly<Record<number, string>> = {
  1: 'https://eth.blockscout.com',
  10: 'https://explorer.optimism.io',
  100: 'https://gnosisscan.io', // gnosis.blockscout.com redirects here; Blockscout-compatible API
  130: 'https://unichain.blockscout.com',
  324: 'https://zksync.blockscout.com',
  480: 'https://worldchain-mainnet.explorer.alchemy.com',
  4326: 'https://megaeth.blockscout.com',
  42220: 'https://celo.blockscout.com',
  57073: 'https://explorer.inkonchain.com',
  98866: 'https://explorer.plume.org',
  534352: 'https://scrollscan.com', // scroll.blockscout.com redirects here; Blockscout-compatible API
}

/**
 * Keyless Etherscan-format mirrors (Routescan). Same response shape as
 * Etherscan v1/v2, no `chainid`/`apikey` parameters. Verified 2026-10-14:
 * `status: "1"` for 1 and 43114, `No transactions found` (served) for 9745;
 * `chain not supported` for every other id of ours.
 */
export const ETHERSCAN_COMPAT_URLS: Readonly<Record<number, string>> = {
  1: 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api',
  43114: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api',
  9745: 'https://api.routescan.io/v2/network/mainnet/evm/9745/etherscan/api',
}

/**
 * Chains with no explorer API at all (neither Etherscan v2 nor a public
 * Blockscout / Routescan). `listActivity` returns an empty page with a
 * `note` instead of throwing. X Layer only has OKLink (own API, key required).
 */
export const NO_EXPLORER_CHAIN_IDS: readonly number[] = [196]

/** Human explorer, `/tx/<hash>` appended. Etherscan family where it exists, else the Blockscout / vendor explorer. */
export const EXPLORER_TX_BASE: Readonly<Record<number, string>> = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  10: 'https://optimistic.etherscan.io',
  137: 'https://polygonscan.com',
  56: 'https://bscscan.com',
  43114: 'https://snowscan.xyz',
  100: 'https://gnosisscan.io',
  130: 'https://uniscan.xyz',
  143: 'https://monadscan.com',
  999: 'https://hyperevmscan.io',
  146: 'https://sonicscan.org',
  80094: 'https://berascan.com',
  59144: 'https://lineascan.build',
  534352: 'https://scrollscan.com',
  324: 'https://explorer.zksync.io',
  42220: 'https://celoscan.io',
  9745: 'https://plasmascan.to',
  4326: 'https://mega.etherscan.io',
  4663: 'https://robin.etherscan.io',
  480: 'https://worldscan.org',
  1329: 'https://seiscan.io',
  57073: 'https://explorer.inkonchain.com',
  98866: 'https://explorer.plume.org',
  196: 'https://www.okx.com/web3/explorer/xlayer',
}

export function explorerTxUrl(chainId: number, hash: string): string {
  const base = EXPLORER_TX_BASE[chainId]
  if (!base) throw new Error(`@forgewallet/history-evm: no explorer known for chain ${chainId}`)
  return `${base}/tx/${hash}`
}
