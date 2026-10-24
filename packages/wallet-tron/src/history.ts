/**
 * Activity history for Tron: a `HistorySource` over TronGrid's account
 * endpoints (`/v1/accounts/{a}/transactions` and `/transactions/trc20`),
 * merged into one `ChainTx` per txID, with the full-node
 * `/wallet/gettransactionbyid` + `/wallet/gettransactioninfobyid` for a single
 * transaction (exact fee, TRC-20 Transfer logs).
 *
 * Both lists page by `max_timestamp` (inclusive, ms), so a page is a time
 * window that is complete across both lists; the cursor carries the window's
 * lower edge plus the txIDs already emitted at exactly that timestamp. Keyless
 * TronGrid allows ~1 request/s per endpoint; pass `apiKey` for more.
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
const MAX_LIMIT = 200
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_URLS: Record<TronNetwork, string> = { mainnet: 'https://api.trongrid.io', shasta: 'https://api.shasta.trongrid.io', nile: 'https://nile.trongrid.io' }
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// ── Cursor: time window, base64 JSON ─────────────────────────────────────────

export interface TronHistoryCursor {
  v: 1
  /** `max_timestamp` (ms, inclusive) for the next page. */
  w: number
  /** txIDs already emitted at exactly `w`. */
  x: string[]
  /** Lists that returned their last row. */
  e: Array<'tx' | 'trc20'>
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
  if (!c || c.v !== 1 || typeof c.w !== 'number' || !Array.isArray(c.x) || !Array.isArray(c.e)) throw new Error('@anywalletkit/wallet-tron: malformed history cursor')
  return { v: 1, w: c.w, x: c.x.filter((x): x is string => typeof x === 'string'), e: c.e.filter((x): x is 'tx' | 'trc20' => x === 'tx' || x === 'trc20') }
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

interface Contract {
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

  async function list<T>(path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
    const q = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
    const body = (await request(`${path}?${q}`)) as { data?: T[] } | undefined
    return body?.data ?? []
  }

  return {
    chain,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<TronHistoryPage> {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      const exhausted = new Set<'tx' | 'trc20'>(cursor?.e ?? [])
      const skip = new Set(cursor?.x ?? [])
      const common: Record<string, string | number | undefined> = { limit, order_by: 'block_timestamp,desc', max_timestamp: cursor?.w }
      if (query.since !== undefined) common.min_timestamp = query.since * 1000
      const txRows = exhausted.has('tx') ? [] : await list<TronGridTx>(`/v1/accounts/${encodeURIComponent(address)}/transactions`, common)
      const trc20Rows = exhausted.has('trc20') ? [] : await list<TronGridTrc20>(`/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`, common)
      // A list that came back full has more below its last row: the window is complete only above the newest such tail.
      const tails: number[] = []
      if (!exhausted.has('tx') && txRows.length >= limit) tails.push(txRows[txRows.length - 1]!.block_timestamp ?? 0)
      if (!exhausted.has('trc20') && trc20Rows.length >= limit) tails.push(trc20Rows[trc20Rows.length - 1]!.block_timestamp)
      const cutoff = tails.length ? Math.max(...tails) : Number.NEGATIVE_INFINITY

      const byId = new Map<string, { ts: number; tx?: TronGridTx; trc20: TronGridTrc20[] }>()
      for (const r of txRows) {
        if (skip.has(r.txID)) continue
        const e = byId.get(r.txID) ?? { ts: r.block_timestamp ?? 0, trc20: [] }
        e.tx = r
        byId.set(r.txID, e)
      }
      for (const r of trc20Rows) {
        if (skip.has(r.transaction_id)) continue
        const e = byId.get(r.transaction_id) ?? { ts: r.block_timestamp, trc20: [] }
        e.trc20.push(r)
        byId.set(r.transaction_id, e)
      }
      let entries = [...byId.entries()].sort((a, b) => b[1].ts - a[1].ts)
      let inWindow = entries.filter(([, e]) => e.ts > cutoff)
      // Degenerate case: everything sits at the cutoff timestamp; emit those and remember them.
      if (inWindow.length === 0 && entries.length > 0) inWindow = entries.filter(([, e]) => e.ts === cutoff)
      entries = inWindow.slice(0, limit)
      const items = entries.map(([, e]) => (e.tx ? mapTransactionRow(chain, address, e.tx, { trc20: e.trc20 }) : mapTrc20Only(chain, address, e.trc20)))
      // A short list is finished only once every row it returned has been emitted (now or on an earlier page).
      const emitted = new Set(entries.map(([id]) => id))
      const done = (id: string) => emitted.has(id) || skip.has(id)
      if (!exhausted.has('tx') && txRows.length < limit && txRows.every((r) => done(r.txID))) exhausted.add('tx')
      if (!exhausted.has('trc20') && trc20Rows.length < limit && trc20Rows.every((r) => done(r.transaction_id))) exhausted.add('trc20')
      const page: TronHistoryPage = { items }
      const more = exhausted.size < 2
      if (more && entries.length > 0) {
        const last = entries[entries.length - 1]![1].ts
        const x = entries.filter(([, e]) => e.ts === last).map(([id]) => id)
        if (last === cursor?.w) for (const id of skip) x.push(id)
        page.cursor = encodeCursor({ v: 1, w: last, x, e: [...exhausted] })
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
