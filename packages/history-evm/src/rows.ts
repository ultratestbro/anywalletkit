import type { ChainCall, ChainTransfer } from '@anywalletkit/core'
import { sameAddress } from '@anywalletkit/core'
import { catalogSymbols, catalogToken } from './catalog.js'
import type { EvmChainTx, EvmHistoryRaw, HistoryBackend } from './types.js'

/**
 * Explorer rows normalized to one shape per list, whatever the backend
 * (Etherscan `txlist`/`tokentx`/`txlistinternal`, Blockscout
 * `transactions`/`token-transfers`/`internal-transactions`). `mergeRows`
 * folds the three lists into one `EvmChainTx` per hash.
 */
export interface TxRow {
  hash: string
  block: number
  /** Unix seconds. */
  time: number
  from: string
  /** Null for contract creation. */
  to: string | null
  value: bigint
  /** `0x` when the tx carries no calldata. */
  input: string
  status: 'confirmed' | 'failed' | 'pending'
  fee?: bigint
  /** Address created by this tx, when it was a deployment. */
  contractAddress?: string
  raw: unknown
}

/** @internal A token-transfer row, explorer-neutral. */
export interface TokenRow {
  hash: string
  block: number
  /** Unix seconds; 0 when the explorer did not give one (the tx row fills it). */
  time: number
  from: string
  to: string
  /** Lower-cased contract. */
  token: string
  amount: bigint
  symbol?: string
  decimals?: number
  raw: unknown
}

/** @internal An internal-transaction row, explorer-neutral. */
export interface InternalRow {
  hash: string
  block: number
  time: number
  from: string
  to: string
  value: bigint
  raw: unknown
}

/** @internal Normal, token and internal rows of one explorer page. */
export interface ExplorerRows {
  tx: TxRow[]
  tokens: TokenRow[]
  internal: InternalRow[]
}

export function parseBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  if (typeof v === 'string' && v !== '') {
    try {
      return BigInt(v)
    } catch {
      return 0n
    }
  }
  return 0n
}

export function parseInt10(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** `2026-10-14T05:43:11.000000Z` → unix seconds (fraction trimmed to 3 digits: Hermes' Date.parse is strict). */
export function parseIsoSeconds(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0
  const ms = Date.parse(v.replace(/\.(\d{3})\d*(Z|[+-]\d\d:?\d\d)$/, '.$1$2'))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

/** ASCII letters/digits only, upper-cased; empty when the symbol had nothing else. */
function asciiSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function hasNonAscii(symbol: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7e]/.test(symbol)
}

/** @internal What merging explorer rows into a `ChainTx` needs. */
export interface MergeContext {
  chain: string
  chainId: number
  address: string
  source: HistoryBackend
}

/** One `EvmChainTx` per hash, newest first (block desc, then time desc). */
export function mergeRows(ctx: MergeContext, rows: ExplorerRows): EvmChainTx[] {
  const byHash = new Map<string, { tx?: TxRow; tokens: TokenRow[]; internal: InternalRow[] }>()
  const slot = (hash: string) => {
    const k = hash.toLowerCase()
    let s = byHash.get(k)
    if (!s) {
      s = { tokens: [], internal: [] }
      byHash.set(k, s)
    }
    return s
  }
  for (const r of rows.tx) slot(r.hash).tx = r
  for (const r of rows.tokens) slot(r.hash).tokens.push(r)
  for (const r of rows.internal) slot(r.hash).internal.push(r)

  const out: EvmChainTx[] = []
  for (const [hash, s] of byHash) out.push(buildTx(ctx, hash, s.tx, s.tokens, s.internal))
  out.sort((a, b) => {
    const ab = a.block ?? 0n, bb = b.block ?? 0n
    if (ab !== bb) return ab > bb ? -1 : 1
    return b.time - a.time
  })
  return out
}

/** @internal Merge one hash's explorer rows into a `ChainTx`. */
export function buildTx(ctx: MergeContext, hash: string, tx: TxRow | undefined, tokens: TokenRow[], internal: InternalRow[]): EvmChainTx {
  const first = tokens[0] ?? internal[0]
  const time = tx?.time || first?.time || 0
  const block = tx?.block ?? first?.block ?? 0
  const from = tx?.from ?? first?.from ?? ''
  const to: string | null = tx ? tx.to : (first?.to ?? null)
  const nativeValue = tx?.value ?? 0n

  const transfers: ChainTransfer[] = []
  if (tx && tx.value > 0n && tx.to) transfers.push({ token: null, from: tx.from, to: tx.to, amount: tx.value })
  for (const t of tokens) {
    const meta = catalogToken(ctx.chainId, t.token)
    const tr: ChainTransfer = { token: t.token, from: t.from, to: t.to, amount: t.amount, standard: 'erc20' }
    const symbol = t.symbol ?? meta?.symbol
    const decimals = t.decimals ?? meta?.decimals
    if (symbol !== undefined) tr.symbol = symbol
    if (decimals !== undefined) tr.decimals = decimals
    transfers.push(tr)
  }
  for (const i of internal) if (i.value > 0n) transfers.push({ token: null, from: i.from, to: i.to, amount: i.value })

  const raw: EvmHistoryRaw = { source: ctx.source, tokens: tokens.map((t) => t.raw), internal: internal.map((i) => i.raw) }
  if (tx) raw.tx = tx.raw

  const item: EvmChainTx = {
    chain: ctx.chain,
    hash,
    time,
    status: tx?.status ?? 'confirmed',
    address: ctx.address,
    from,
    to,
    nativeValue,
    transfers,
    block: BigInt(block),
    raw,
  }
  if (tx?.fee !== undefined) item.fee = tx.fee
  const call = callOf(tx)
  if (call) item.call = call

  const spam = spamReason(ctx, tx, tokens, internal)
  if (spam) {
    item.spam = true
    raw.spam = true
    raw.spamReason = spam
  }
  return item
}

function callOf(tx: TxRow | undefined): ChainCall | undefined {
  if (!tx) return undefined
  const input = tx.input
  if (!input || input === '0x' || input.length < 10) return undefined
  const to = tx.to ?? tx.contractAddress ?? ''
  return { to, selector: input.slice(0, 10).toLowerCase(), data: input }
}

/**
 * Spam heuristic (documented in the README). Never flags a transaction the
 * address itself sent. Returns the rule name or undefined.
 *
 * 1. `zero-value`: every movement in the tx is zero (zero-value `transferFrom`
 *    address poisoning, even with a catalog token such as USDT).
 * 2. `zero-value-unknown-token`: a token the catalog does not know moved 0.
 * 3. `bulk-airdrop`: 20+ token rows in one tx and at least one unknown token.
 * 4. `symbol-impersonation`: an unknown token whose symbol has non-ASCII
 *    characters, or whose ASCII form equals a catalog symbol on this chain
 *    (fake "USDT" at another contract, `U⁯S⁯DΤ`).
 */
export function spamReason(ctx: MergeContext, tx: TxRow | undefined, tokens: TokenRow[], internal: InternalRow[]): string | undefined {
  if (tokens.length === 0) return undefined
  if (tx && sameAddress(tx.from, ctx.address)) return undefined
  const known = (t: TokenRow) => catalogToken(ctx.chainId, t.token) !== undefined
  const allZero = (tx?.value ?? 0n) === 0n && tokens.every((t) => t.amount === 0n) && internal.every((i) => i.value === 0n)
  if (allZero) return 'zero-value'
  if (tokens.some((t) => !known(t) && t.amount === 0n)) return 'zero-value-unknown-token'
  if (tokens.length >= 20 && tokens.some((t) => !known(t))) return 'bulk-airdrop'
  const symbols = catalogSymbols(ctx.chainId)
  for (const t of tokens) {
    if (known(t) || !t.symbol) continue
    if (hasNonAscii(t.symbol)) return 'symbol-impersonation'
    const ascii = asciiSymbol(t.symbol)
    if (ascii && symbols.has(ascii)) return 'symbol-impersonation'
  }
  return undefined
}
