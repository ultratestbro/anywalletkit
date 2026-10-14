/**
 * Activity history: the raw, chain-normalized transaction (`ChainTx`) a
 * `HistorySource` returns for an address, and the human-level `ActivityItem`
 * a protocol module (or the kit's generic fallback) turns it into.
 *
 * Chain packages implement `HistorySource` (explorer / RPC backed). Protocol
 * modules implement `describeActivity(tx)` on their base class so a wallet
 * built on the SDK shows "Supplied 100 USDC · Aave v3" instead of "Contract
 * call" out of the box. Amounts are base units; chains are CAIP-2 ids.
 */

/** A token movement inside a transaction. `token` is the chain's identifier (contract, mint, jetton master, TRC-20 contract); `null` = native coin. */
export interface ChainTransfer {
  token: string | null
  from: string
  to: string
  amount: bigint
  /** Token standard when known (erc20, spl, token2022, jetton, trc20, nep141). Native transfers leave it undefined. */
  standard?: 'erc20' | 'erc721' | 'erc1155' | 'spl' | 'token2022' | 'jetton' | 'trc20' | 'nep141'
  /** Symbol / decimals when the source already knows them (catalog or on-chain metadata); the kit fills the rest. */
  symbol?: string
  decimals?: number
  /** ERC-721 / ERC-1155 token id. */
  tokenId?: string
}

/** The contract / program the transaction invoked, as far as the chain exposes it. */
export interface ChainCall {
  /** Contract address (EVM, Tron), program id (Solana), account (NEAR), destination contract (TON). */
  to: string
  /** EVM 4-byte selector (0x-prefixed, lowercase) when calldata is present. */
  selector?: string
  /** Full calldata (EVM / Tron), op code (TON), method name (NEAR) — whatever the chain gives. */
  data?: string
  /** Solana: one entry per top-level instruction (program id); NEAR: one per action method. */
  programs?: string[]
  /** NEAR / TON: method or op name when decoded. */
  method?: string
}

export type ChainTxStatus = 'confirmed' | 'failed' | 'pending'

/** One transaction as seen from `address`, normalized across chains. */
export interface ChainTx {
  /** CAIP-2 chain id. */
  chain: string
  hash: string
  /** Unix seconds. */
  time: number
  status: ChainTxStatus
  /** The address this history was fetched for (the wallet's own). */
  address: string
  from: string
  /** Primary destination: recipient of a transfer or the called contract. Null for contract creation / multi-destination. */
  to: string | null
  /** Native value moved by the top-level transaction, base units (0 for pure token / contract calls). */
  nativeValue: bigint
  /** Every native + token movement the chain reports for this tx, including internal ones, from the explorer / parsed instructions. */
  transfers: ChainTransfer[]
  /** Network fee paid by `from`, in native base units; undefined when unknown. */
  fee?: bigint
  /** The invoked contract / program, when it is not a plain transfer. */
  call?: ChainCall
  /** Block number / slot / lt, for ordering and cursors. */
  block?: bigint
  /** Chain-specific extras the source wants to keep (parsed TON actions, Solana logs…). Opaque to the kit. */
  raw?: unknown
}

export interface HistoryPage {
  items: ChainTx[]
  /** Opaque cursor for the next (older) page; absent when the source has no more. */
  cursor?: string
}

export interface HistoryQuery {
  /** Resume from a cursor returned by a previous page. */
  cursor?: string
  /** Page size hint; sources may return fewer. */
  limit?: number
  /** Only transactions newer than this unix time (for refresh). */
  since?: number
}

/** Where a chain package gets an address's transaction history. */
export interface HistorySource {
  /** CAIP-2 chain id this source serves. */
  readonly chain: string
  /** Newest first. */
  listActivity(address: string, query?: HistoryQuery): Promise<HistoryPage>
  /** One transaction by hash, normalized the same way (undefined when unknown / not yet indexed). */
  getTransaction(hash: string, address: string): Promise<ChainTx | undefined>
  /** Explorer URL for a transaction. */
  explorerTxUrl(hash: string): string
}

/** What happened, from the wallet owner's point of view. */
export type ActivityKind =
  | 'send' | 'receive' | 'self'
  | 'swap' | 'bridge'
  | 'stake' | 'unstake' | 'claim'
  | 'supply' | 'withdraw' | 'borrow' | 'repay'
  | 'approve' | 'revoke'
  | 'wrap' | 'unwrap'
  | 'contract' | 'unknown'

export interface ActivityAsset {
  /** Chain token id as in `ChainTransfer.token`; null = native. */
  token: string | null
  amount: bigint
  symbol?: string
  decimals?: number
}

export interface ActivityItem {
  /** `${chain}:${hash}` — unique across chains. */
  id: string
  chain: string
  hash: string
  time: number
  status: ChainTxStatus
  kind: ActivityKind
  /** Registry module name that recognized it (e.g. "@forgewallet/protocol-lending-aave-evm"); undefined for the generic fallback. */
  protocol?: string
  /** Short human title, e.g. "Supplied USDC", "Swapped ETH → USDC", "Sent USDT". */
  title: string
  /** Protocol / venue / counterparty label for the subtitle, e.g. "Aave v3 · Base", "LI.FI", "0x1234…abcd". */
  subtitle?: string
  /** What left the wallet. */
  assetsOut: ActivityAsset[]
  /** What arrived. */
  assetsIn: ActivityAsset[]
  /** The other party: recipient, sender, spender, contract. */
  counterparty?: string
  /** For cross-chain operations: the other leg (chain + hash) when known. */
  related?: { chain: string; hash: string }[]
  /** Source flagged it as spam / dust (unsolicited airdrop, zero-value transfer). The app hides these by default. */
  spam?: boolean
  fee?: bigint
  explorerUrl?: string
}

/** Context a module gets when asked to describe a transaction. */
export interface DescribeActivityContext {
  /** The wallet's own addresses on this chain (lowercase for EVM), so a module can tell in from out. */
  own: Set<string>
}

/** Address comparison that ignores EVM case; other chains compare verbatim. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Net movement of each token for `own` addresses: positive = arrived, negative = left. */
export function netTransfers(tx: ChainTx, own: Set<string>): Map<string | null, bigint> {
  const isOwn = (a: string) => own.has(a) || own.has(a.toLowerCase())
  const net = new Map<string | null, bigint>()
  for (const t of tx.transfers) {
    const out = isOwn(t.from), inn = isOwn(t.to)
    if (out === inn) continue
    net.set(t.token, (net.get(t.token) ?? 0n) + (inn ? t.amount : -t.amount))
  }
  return net
}

/** Split a net map into assetsIn / assetsOut lists. */
export function splitNet(net: Map<string | null, bigint>, meta?: (token: string | null) => Partial<ActivityAsset> | undefined): { assetsIn: ActivityAsset[]; assetsOut: ActivityAsset[] } {
  const assetsIn: ActivityAsset[] = [], assetsOut: ActivityAsset[] = []
  for (const [token, amount] of net) {
    if (amount === 0n) continue
    const a: ActivityAsset = { token, amount: amount < 0n ? -amount : amount, ...(meta?.(token) ?? {}) }
    ;(amount > 0n ? assetsIn : assetsOut).push(a)
  }
  return { assetsIn, assetsOut }
}

/** Build the common part of an `ActivityItem` from a `ChainTx`. */
export function activityBase(tx: ChainTx, kind: ActivityKind, title: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  const item: ActivityItem = { id: `${tx.chain}:${tx.hash}`, chain: tx.chain, hash: tx.hash, time: tx.time, status: tx.status, kind, title, assetsIn: [], assetsOut: [] }
  if (tx.fee !== undefined) item.fee = tx.fee
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (item as unknown as Record<string, unknown>)[k] = v
  return item
}
