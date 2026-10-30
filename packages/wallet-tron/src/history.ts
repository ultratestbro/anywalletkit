/**
 * Activity history for Tron: a `HistorySource` over TronGrid's account
 * endpoints (`/v1/accounts/{a}/transactions` and `/transactions/trc20`),
 * merged into one `ChainTx` per txID, with the full-node
 * `/wallet/gettransactionbyid` + `/wallet/gettransactioninfobyid` for a single
 * transaction (exact fee, TRC-20 Transfer logs).
 *
 * Each list is read on its own continuation (TronGrid's `meta.fingerprint`):
 * the cursor holds, per list, the fingerprint of the page with its unread rows
 * and how many of them were already consumed. The rows of one transaction
 * share a block timestamp, so a timestamp's rows are read from both lists
 * together and merged by txID; when they do not fit the page, the cursor also
 * counts the transactions of that timestamp already emitted. Keyless TronGrid
 * allows ~1 request/s per endpoint; pass `apiKey` for more.
 * `fetch` + `AbortSignal.timeout` only — Hermes-safe.
 */
import type { ChainCall, ChainTransfer, ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { toBase58Address } from './address.js'
import { CAIP2_GENESIS } from './types.js'

// ── Public types ─────────────────────────────────────────────────────────────

/** The `fetch` shape the history source uses; pass your own for proxies or tests. */
export type HistoryFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Tron mainnet or the Shasta and Nile testnets. */
export type TronNetwork = 'mainnet' | 'shasta' | 'nile'

/** Options for {@link createTronHistory}. */
export interface TronHistoryOptions {
  /** TronGrid-compatible root. Default by network: `https://api.trongrid.io`, `https://api.shasta.trongrid.io`, `https://nile.trongrid.io`. */
  apiUrl?: string
  /** `TRON-PRO-API-KEY`. */
  apiKey?: string
  network?: TronNetwork
  fetch?: HistoryFetch
  /** Requests per second. Default 1 without a key (TronGrid's keyless limit), 10 with one. */
  rateLimit?: number
  /** Per request, ms. Default 15 000. */
  timeoutMs?: number
}

export interface TronHistoryRaw {
  /** The `/transactions` row (absent when only a TRC-20 transfer to the address was indexed). */
  tx?: unknown
  /** `/transactions/trc20` rows for this txID. */
  trc20: unknown[]
  /** `/wallet/gettransactioninfobyid` (single-transaction reads only). */
  info?: unknown
  spam?: true
  spamReason?: string
}

export interface TronChainTx extends ChainTx {
  raw: TronHistoryRaw
}

export interface TronHistoryPage extends HistoryPage {
  items: TronChainTx[]
}

/**
 * Tron history from TronGrid's account endpoints (TRX and TRC-20). Build it with {@link
 * createTronHistory}.
 */
export interface TronHistorySource extends HistorySource {
  listActivity(address: string, query?: HistoryQuery): Promise<TronHistoryPage>
  getTransaction(hash: string, address: string): Promise<TronChainTx | undefined>
}

/** Every configured TronGrid endpoint failed. */
export class HistoryUnavailableError extends Error {
  readonly chain: string
  readonly reason: string
  readonly attempts: readonly string[]
  constructor(chain: string, reason: string, attempts: readonly string[] = []) {
    super(`History unavailable for ${chain}: ${reason}`)
    this.name = 'HistoryUnavailableError'
    this.chain = chain
    this.reason = reason
    this.attempts = attempts
  }
}

const DEFAULT_LIMIT = 25
/** Rows asked of the API per request at least, so a small `limit` does not cost one request per row. */
const MIN_PAGE = 20
/** Pages one list may fetch in one call: far beyond one block timestamp of one address, a bound on a runaway API. */
const MAX_PAGES_PER_CALL = 500
const MAX_LIMIT = 200
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_URLS: Record<TronNetwork, string> = { mainnet: 'https://api.trongrid.io', shasta: 'https://api.shasta.trongrid.io', nile: 'https://nile.trongrid.io' }
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// ── Cursor: a position per list, base64 JSON ─────────────────────────────────

/** Where a list's unread rows start: the page (by the fingerprint that fetched it; absent = the first page) and rows of it already consumed. */
export interface TronListPosition {
  f?: string
  k: number
}

export interface TronHistoryCursor {
  v: 2
  /** Rows per API request the positions were taken with: a fingerprint's page is only the same page at the same size. */
  n: number
  /** Per list, where its unread rows start; `null` once the list is read to the end. */
  s: { tx: TronListPosition | null; trc20: TronListPosition | null }
  /** Block timestamp (ms) whose transactions were only partly emitted; both positions point at its first row. */
  t?: number
  /** How many of `t`'s transactions (in txID order) were already emitted. */
  g?: number
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64encode(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i += 3) {
    const c = [s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2)]
    for (const x of c) if (x > 0xff) throw new Error('cursor must be ASCII')
    const n = (c[0]! << 16) | ((c[1]! || 0) << 8) | (c[2]! || 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (Number.isNaN(c[1]) ? '=' : B64[(n >> 6) & 63]!) + (Number.isNaN(c[2]) ? '=' : B64[n & 63]!)
  }
  return out
}

function b64decode(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  let out = ''
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]!) : -1))
    if (c[0]! < 0 || c[1]! < 0) throw new Error('bad base64')
    const n = (c[0]! << 18) | (c[1]! << 12) | ((c[2]! < 0 ? 0 : c[2]!) << 6) | (c[3]! < 0 ? 0 : c[3]!)
    out += String.fromCharCode((n >> 16) & 0xff)
    if (c[2]! >= 0) out += String.fromCharCode((n >> 8) & 0xff)
    if (c[3]! >= 0) out += String.fromCharCode(n & 0xff)
  }
  return out
}

export function encodeCursor(c: TronHistoryCursor): string {
  return b64encode(JSON.stringify(c))
}

export function decodeCursor(s: string): TronHistoryCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(b64decode(s))
  } catch {
    throw new Error('@anywalletkit/wallet-tron: malformed history cursor')
  }
  const c = parsed as Partial<TronHistoryCursor> | null
  const pos = (p: unknown): TronListPosition | null | undefined => {
    if (p === null) return null
    const q = p as Partial<TronListPosition> | undefined
    if (!q || typeof q.k !== 'number' || !Number.isInteger(q.k) || q.k < 0 || (q.f !== undefined && typeof q.f !== 'string')) return undefined
    return q.f === undefined ? { k: q.k } : { f: q.f, k: q.k }
  }
  const tx = pos(c?.s?.tx), trc20 = pos(c?.s?.trc20)
  const n = c?.n
  if (!c || c.v !== 2 || tx === undefined || trc20 === undefined || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new Error('@anywalletkit/wallet-tron: malformed history cursor')
  }
  const out: TronHistoryCursor = { v: 2, n, s: { tx, trc20 } }
  if (typeof c.t === 'number' && typeof c.g === 'number' && Number.isInteger(c.g) && c.g > 0) { out.t = c.t; out.g = c.g }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number
  private last = Date.now()
  private chain: Promise<void> = Promise.resolve()
  constructor(private readonly rate: number, private readonly burst = Math.max(1, Math.ceil(rate))) {
    this.tokens = burst
  }
  acquire(): Promise<void> {
    const next = this.chain.then(() => this.take())
    this.chain = next.catch(() => undefined)
    return next
  }
  private refill(): void {
    const now = Date.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
  }
  private async take(): Promise<void> {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.rate) * 1000)))
    this.refill()
    this.tokens = Math.max(0, this.tokens - 1)
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } }).AbortSignal
  return typeof ctor?.timeout === 'function' ? ctor.timeout(ms) : undefined
}

const big = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  return 0n
}

/** Hex `41…` (or base58) → base58; anything unparsable is returned as-is. */
const b58 = (a: unknown): string | undefined => {
  if (typeof a !== 'string' || a.length === 0) return undefined
  try {
    return toBase58Address(a)
  } catch {
    return a
  }
}

/** 32-byte ABI word → base58 address. */
const wordToAddress = (word: string): string => toBase58Address('41' + word.slice(-40).toLowerCase())

// ── TronGrid shapes ──────────────────────────────────────────────────────────

export interface Contract {
  type: string
  parameter: { value: Record<string, unknown> }
}
export interface TronGridTx {
  txID: string
  ret?: Array<{ contractRet?: string; fee?: number }>
  net_fee?: number
  energy_fee?: number
  blockNumber?: number
  block_timestamp?: number
  internal_transactions?: Array<{ caller_address?: string; transferTo_address?: string; callValueInfo?: Array<{ callValue?: number; tokenId?: string }>; rejected?: boolean }>
  raw_data: { contract: Contract[]; data?: string; timestamp?: number }
}
export interface TronGridTrc20 {
  transaction_id: string
  token_info: { symbol?: string; address: string; decimals?: number; name?: string }
  block_timestamp: number
  from: string
  to: string
  type: string
  value: string
}
export interface FullNodeTxInfo {
  id?: string
  fee?: number
  blockNumber?: number
  blockTimeStamp?: number
  receipt?: { result?: string; net_fee?: number; energy_fee?: number }
  log?: Array<{ address: string; topics: string[]; data?: string }>
}

const SELF_TYPES_WITH_RECEIVER: Record<string, string> = {
  DelegateResourceContract: 'receiver_address',
  UnDelegateResourceContract: 'receiver_address',
  AccountPermissionUpdateContract: 'owner_address',
}

/** Decode what a TronGrid / full-node transaction row says on its own (no TRC-20 list rows yet). */
export function mapTransactionRow(chain: string, address: string, tx: TronGridTx, extra: { trc20?: TronGridTrc20[]; info?: FullNodeTxInfo } = {}): TronChainTx {
  const contract = tx.raw_data.contract[0]
  const v = contract?.parameter.value ?? {}
  const type = contract?.type ?? 'Unknown'
  const owner = b58(v.owner_address) ?? address
  const transfers: ChainTransfer[] = []
  let call: ChainCall | undefined
  let to: string | null = null
  let nativeValue = 0n
  switch (type) {
    case 'TransferContract': {
      to = b58(v.to_address) ?? null
      nativeValue = big(v.amount)
      if (to && nativeValue > 0n) transfers.push({ token: null, from: owner, to, amount: nativeValue })
      break
    }
    case 'TransferAssetContract': {
      to = b58(v.to_address) ?? null
      const asset = typeof v.asset_name === 'string' ? v.asset_name : undefined
      const amount = big(v.amount)
      // TRC-10 assets are known only by numeric id here (no symbol / decimals without getassetissuebyid); the amount is raw units.
      if (to && asset && amount > 0n) transfers.push({ token: asset, from: owner, to, amount, symbol: `TRC-10 #${asset}`, decimals: 0 })
      break
    }
    case 'TriggerSmartContract': {
      const contractAddress = b58(v.contract_address)
      nativeValue = big(v.call_value)
      if (contractAddress) {
        to = contractAddress
        call = { to: contractAddress }
        const data = typeof v.data === 'string' ? v.data.toLowerCase() : ''
        if (data.length >= 8) {
          call.selector = `0x${data.slice(0, 8)}`
          call.data = `0x${data}`
        }
        if (nativeValue > 0n) transfers.push({ token: null, from: owner, to: contractAddress, amount: nativeValue })
      }
      break
    }
    default: {
      // Staking / resource / permission system contracts: the owner acts on itself (or a receiver).
      const receiverKey = SELF_TYPES_WITH_RECEIVER[type]
      const receiver = receiverKey ? b58(v[receiverKey]) : undefined
      call = { to: receiver ?? owner, method: type }
      to = receiver ?? owner
    }
  }
  for (const it of tx.internal_transactions ?? []) {
    if (it.rejected) continue
    const from = b58(it.caller_address), dest = b58(it.transferTo_address)
    if (!from || !dest) continue
    for (const cv of it.callValueInfo ?? []) {
      const amount = big(cv.callValue)
      if (amount > 0n && !cv.tokenId) transfers.push({ token: null, from, to: dest, amount })
    }
  }
  // TRC-20 legs: list rows first; else Transfer logs from the full node; else the calldata of a plain `transfer(address,uint256)`.
  const trc20 = extra.trc20 ?? []
  if (trc20.length > 0) {
    for (const row of trc20) if (row.type === 'Transfer') transfers.push(trc20Transfer(row))
  } else if (extra.info?.log && extra.info.log.length > 0) {
    for (const log of extra.info.log) {
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue
      transfers.push({ token: toBase58Address('41' + log.address.toLowerCase().slice(-40)), from: wordToAddress(log.topics[1]!), to: wordToAddress(log.topics[2]!), amount: BigInt(`0x${log.data || '0'}`), standard: 'trc20' })
    }
  } else if (call?.selector === '0xa9059cbb' && call.data && call.data.length >= 2 + 8 + 128) {
    const words = call.data.slice(10)
    transfers.push({ token: call.to, from: owner, to: wordToAddress(words.slice(0, 64)), amount: BigInt(`0x${words.slice(64, 128)}`), standard: 'trc20' })
  }
  if (call?.selector === '0xa9059cbb' && !call.method) call.method = 'transfer'
  const ret = tx.ret?.[0]
  const result = extra.info?.receipt?.result ?? ret?.contractRet
  const status: ChainTx['status'] = result === undefined ? (tx.blockNumber ? 'confirmed' : 'pending') : result === 'SUCCESS' ? 'confirmed' : 'failed'
  const feeNum = extra.info?.fee ?? (typeof ret?.fee === 'number' ? ret.fee : undefined) ?? (tx.net_fee !== undefined || tx.energy_fee !== undefined ? (tx.net_fee ?? 0) + (tx.energy_fee ?? 0) : undefined)
  const ts = tx.block_timestamp ?? extra.info?.blockTimeStamp ?? tx.raw_data.timestamp
  const blockNumber = tx.blockNumber ?? extra.info?.blockNumber
  const raw: TronHistoryRaw = { tx, trc20 }
  // Unsolicited TRC-10 airdrops (the sender is a stranger, the asset a numeric id) are the chain's spam channel.
  if (contract?.type === 'TransferAssetContract' && owner !== address && to === address) { raw.spam = true; raw.spamReason = 'trc10-airdrop' }
  if (extra.info) raw.info = extra.info
  const out: TronChainTx = { chain, hash: tx.txID, time: ts ? Math.floor(ts / 1000) : 0, status, address, from: owner, to: call?.to ?? to, nativeValue, transfers, raw }
  if (feeNum !== undefined) out.fee = BigInt(Math.trunc(feeNum))
  if (call) out.call = call
  if (blockNumber !== undefined) out.block = BigInt(blockNumber)
  return out
}

function trc20Transfer(row: TronGridTrc20): ChainTransfer {
  const t: ChainTransfer = { token: row.token_info.address, from: row.from, to: row.to, amount: big(row.value), standard: 'trc20' }
  if (row.token_info.symbol !== undefined) t.symbol = row.token_info.symbol
  if (row.token_info.decimals !== undefined) t.decimals = row.token_info.decimals
  return t
}

/** A transaction seen only through the TRC-20 list (someone else's call that moved tokens to / from the address). */
export function mapTrc20Only(chain: string, address: string, rows: TronGridTrc20[]): TronChainTx {
  const first = rows[0]!
  const transfers = rows.filter((r) => r.type === 'Transfer').map(trc20Transfer)
  const primary = transfers.find((t) => t.from === address || t.to === address) ?? transfers[0]
  const out: TronChainTx = {
    chain, hash: first.transaction_id, time: Math.floor(first.block_timestamp / 1000), status: 'confirmed', address,
    from: primary?.from ?? first.from, to: primary?.to ?? first.to, nativeValue: 0n, transfers, raw: { trc20: rows },
  }
  if (transfers.length === 0) {
    // Approval-only rows: the token contract was called.
    out.call = { to: first.token_info.address, method: first.type.toLowerCase() }
    out.to = first.token_info.address
  }
  return out
}

// ── Source ───────────────────────────────────────────────────────────────────

/** Tronscan link for a transaction. */
export function tronExplorerTxUrl(hash: string, network: TronNetwork = 'mainnet'): string {
  const host = network === 'mainnet' ? 'tronscan.org' : `${network}.tronscan.org`
  return `https://${host}/#/transaction/${hash}`
}

/** A history source for Tron addresses backed by TronGrid or a compatible API. */
export function createTronHistory(options: TronHistoryOptions = {}): TronHistorySource {
  const network = options.network ?? 'mainnet'
  const chain = CAIP2_GENESIS[network] ?? CAIP2_GENESIS.mainnet!
  const apiUrl = (options.apiUrl ?? DEFAULT_URLS[network]).replace(/\/+$/, '')
  const fetchFn: HistoryFetch = options.fetch ?? ((globalThis as { fetch?: HistoryFetch }).fetch as HistoryFetch)
  if (typeof fetchFn !== 'function') throw new Error('@anywalletkit/wallet-tron: no global fetch; pass `fetch` in the options')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const bucket = new TokenBucket(options.rateLimit ?? (options.apiKey ? 10 : 1))
  const headers = (): Record<string, string> => ({ accept: 'application/json', ...(options.apiKey ? { 'TRON-PRO-API-KEY': options.apiKey } : {}) })

  async function request(path: string, init?: { method: 'POST'; body: unknown }): Promise<unknown> {
    await bucket.acquire()
    const url = `${apiUrl}${path}`
    let res: Awaited<ReturnType<HistoryFetch>>
    try {
      const signal = timeoutSignal(timeoutMs)
      res = await fetchFn(url, {
        ...(init ? { method: 'POST', body: JSON.stringify(init.body) } : {}),
        headers: { ...headers(), ...(init ? { 'content-type': 'application/json' } : {}) },
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      throw new HistoryUnavailableError(chain, `${path}: ${e instanceof Error ? e.message : String(e)}`, [`trongrid: ${e instanceof Error ? e.message : String(e)}`])
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    const b = body as { success?: boolean; error?: string; Error?: string; statusCode?: number } | undefined
    if (!res.ok || b?.success === false || typeof b?.Error === 'string') {
      const msg = b?.error ?? b?.Error ?? `HTTP ${res.status}`
      throw new HistoryUnavailableError(chain, `${path}: ${msg}`, [`trongrid: HTTP ${res.status} ${msg}`])
    }
    return body
  }

  async function list<T>(path: string, params: Record<string, string | number | undefined>): Promise<{ data: T[]; next?: string }> {
    const q = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
    const body = (await request(`${path}?${q}`)) as { data?: T[]; meta?: { fingerprint?: unknown } } | undefined
    const data = body?.data ?? []
    const next = typeof body?.meta?.fingerprint === 'string' && body.meta.fingerprint && data.length > 0 ? body.meta.fingerprint : undefined
    return next ? { data, next } : { data }
  }

  /**
   * One list read in order from `at` (null = already read to the end), page by page along
   * `meta.fingerprint`. `position()` is where its unread rows start, for the cursor.
   */
  function stream<T>(path: string, params: Record<string, string | number | undefined>, at: TronListPosition | null, ts: (row: T) => number) {
    let pos: TronListPosition | null = at
    let rows: T[] | undefined
    let next: string | undefined
    const fetched = new Set<string>()
    const fill = async (): Promise<T | undefined> => {
      while (pos) {
        if (!rows) {
          // A fingerprint this call already followed means the API is not advancing (a gateway that
          // drops the parameter answers the first page again): the list ends here instead of looping.
          if (pos.f !== undefined && fetched.has(pos.f)) { pos = null; break }
          // Never end a list early on the bound: fail the call and leave the cursor where it was.
          if (fetched.size >= MAX_PAGES_PER_CALL) throw new HistoryUnavailableError(chain, `${path}: more than ${MAX_PAGES_PER_CALL} pages in one call`)
          if (pos.f !== undefined) fetched.add(pos.f)
          const page = await list<T>(path, pos.f === undefined ? params : { ...params, fingerprint: pos.f })
          if (pos.f !== undefined && page.next === pos.f) { pos = null; break }
          // Every row's timestamp is checked once, here: a missing, string or fractional one would never
          // equal the merge's block timestamp and the merge would spin on cached rows (scan 2026-10-30 F14).
          if (!Array.isArray(page.data)) throw new HistoryUnavailableError(chain, `${path}: data is not a list`)
          for (const r of page.data) {
            const t = ts(r)
            if (!Number.isSafeInteger(t) || t < 0) throw new HistoryUnavailableError(chain, `${path}: malformed block_timestamp`)
          }
          rows = page.data
          next = page.next
        }
        if (pos.k < rows.length) return rows[pos.k]
        if (next === undefined) { pos = null; break }
        pos = { f: next, k: 0 }
        rows = undefined
      }
      return undefined
    }
    return {
      /** Timestamp of the next unread row, or -∞ at the end. */
      async peekTs(): Promise<number> {
        const r = await fill()
        return r === undefined ? Number.NEGATIVE_INFINITY : ts(r)
      },
      /** Consume every next row at timestamp `t`, across page boundaries. */
      async takeAt(t: number): Promise<T[]> {
        const out: T[] = []
        for (let r = await fill(); r !== undefined && ts(r) === t; r = await fill()) {
          out.push(r)
          pos = { ...pos!, k: pos!.k + 1 }
        }
        return out
      },
      position(): TronListPosition | null {
        return pos ? { ...pos } : null
      },
    }
  }

  return {
    chain,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<TronHistoryPage> {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      // The API page size is the cursor's: its positions are offsets into pages of that size.
      const pageSize = cursor?.n ?? Math.max(limit, MIN_PAGE)
      const common: Record<string, string | number | undefined> = { limit: pageSize, order_by: 'block_timestamp,desc' }
      if (query.since !== undefined) common.min_timestamp = query.since * 1000
      const base = `/v1/accounts/${encodeURIComponent(address)}/transactions`
      const txs = stream<TronGridTx>(base, common, cursor ? cursor.s.tx : { k: 0 }, (r) => r.block_timestamp ?? 0)
      const trc20 = stream<TronGridTrc20>(`${base}/trc20`, common, cursor ? cursor.s.trc20 : { k: 0 }, (r) => r.block_timestamp)

      const items: TronChainTx[] = []
      let resume: { t: number; g: number } | undefined = cursor?.t !== undefined ? { t: cursor.t, g: cursor.g ?? 0 } : undefined
      while (items.length < limit) {
        const t = Math.max(await txs.peekTs(), await trc20.peekTs())
        if (t === Number.NEGATIVE_INFINITY) break
        // One block timestamp at a time, from both lists: every row of a transaction shares it.
        const startTx = txs.position(), startTrc20 = trc20.position()
        const byId = new Map<string, { tx?: TronGridTx; trc20: TronGridTrc20[] }>()
        const takenTx = await txs.takeAt(t), takenTrc20 = await trc20.takeAt(t)
        // Each pass consumes at least one row; one that consumes none would repeat forever.
        if (takenTx.length + takenTrc20.length === 0) throw new HistoryUnavailableError(chain, `${base}: history merge made no progress`)
        for (const r of takenTx) byId.set(r.txID, { ...byId.get(r.txID), tx: r, trc20: byId.get(r.txID)?.trc20 ?? [] })
        for (const r of takenTrc20) { const e = byId.get(r.transaction_id) ?? { trc20: [] }; e.trc20.push(r); byId.set(r.transaction_id, e) }
        // txID order: the same block reads the same way on every call, whatever order each list gave.
        const groups = [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        const done = resume?.t === t ? resume.g : 0
        resume = undefined
        const room = limit - items.length
        const emit = groups.slice(done, done + room)
        for (const [, e] of emit) items.push(e.tx ? mapTransactionRow(chain, address, e.tx, { trc20: e.trc20 }) : mapTrc20Only(chain, address, e.trc20))
        if (done + emit.length < groups.length) {
          // The block did not fit: come back to its first row and skip what was emitted.
          return { items, cursor: encodeCursor({ v: 2, n: pageSize, s: { tx: startTx, trc20: startTrc20 }, t, g: done + emit.length }) }
        }
      }
      const page: TronHistoryPage = { items }
      // Look ahead (cached pages, no extra request when the page is in hand) so the last page has no cursor.
      if (Math.max(await txs.peekTs(), await trc20.peekTs()) !== Number.NEGATIVE_INFINITY) {
        page.cursor = encodeCursor({ v: 2, n: pageSize, s: { tx: txs.position(), trc20: trc20.position() } })
      }
      return page
    },

    async getTransaction(hash: string, address: string): Promise<TronChainTx | undefined> {
      const tx = (await request('/wallet/gettransactionbyid', { method: 'POST', body: { value: hash } })) as TronGridTx | Record<string, never> | undefined
      if (!tx || typeof (tx as TronGridTx).txID !== 'string') return undefined
      const info = (await request('/wallet/gettransactioninfobyid', { method: 'POST', body: { value: hash } })) as FullNodeTxInfo | undefined
      return mapTransactionRow(chain, address, tx as TronGridTx, info && typeof info.id === 'string' ? { info } : {})
    },

    explorerTxUrl(hash: string): string {
      return tronExplorerTxUrl(hash, network)
    },
  }
}
