/**
 * Activity history for Solana: a `HistorySource` over plain JSON-RPC
 * (`getSignaturesForAddress` → `getTransaction` jsonParsed), no indexer.
 *
 * The wallet's own signatures and those of every token account it owns
 * (`getTokenAccountsByOwner` for Token and Token-2022, cached per address) are
 * merged into one newest-first list; transactions are fetched in JSON-RPC
 * batches of ≤10 behind a token bucket. Transfers come from balance deltas
 * (`preBalances`/`postBalances` for SOL, `pre`/`postTokenBalances` by owner
 * for SPL / Token-2022), so programs the parser does not know still produce
 * correct movements. `fetch` + `AbortSignal.timeout` only — Hermes-safe.
 */
import type { ChainCall, ChainTransfer, ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { CAIP2_GENESIS } from './types.js'

// ── Public types ─────────────────────────────────────────────────────────────

/** The subset of WHATWG `fetch` this module uses; inject for tests / custom transports. */
export type HistoryFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface SolanaHistoryOptions {
  /** One JSON-RPC endpoint. */
  rpcUrl?: string
  /** Several endpoints, tried in order per request (failover). */
  rpcUrls?: string[]
  /** `mainnet` (default), `devnet`, `testnet` — picks the CAIP-2 id and the explorer cluster. */
  network?: 'mainnet' | 'devnet' | 'testnet'
  fetch?: HistoryFetch
  /** RPC requests per second (a batch counts as one request). Default 5. */
  rateLimit?: number
  /** Per request, ms. Default 15 000. */
  timeoutMs?: number
  /** `getTransaction` calls per JSON-RPC batch, 1–10. Default 10. */
  batchSize?: number
  /** Token accounts included in the merge (the wallet itself is always included). Default 50. */
  maxTokenAccounts?: number
}

/** What the `ChainTx` was built from. */
export interface SolanaHistoryRaw {
  /** The `getSignaturesForAddress` row. */
  signature: SignatureRow
  /** The `getTransaction` result (jsonParsed), or null when the node no longer has it. */
  tx: unknown
  /** Program log messages when the node returned them. */
  logs?: string[]
}

export interface SolanaChainTx extends ChainTx {
  raw: SolanaHistoryRaw
}

export interface SolanaHistoryPage extends HistoryPage {
  items: SolanaChainTx[]
}

export interface SolanaHistorySource extends HistorySource {
  listActivity(address: string, query?: HistoryQuery): Promise<SolanaHistoryPage>
  getTransaction(hash: string, address: string): Promise<SolanaChainTx | undefined>
  /** Token accounts (both programs) merged into the address's history; cached per address. */
  tokenAccounts(address: string): Promise<string[]>
}

/** Every configured RPC failed (or none was configured). */
export class HistoryUnavailableError extends Error {
  readonly chain: string
  readonly reason: string
  /** One line per endpoint tried, in order. */
  readonly attempts: readonly string[]
  constructor(chain: string, reason: string, attempts: readonly string[] = []) {
    super(`History unavailable for ${chain}: ${reason}`)
    this.name = 'HistoryUnavailableError'
    this.chain = chain
    this.reason = reason
    this.attempts = attempts
  }
}

// ── Program ids ──────────────────────────────────────────────────────────────

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const MEMO_PROGRAMS = ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']
/** Programs that never are "the contract you called": fee/compute plumbing, memos, token plumbing. */
const PLUMBING = new Set([SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ...MEMO_PROGRAMS])

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 15_000

// ── RPC shapes (only what the mapper reads) ──────────────────────────────────

export interface SignatureRow {
  signature: string
  slot: number
  blockTime?: number | null
  err?: unknown
  memo?: string | null
}

interface ParsedInstruction {
  programId: string
  program?: string
  parsed?: unknown
  data?: string
  accounts?: string[]
}

interface TokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  programId?: string
  uiTokenAmount: { amount: string; decimals: number }
}

interface ParsedTransaction {
  slot: number
  blockTime?: number | null
  version?: unknown
  transaction: {
    signatures: string[]
    message: { accountKeys: Array<{ pubkey: string } | string>; instructions: ParsedInstruction[] }
  }
  meta: {
    err: unknown
    fee: number
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: TokenBalance[] | null
    postTokenBalances?: TokenBalance[] | null
    innerInstructions?: Array<{ index: number; instructions: ParsedInstruction[] }> | null
    logMessages?: string[] | null
  } | null
}

// ── Cursor: per-list `before` signatures, base64 JSON ────────────────────────

interface PageCursor {
  v: 1
  /** list address → `before` signature; `null` = exhausted. */
  l: Record<string, string | null>
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

export function encodeCursor(c: PageCursor): string {
  return b64encode(JSON.stringify(c))
}

export function decodeCursor(s: string): PageCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(b64decode(s))
  } catch {
    throw new Error('@anywalletkit/wallet-solana: malformed history cursor')
  }
  const c = parsed as Partial<PageCursor> | null
  if (!c || c.v !== 1 || typeof c.l !== 'object' || c.l === null) throw new Error('@anywalletkit/wallet-solana: malformed history cursor')
  return { v: 1, l: c.l }
}

// ── Token bucket (Date.now + setTimeout only) ────────────────────────────────

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

// ── Mapping ──────────────────────────────────────────────────────────────────

const keyOf = (k: { pubkey: string } | string): string => (typeof k === 'string' ? k : k.pubkey)

/**
 * Pair senders with receivers greedily (largest first). Leftover receivers are
 * attributed to `mintFrom` (mint / unknown source), leftover senders to
 * `burnTo` — for native SOL both are absent and leftovers are dropped.
 */
function pairDeltas(deltas: Map<string, bigint>, make: (from: string, to: string, amount: bigint) => ChainTransfer, mintFrom?: string, burnTo?: string): ChainTransfer[] {
  const senders: Array<{ a: string; v: bigint }> = []
  const receivers: Array<{ a: string; v: bigint }> = []
  for (const [a, v] of deltas) {
    if (v < 0n) senders.push({ a, v: -v })
    else if (v > 0n) receivers.push({ a, v })
  }
  senders.sort((x, y) => (y.v > x.v ? 1 : y.v < x.v ? -1 : 0))
  receivers.sort((x, y) => (y.v > x.v ? 1 : y.v < x.v ? -1 : 0))
  const out: ChainTransfer[] = []
  let i = 0, j = 0
  while (i < senders.length && j < receivers.length) {
    const s = senders[i]!, r = receivers[j]!
    const x = s.v < r.v ? s.v : r.v
    out.push(make(s.a, r.a, x))
    s.v -= x
    r.v -= x
    if (s.v === 0n) i++
    if (r.v === 0n) j++
  }
  if (mintFrom !== undefined) for (; j < receivers.length; j++) out.push(make(mintFrom, receivers[j]!.a, receivers[j]!.v))
  if (burnTo !== undefined) for (; i < senders.length; i++) out.push(make(senders[i]!.a, burnTo, senders[i]!.v))
  return out
}

/** Native SOL movements from the lamport deltas, fee added back to the payer so sends match what the user typed. */
export function nativeTransfers(tx: ParsedTransaction): ChainTransfer[] {
  const meta = tx.meta
  if (!meta) return []
  const keys = tx.transaction.message.accountKeys.map(keyOf)
  const deltas = new Map<string, bigint>()
  for (let i = 0; i < keys.length; i++) {
    const pre = meta.preBalances[i], post = meta.postBalances[i]
    if (pre === undefined || post === undefined) continue
    let d = BigInt(post) - BigInt(pre)
    if (i === 0) d += BigInt(meta.fee)
    if (d !== 0n) deltas.set(keys[i]!, (deltas.get(keys[i]!) ?? 0n) + d)
  }
  return pairDeltas(deltas, (from, to, amount) => ({ token: null, from, to, amount }))
}

/** SPL / Token-2022 movements per mint from the token balance deltas, attributed to the token accounts' owners. */
export function tokenTransfers(tx: ParsedTransaction): ChainTransfer[] {
  const meta = tx.meta
  if (!meta) return []
  const keys = tx.transaction.message.accountKeys.map(keyOf)
  interface Acct { owner: string; mint: string; decimals: number; programId?: string; pre: bigint; post: bigint }
  const accts = new Map<number, Acct>()
  const seed = (b: TokenBalance, which: 'pre' | 'post') => {
    let a = accts.get(b.accountIndex)
    if (!a) {
      a = { owner: b.owner ?? keys[b.accountIndex] ?? String(b.accountIndex), mint: b.mint, decimals: b.uiTokenAmount.decimals, pre: 0n, post: 0n }
      if (b.programId !== undefined) a.programId = b.programId
      accts.set(b.accountIndex, a)
    }
    a[which] = BigInt(b.uiTokenAmount.amount)
  }
  for (const b of meta.preTokenBalances ?? []) seed(b, 'pre')
  for (const b of meta.postTokenBalances ?? []) seed(b, 'post')
  const byMint = new Map<string, { deltas: Map<string, bigint>; decimals: number; programId?: string }>()
  for (const a of accts.values()) {
    const d = a.post - a.pre
    if (d === 0n) continue
    let m = byMint.get(a.mint)
    if (!m) {
      m = { deltas: new Map(), decimals: a.decimals }
      if (a.programId !== undefined) m.programId = a.programId
      byMint.set(a.mint, m)
    }
    m.deltas.set(a.owner, (m.deltas.get(a.owner) ?? 0n) + d)
  }
  const out: ChainTransfer[] = []
  for (const [mint, m] of byMint) {
    const standard: ChainTransfer['standard'] = m.programId === TOKEN_2022_PROGRAM ? 'token2022' : 'spl'
    out.push(...pairDeltas(m.deltas, (from, to, amount) => ({ token: mint, from, to, amount, standard, decimals: m.decimals }), mint, mint))
  }
  return out
}

/** Top-level instruction program ids, then inner ones; `to` = the first program that is not plumbing; `data` = that program's first instruction data (base58). */
export function callOf(tx: ParsedTransaction): ChainCall | undefined {
  const top = tx.transaction.message.instructions
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)
  const all = [...top, ...inner]
  if (all.length === 0) return undefined
  const programs = all.map((ix) => ix.programId)
  const target = all.find((ix) => !PLUMBING.has(ix.programId))
  if (!target) return undefined
  const call: ChainCall = { to: target.programId, programs }
  if (typeof target.data === 'string' && target.data.length > 0) call.data = target.data
  return call
}

export function mapTransaction(chain: string, address: string, row: SignatureRow, tx: ParsedTransaction | null): SolanaChainTx {
  const raw: SolanaHistoryRaw = { signature: row, tx }
  if (!tx || !tx.meta) {
    const out: SolanaChainTx = {
      chain, hash: row.signature, time: row.blockTime ?? 0, status: row.err ? 'failed' : 'confirmed', address, from: address, to: null,
      nativeValue: 0n, transfers: [], block: BigInt(row.slot), raw,
    }
    return out
  }
  if (tx.meta.logMessages) raw.logs = tx.meta.logMessages
  const keys = tx.transaction.message.accountKeys.map(keyOf)
  const from = keys[0] ?? address
  const transfers = [...nativeTransfers(tx), ...tokenTransfers(tx)]
  const call = callOf(tx)
  // Primary destination of a plain transfer: the token leg involving the wallet first (its rent-funded ATA is noise), else the SOL leg.
  const involves = (t: ChainTransfer) => t.from === address || t.to === address
  const primary = transfers.find((t) => t.token !== null && involves(t)) ?? transfers.find(involves) ?? transfers[0]
  const to = call?.to ?? primary?.to ?? null
  let nativeValue = 0n
  if (!call) for (const t of transfers) if (t.token === null && t.from === from) nativeValue += t.amount
  const out: SolanaChainTx = {
    chain, hash: tx.transaction.signatures[0] ?? row.signature, time: tx.blockTime ?? row.blockTime ?? 0,
    status: tx.meta.err ? 'failed' : 'confirmed', address, from, to, nativeValue, transfers, fee: BigInt(tx.meta.fee), block: BigInt(tx.slot), raw,
  }
  if (call) out.call = call
  return out
}

// ── Source ───────────────────────────────────────────────────────────────────

export function solanaExplorerTxUrl(hash: string, network: 'mainnet' | 'devnet' | 'testnet' = 'mainnet'): string {
  return `https://solscan.io/tx/${hash}${network === 'mainnet' ? '' : `?cluster=${network}`}`
}

/**
 * A `HistorySource` for Solana over JSON-RPC. Pages merge the wallet's own
 * signatures with those of its token accounts (newest slot first); the cursor
 * holds one `before` signature per list, so pagination is exact even when a
 * transaction touches several of them.
 */
export function createSolanaHistory(options: SolanaHistoryOptions = {}): SolanaHistorySource {
  const network = options.network ?? 'mainnet'
  const chain = CAIP2_GENESIS[network] ?? CAIP2_GENESIS.mainnet!
  const urls = [...(options.rpcUrls ?? []), ...(options.rpcUrl ? [options.rpcUrl] : [])]
  if (urls.length === 0) throw new Error('@anywalletkit/wallet-solana: createSolanaHistory needs rpcUrl or rpcUrls')
  const fetchFn: HistoryFetch = options.fetch ?? ((globalThis as { fetch?: HistoryFetch }).fetch as HistoryFetch)
  if (typeof fetchFn !== 'function') throw new Error('@anywalletkit/wallet-solana: no global fetch; pass `fetch` in the options')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const bucket = new TokenBucket(options.rateLimit ?? 5)
  const batchSize = Math.min(10, Math.max(1, Math.floor(options.batchSize ?? 10)))
  const maxTokenAccounts = Math.max(0, Math.floor(options.maxTokenAccounts ?? 50))
  const tokenAccountCache = new Map<string, Promise<string[]>>()

  /** One JSON-RPC request (single or batch) with failover across the endpoints. JSON-RPC errors are definitive and thrown as-is. */
  async function post(body: unknown): Promise<unknown> {
    await bucket.acquire()
    const attempts: string[] = []
    for (const url of urls) {
      try {
        const signal = timeoutSignal(timeoutMs)
        const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
        if (res.status === 429 || res.status >= 500) {
          attempts.push(`${url}: HTTP ${res.status}`)
          continue
        }
        let json: unknown
        try {
          json = await res.json()
        } catch {
          attempts.push(`${url}: HTTP ${res.status}, non-JSON body`)
          continue
        }
        if (!res.ok) {
          attempts.push(`${url}: HTTP ${res.status}`)
          continue
        }
        return json
      } catch (e) {
        attempts.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    throw new HistoryUnavailableError(chain, attempts[attempts.length - 1] ?? 'every RPC failed', attempts)
  }

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const json = (await post({ jsonrpc: '2.0', id: 1, method, params })) as { result?: T; error?: { code?: number; message?: string } }
    if (json.error) throw new Error(`${method}: ${json.error.message ?? 'RPC error'} (${json.error.code ?? '?'})`)
    return json.result as T
  }

  async function rpcBatch<T>(calls: Array<{ method: string; params: unknown[] }>): Promise<Array<T | undefined>> {
    if (calls.length === 0) return []
    const json = await post(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, ...c })))
    if (!Array.isArray(json)) throw new Error('batch: node did not return an array')
    const out: Array<T | undefined> = new Array(calls.length).fill(undefined)
    for (const r of json as Array<{ id?: number; result?: T; error?: unknown }>) {
      if (typeof r.id === 'number' && r.id >= 0 && r.id < calls.length && !r.error) out[r.id] = r.result
    }
    return out
  }

  const txParams = (sig: string) => [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]

  async function fetchTransactions(sigs: string[]): Promise<Map<string, ParsedTransaction | null>> {
    const out = new Map<string, ParsedTransaction | null>()
    for (let i = 0; i < sigs.length; i += batchSize) {
      const chunk = sigs.slice(i, i + batchSize)
      const results = chunk.length === 1
        ? [await rpc<ParsedTransaction | null>('getTransaction', txParams(chunk[0]!))]
        : await rpcBatch<ParsedTransaction | null>(chunk.map((s) => ({ method: 'getTransaction', params: txParams(s) })))
      chunk.forEach((s, k) => out.set(s, results[k] ?? null))
    }
    return out
  }

  function tokenAccounts(address: string): Promise<string[]> {
    let p = tokenAccountCache.get(address)
    if (!p) {
      p = (async () => {
        const accounts: string[] = []
        for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
          const r = await rpc<{ value?: Array<{ pubkey: string }> }>('getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed' }])
          for (const a of r?.value ?? []) accounts.push(a.pubkey)
        }
        return accounts.slice(0, maxTokenAccounts)
      })()
      p.catch(() => tokenAccountCache.delete(address))
      tokenAccountCache.set(address, p)
    }
    return p
  }

  return {
    chain,
    tokenAccounts,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<SolanaHistoryPage> {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      // The list set is frozen in the cursor: token accounts created mid-pagination join on the next fresh listing.
      const lists = cursor ? Object.keys(cursor.l) : [address, ...(await tokenAccounts(address)).filter((a) => a !== address)]
      const pages = new Map<string, SignatureRow[]>()
      for (const list of lists) {
        const before = cursor?.l[list]
        if (before === null) continue
        const params: Record<string, unknown> = { limit, commitment: 'confirmed' }
        if (before) params.before = before
        const rows = await rpc<SignatureRow[] | null>('getSignaturesForAddress', [list, params])
        pages.set(list, rows ?? [])
      }
      // Global order: slot desc, then list order, then the node's order. Emit the top `limit` signatures plus ties at the boundary slot,
      // so each list's consumed rows form a prefix of what it returned and its `before` cursor stays exact.
      const seen = new Map<string, SignatureRow>()
      const ordered: Array<{ list: string; row: SignatureRow }> = []
      for (const list of lists) for (const row of pages.get(list) ?? []) ordered.push({ list, row })
      ordered.sort((a, b) => b.row.slot - a.row.slot || lists.indexOf(a.list) - lists.indexOf(b.list))
      let boundary: number | undefined
      for (const { row } of ordered) {
        if (!seen.has(row.signature)) {
          if (seen.size >= limit && boundary !== undefined && row.slot < boundary) break
          seen.set(row.signature, row)
          if (seen.size === limit) boundary = row.slot
        }
      }
      const next: Record<string, string | null> = {}
      let anyLeft = false
      for (const list of lists) {
        if (cursor?.l[list] === null) {
          next[list] = null
          continue
        }
        const rows = pages.get(list) ?? []
        let consumed = 0
        while (consumed < rows.length && seen.has(rows[consumed]!.signature)) consumed++
        const exhausted = rows.length < limit && consumed === rows.length
        if (exhausted) next[list] = null
        else {
          // '' = not started yet (its rows all sit below this page's boundary); the node is asked without `before`.
          next[list] = consumed > 0 ? rows[consumed - 1]!.signature : (cursor?.l[list] ?? '')
          anyLeft = true
        }
      }
      const sigs = [...seen.keys()]
      const txs = await fetchTransactions(sigs)
      let items = sigs.map((s) => mapTransaction(chain, address, seen.get(s)!, txs.get(s) ?? null))
      items.sort((a, b) => Number(b.block! - a.block!))
      let more = anyLeft
      if (query.since !== undefined) {
        const since = query.since
        if (items.some((t) => t.time < since)) more = false
        items = items.filter((t) => t.time >= since)
      }
      const page: SolanaHistoryPage = { items }
      if (more) page.cursor = encodeCursor({ v: 1, l: next })
      return page
    },

    async getTransaction(hash: string, address: string): Promise<SolanaChainTx | undefined> {
      const tx = await rpc<ParsedTransaction | null>('getTransaction', txParams(hash))
      if (!tx) return undefined
      const row: SignatureRow = { signature: hash, slot: tx.slot, blockTime: tx.blockTime ?? null, err: tx.meta?.err ?? null }
      return mapTransaction(chain, address, row, tx)
    },

    explorerTxUrl(hash: string): string {
      return solanaExplorerTxUrl(hash, network)
    },
  }
}
