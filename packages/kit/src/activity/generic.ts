/**
 * The generic fallback: what the kit says about a transaction no protocol module
 * recognized. Pure and synchronous — the only inputs are the chain-normalized
 * `ChainTx`, the owner's addresses and the caller's label / native tables.
 *
 * Kinds: `send` (own → others), `receive` (others → own), `self` (own → own),
 * `approve` / `revoke` (ERC-20 `approve`, zero amount = revoke), `contract` (any
 * other call the owner made), `unknown` (nothing moved, no call).
 */
import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainCall, type ChainTx, type DescribeActivityContext,
} from '@anywalletkit/core'
import { ccAssetByToken } from '@anywalletkit/swap2-assets'

/** Native coin of a chain, for titles and amounts. */
export interface NativeAsset { symbol: string; decimals: number }

/** Address → label, per CAIP-2 chain (EVM addresses compared case-insensitively). */
export type KnownLabels = Record<string, Record<string, string>>

/**
 * Labels the generic describer uses when no module recognizes a transaction: known contract names,
 * native coins, explorer links.
 */
export interface GenericDescribeOptions {
  /** Labels for contracts / counterparties the app trusts or names ("Uniswap v3 Router"), per chain. */
  known?: KnownLabels
  /** Native coin per CAIP-2 chain; overrides the built-in table and the swap2-assets catalog. */
  natives?: Record<string, NativeAsset>
  /** Explorer URL for an item (the kit passes the chain's `HistorySource.explorerTxUrl`). */
  explorerUrl?: (chain: string, hash: string) => string | undefined
  /**
   * The app's own token list (custom tokens the user added, `@anywalletkit/tokens`): ERC-20s
   * outside the swap2-assets catalog. Used for symbols and decimals, and to know an `approve(x, 0)`
   * on such a token is an ERC-20 revoke. Without it an unlisted token's approval reads as
   * "Approved 0x1234…".
   */
  tokens?: (chain: string, token: string) => { symbol: string; decimals: number } | undefined
}

/** What the generic fallback adds to an `ActivityItem`. */
export interface GenericActivityItem extends ActivityItem {
  /** For `approve` / `revoke`: the allowance that was set. `amount: null` = unlimited (≥ 2^255). */
  approval?: { token: string; spender?: string; amount: bigint | null }
}

/** Selector of ERC-20 `approve(address,uint256)`. */
export const ERC20_APPROVE = '0x095ea7b3'
/** Selector of ERC-20 `transfer(address,uint256)`. */
export const ERC20_TRANSFER = '0xa9059cbb'
/** Selector of ERC-20 `transferFrom(address,address,uint256)`. */
export const ERC20_TRANSFER_FROM = '0x23b872dd'
/** Calls that are plain token transfers from the owner's point of view, not "contract calls". */
const TRANSFER_SELECTORS: ReadonlySet<string> = new Set([ERC20_TRANSFER, ERC20_TRANSFER_FROM])
const TRANSFER_METHODS = /^(transfer|transfer_notification|internal_transfer|excesses|ft_transfer|ft_transfer_call|jetton_transfer|transferChecked|transfer_checked)$/i
/** Solana programs a plain transfer touches (system, SPL token, token-2022, associated-token). */
const SOLANA_TRANSFER_PROGRAMS: ReadonlySet<string> = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
])
const UNLIMITED = 1n << 255n

/** Built-in native coins by exact CAIP-2 id (the swap2-assets catalog covers the EVM chains it lists). */
export const DEFAULT_NATIVES: Readonly<Record<string, NativeAsset>> = Object.freeze({
  'ton:-239': { symbol: 'GRAM', decimals: 9 }, // Toncoin → Gram, 2026-06-15; the chain keeps the TON name
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { symbol: 'SOL', decimals: 9 },
  'solana:mainnet': { symbol: 'SOL', decimals: 9 },
  'tron:0x2b6653dc': { symbol: 'TRX', decimals: 6 },
  'tron:728126428': { symbol: 'TRX', decimals: 6 },
  'bip122:000000000019d6689c085ae165831e93': { symbol: 'BTC', decimals: 8 },
  'bitcoin:mainnet': { symbol: 'BTC', decimals: 8 },
  'near:mainnet': { symbol: 'NEAR', decimals: 24 },
  'near:testnet': { symbol: 'NEAR', decimals: 24 },
})
/** Native coins by CAIP-2 namespace, when neither the tables nor the catalog know the chain. */
const NAMESPACE_NATIVES: Readonly<Record<string, NativeAsset>> = Object.freeze({
  eip155: { symbol: 'ETH', decimals: 18 }, solana: { symbol: 'SOL', decimals: 9 }, tron: { symbol: 'TRX', decimals: 6 },
  bip122: { symbol: 'BTC', decimals: 8 }, bitcoin: { symbol: 'BTC', decimals: 8 }, near: { symbol: 'NEAR', decimals: 24 }, ton: { symbol: 'GRAM', decimals: 9 },
})

/**
 * The wallet packages name non-EVM chains by genesis hash (CAIP-2 proper); the swap2-assets catalog
 * and most apps use the short ids. Map the former to the latter for catalog lookups and labels.
 */
export const CHAIN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana:mainnet',
  'tron:0x2b6653dc': 'tron:728126428',
  'bip122:000000000019d6689c085ae165831e93': 'bitcoin:mainnet',
})
/** The catalog's id for `chain` (itself when no alias exists). */
export const catalogChain = (chain: string): string => CHAIN_ALIASES[chain] ?? chain

/** The native coin of `chain`: options → built-in table → swap2-assets catalog → namespace default. */
export function nativeOf(chain: string, opts: GenericDescribeOptions = {}): NativeAsset {
  const o = opts.natives?.[chain] ?? opts.natives?.[catalogChain(chain)] ?? DEFAULT_NATIVES[chain]
  if (o) return o
  const cat = ccAssetByToken(catalogChain(chain), '')
  if (cat) return { symbol: cat.symbol, decimals: cat.decimals }
  return NAMESPACE_NATIVES[chain.split(':')[0]!] ?? { symbol: 'native', decimals: 18 }
}

/** `0x1234…abcd` (anything 14 chars or shorter prints whole). */
export const shortAddress = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** The caller's label for an address on a chain, if any (EVM: case-insensitive). */
export function knownLabel(known: KnownLabels | undefined, chain: string, address: string | null | undefined): string | undefined {
  if (!address) return undefined
  const table = known?.[chain]
  if (!table) return undefined
  const direct = table[address]
  if (direct !== undefined) return direct
  if (!address.startsWith('0x')) return undefined
  const want = address.toLowerCase()
  for (const [k, v] of Object.entries(table)) if (k.toLowerCase() === want) return v
  return undefined
}

/** Label or shortened address. */
export const addressLabel = (known: KnownLabels | undefined, chain: string, address: string): string => knownLabel(known, chain, address) ?? shortAddress(address)

/** 4-byte selector of an EVM call, from `call.selector` or the calldata. */
export function selectorOf(call: ChainCall | undefined): string | undefined {
  if (!call) return undefined
  if (call.selector && /^0x[0-9a-fA-F]{8}$/.test(call.selector)) return call.selector.toLowerCase()
  if (call.data && /^0x[0-9a-fA-F]{8}/.test(call.data)) return call.data.slice(0, 10).toLowerCase()
  return undefined
}

/** Source-flagged spam (`raw.spam` from history-evm, or the `spam` mirror on the row). */
export function isSpamTx(tx: ChainTx): boolean {
  const raw = tx.raw as { spam?: unknown } | undefined
  if (raw && typeof raw === 'object' && raw.spam === true) return true
  return (tx as ChainTx & { spam?: unknown }).spam === true
}

/** Is this call a plain transfer in disguise (token `transfer`, SPL transfer, jetton transfer …)? */
function isTransferCall(call: ChainCall, selector: string | undefined): boolean {
  if (selector) return TRANSFER_SELECTORS.has(selector)
  if (call.method && TRANSFER_METHODS.test(call.method)) return true
  if (call.programs && call.programs.length > 0) return call.programs.every((p) => SOLANA_TRANSFER_PROGRAMS.has(p))
  return false
}

/** Does the call carry anything beyond a destination (so it is a contract call, not a value transfer)? */
function isContractCall(call: ChainCall, selector: string | undefined): boolean {
  if (isTransferCall(call, selector)) return false
  if (selector) return true
  if (call.data && call.data !== '0x' && call.data.length > 2) return true
  if (call.method) return true
  return (call.programs?.length ?? 0) > 0
}

/** Symbol / decimals per token: the transfers' own metadata first, then the swap2-assets catalog, then the native table. */
export function assetMetaFor(tx: ChainTx, opts: GenericDescribeOptions = {}): (token: string | null) => Partial<ActivityAsset> | undefined {
  const key = (t: string | null) => (t === null ? null : t.startsWith('0x') ? t.toLowerCase() : t)
  const fromTransfers = new Map<string | null, Partial<ActivityAsset>>()
  for (const t of tx.transfers) {
    const k = key(t.token)
    if (fromTransfers.has(k)) continue
    const meta: Partial<ActivityAsset> = {}
    if (t.symbol !== undefined) meta.symbol = t.symbol
    if (t.decimals !== undefined) meta.decimals = t.decimals
    if (meta.symbol !== undefined || meta.decimals !== undefined) fromTransfers.set(k, meta)
  }
  return (token) => {
    const own = fromTransfers.get(key(token))
    if (own?.symbol !== undefined && own.decimals !== undefined) return own
    if (token === null) {
      const n = nativeOf(tx.chain, opts)
      return { symbol: own?.symbol ?? n.symbol, decimals: own?.decimals ?? n.decimals }
    }
    const cat = ccAssetByToken(catalogChain(tx.chain), token) ?? opts.tokens?.(tx.chain, token)
    if (!cat) return own
    return { symbol: own?.symbol ?? cat.symbol, decimals: own?.decimals ?? cat.decimals }
  }
}

/** Is `token` an ERC-20? The transfers' standard when they name one, else the swap2-assets catalog, else the app's token list. */
function isKnownErc20(tx: ChainTx, token: string, opts: GenericDescribeOptions = {}): boolean {
  const standards = new Set(tx.transfers.filter((t) => sameAddress(t.token, token)).map((t) => t.standard))
  if (standards.has('erc721') || standards.has('erc1155')) return false
  return standards.has('erc20') || ccAssetByToken(catalogChain(tx.chain), token) !== undefined || opts.tokens?.(tx.chain, token) !== undefined
}

/** Title label for an asset: symbol, the native coin, or a shortened token id. */
export function assetLabel(chain: string, a: ActivityAsset, opts: GenericDescribeOptions = {}): string {
  if (a.symbol) return a.symbol
  if (a.token === null) return nativeOf(chain, opts).symbol
  return shortAddress(a.token)
}

/** `${verb} USDC` for one asset, `${verb} USDC +2` for several, `${verb}` for none. */
function verbAssets(verb: string, chain: string, assets: ActivityAsset[], opts: GenericDescribeOptions): string {
  const lead = assets.find((a) => a.symbol) ?? assets[0]
  if (!lead) return verb
  const rest = assets.length - 1
  return `${verb} ${assetLabel(chain, lead, opts)}${rest > 0 ? ` +${rest}` : ''}`
}

const VERBS: Readonly<Record<ActivityKind, string>> = Object.freeze({
  send: 'Sent', receive: 'Received', self: 'Self-transfer', swap: 'Swapped', bridge: 'Bridged', stake: 'Staked', unstake: 'Unstaked', claim: 'Claimed',
  supply: 'Supplied', withdraw: 'Withdrew', borrow: 'Borrowed', repay: 'Repaid', approve: 'Approved', revoke: 'Revoked', wrap: 'Wrapped', unwrap: 'Unwrapped',
  contract: 'Contract call', unknown: 'Transaction',
})

/**
 * A title for `kind` from what moved: "Swapped USDC → ETH", "Bridged USDC", "Received ETH",
 * "Staked ETH"… Used when an item inherits its kind from an intent and for pending intents.
 */
export function titleFor(kind: ActivityKind, chain: string, assetsOut: ActivityAsset[], assetsIn: ActivityAsset[], opts: GenericDescribeOptions = {}): string {
  const verb = VERBS[kind]
  const out = assetsOut.find((a) => a.symbol) ?? assetsOut[0]
  const inn = assetsIn.find((a) => a.symbol) ?? assetsIn[0]
  switch (kind) {
    case 'contract': case 'unknown': case 'self': return verb
    case 'receive': case 'claim': case 'borrow': case 'withdraw': case 'unstake': return verbAssets(verb, chain, assetsIn, opts)
    case 'swap': case 'bridge': case 'wrap': case 'unwrap':
      if (out && inn) return `${verb} ${assetLabel(chain, out, opts)} → ${assetLabel(chain, inn, opts)}`
      if (out) return `${verb} ${assetLabel(chain, out, opts)}`
      if (inn) return `Received ${assetLabel(chain, inn, opts)}`
      return verb
    default: return verbAssets(verb, chain, assetsOut, opts)
  }
}

/** Paid one set of assets, received a different one (gas-only native legs do not count as "paid"). */
function looksLikeSwap(assetsOut: ActivityAsset[], assetsIn: ActivityAsset[]): boolean {
  if (assetsOut.length === 0 || assetsIn.length === 0) return false
  const outT = new Set(assetsOut.map((a) => a.token)), inT = new Set(assetsIn.map((a) => a.token))
  return [...inT].some((t) => !outT.has(t)) && [...outT].some((t) => !inT.has(t))
}

const word = (data: string, i: number): string | null => (data.length >= 10 + 64 * (i + 1) ? data.slice(10 + 64 * i, 10 + 64 * (i + 1)) : null)

/**
 * Describe `tx` when no protocol module claimed it. Never returns null: every row gets
 * at least `unknown`. Spam rows (`raw.spam` / `tx.spam`) carry `spam: true`.
 */
export function describeGeneric(tx: ChainTx, ctx: DescribeActivityContext, opts: GenericDescribeOptions = {}): GenericActivityItem {
  const own = ctx.own
  const isOwn = (a: string | null | undefined): boolean => !!a && (own.has(a) || own.has(a.toLowerCase()))
  const meta = assetMetaFor(tx, opts)
  const ownSender = isOwn(tx.from)

  // Net movement for the owner. Sources differ on whether the top-level native value is mirrored in `transfers`; count it once.
  const net = netTransfers(tx, own)
  if (tx.nativeValue > 0n && tx.to && tx.status !== 'failed' && !tx.transfers.some((t) => t.token === null && sameAddress(t.from, tx.from) && sameAddress(t.to, tx.to) && t.amount === tx.nativeValue)) {
    const inn = isOwn(tx.to)
    if (ownSender !== inn) net.set(null, (net.get(null) ?? 0n) + (inn ? tx.nativeValue : -tx.nativeValue))
  }
  const { assetsIn, assetsOut } = splitNet(net, meta)

  const explorerUrl = opts.explorerUrl?.(tx.chain, tx.hash)
  const spam = isSpamTx(tx)
  const make = (kind: ActivityKind, title: string, extra: Partial<GenericActivityItem> = {}): GenericActivityItem => {
    const item = activityBase(tx, kind, title, { assetsIn, assetsOut, ...extra }) as GenericActivityItem
    if (spam) item.spam = true
    if (explorerUrl !== undefined) item.explorerUrl = explorerUrl
    return item
  }

  const call = tx.call
  const selector = selectorOf(call)

  // 1. Approvals, when the owner made the call. The called contract is the token.
  if (ownSender && call?.to && selector === ERC20_APPROVE) {
    const data = call.data && call.data.length >= 10 ? call.data : null
    const spenderWord = data ? word(data, 0) : null
    const amountWord = data ? word(data, 1) : null
    const spender = spenderWord ? `0x${spenderWord.slice(24)}` : undefined
    const amount = amountWord !== null ? BigInt(`0x${amountWord}`) : undefined
    // approve(0x0, id) clears an NFT approval; approve(spender, 0) resets an ERC-20 allowance but
    // APPROVES spender for token #0 on an ERC-721, so it is a revoke only on a known ERC-20.
    const revoke = (spenderWord !== null && /^0+$/.test(spenderWord)) || (amount === 0n && isKnownErc20(tx, call.to, opts))
    const tokenLabel = meta(call.to)?.symbol ?? knownLabel(opts.known, tx.chain, call.to) ?? shortAddress(call.to)
    const spenderLabel = spender ? addressLabel(opts.known, tx.chain, spender) : undefined
    const title = `${revoke ? 'Revoked' : 'Approved'} ${tokenLabel}${spenderLabel ? ` for ${spenderLabel}` : ''}`
    const approval: GenericActivityItem['approval'] = { token: call.to, amount: amount === undefined ? null : amount >= UNLIMITED ? null : amount }
    if (spender) approval.spender = spender
    const extra: Partial<GenericActivityItem> = { approval, subtitle: spenderLabel ?? 'Token approval' }
    if (spender) extra.counterparty = spender
    return make(revoke ? 'revoke' : 'approve', title, extra)
  }

  // 2. Any other call the owner made: a swap when it paid one asset and received another
  //    (aggregators / DEXes no module claims — Jupiter, 1inch…), else a contract call.
  if (ownSender && call?.to && isContractCall(call, selector)) {
    const extra: Partial<GenericActivityItem> = { subtitle: addressLabel(opts.known, tx.chain, call.to), counterparty: call.to }
    if (looksLikeSwap(assetsOut, assetsIn)) return make('swap', titleFor('swap', tx.chain, assetsOut, assetsIn, opts), extra)
    return make('contract', 'Contract call', extra)
  }

  // 3. Value movement.
  if (assetsOut.length > 0 && assetsIn.length === 0) {
    const first = tx.transfers.find((t) => isOwn(t.from) && !isOwn(t.to))
    const to = first?.to ?? tx.to ?? undefined
    const extra: Partial<GenericActivityItem> = {}
    if (to) { extra.counterparty = to; extra.subtitle = addressLabel(opts.known, tx.chain, to) }
    return make('send', verbAssets('Sent', tx.chain, assetsOut, opts), extra)
  }
  if (assetsIn.length > 0 && assetsOut.length === 0) {
    const first = tx.transfers.find((t) => isOwn(t.to) && !isOwn(t.from))
    const from = first?.from ?? tx.from
    const item = make('receive', verbAssets('Received', tx.chain, assetsIn, opts), { counterparty: from, subtitle: addressLabel(opts.known, tx.chain, from) })
    // Unsolicited zero-amount "receipts" (address poisoning, TRC-10 / ERC-20 dust airdrops with 0 value) are spam.
    if (assetsIn.every((a) => a.amount === 0n)) item.spam = true
    return item
  }
  if (assetsIn.length > 0 && assetsOut.length > 0) {
    // Both directions with no call of the owner's: something routed through a contract we do not know.
    const to = call?.to ?? tx.to
    const extra: Partial<GenericActivityItem> = {}
    if (to) { extra.counterparty = to; extra.subtitle = addressLabel(opts.known, tx.chain, to) }
    if (looksLikeSwap(assetsOut, assetsIn)) return make('swap', titleFor('swap', tx.chain, assetsOut, assetsIn, opts), extra)
    return make(to ? 'contract' : 'unknown', to ? 'Contract call' : 'Transaction', extra)
  }

  // 4. Nothing netted: own → own, a reverted send, or nothing we can see.
  const ownToOwn = tx.transfers.filter((t) => isOwn(t.from) && isOwn(t.to))
  const topLevelSelf = ownSender && isOwn(tx.to) && (tx.nativeValue > 0n || ownToOwn.length > 0)
  if (topLevelSelf || (ownToOwn.length > 0 && ownToOwn.length === tx.transfers.length)) {
    const moved = new Map<string | null, bigint>()
    for (const t of ownToOwn) moved.set(t.token, (moved.get(t.token) ?? 0n) + t.amount)
    if (tx.nativeValue > 0n && !ownToOwn.some((t) => t.token === null && t.amount === tx.nativeValue)) moved.set(null, (moved.get(null) ?? 0n) + tx.nativeValue)
    const assets: ActivityAsset[] = [...moved].map(([token, amount]) => ({ token, amount, ...(meta(token) ?? {}) }))
    const extra: Partial<GenericActivityItem> = { assetsOut: assets, assetsIn: [] }
    if (tx.to) { extra.counterparty = tx.to; extra.subtitle = addressLabel(opts.known, tx.chain, tx.to) }
    return make('self', 'Self-transfer', extra)
  }
  if (tx.status === 'failed' && ownSender && tx.nativeValue > 0n && tx.to) {
    const asset: ActivityAsset = { token: null, amount: tx.nativeValue, ...(meta(null) ?? {}) }
    return make('send', verbAssets('Sent', tx.chain, [asset], opts), { assetsOut: [asset], counterparty: tx.to, subtitle: addressLabel(opts.known, tx.chain, tx.to) })
  }
  if (tx.status === 'failed' && ownSender && call?.to && selector === ERC20_TRANSFER && call.data) {
    // A reverted token send: the intended recipient and amount are still in the calldata.
    const toWord = word(call.data, 0), amountWord = word(call.data, 1)
    const asset: ActivityAsset = { token: call.to, amount: amountWord ? BigInt(`0x${amountWord}`) : 0n, ...(meta(call.to) ?? {}) }
    const recipient = toWord ? `0x${toWord.slice(24)}` : undefined
    const extra: Partial<GenericActivityItem> = { assetsOut: [asset] }
    if (recipient) { extra.counterparty = recipient; extra.subtitle = addressLabel(opts.known, tx.chain, recipient) }
    return make('send', verbAssets('Sent', tx.chain, [asset], opts), extra)
  }
  if (ownSender && tx.to) {
    // A call with no data we could read (TON / NEAR sources without a decoded method, or an EVM call to a contract with empty calldata).
    return make(call ? 'contract' : 'unknown', call ? 'Contract call' : 'Transaction', { counterparty: tx.to, subtitle: addressLabel(opts.known, tx.chain, tx.to) })
  }
  return make('unknown', 'Transaction')
}
