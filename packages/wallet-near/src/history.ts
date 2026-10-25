/**
 * Activity history for NEAR: a `HistorySource` over the nearblocks API
 * (`/v1/account/{id}/txns` receipt rows + `/v1/account/{id}/ft-txns` NEP-141
 * movements, merged by transaction hash), with an optional archival RPC
 * (`EXPERIMENTAL_tx_status`) that makes single-transaction reads exact.
 *
 * nearblocks serializes large yoctoNEAR amounts as JSON numbers; integer
 * literals are kept exact by re-quoting them before `JSON.parse`, values the
 * API already rounded (`7e+23`) stay approximate and are flagged in `raw`.
 * Both lists page by keyset cursor (`id` / `event_index`), merged newest-first.
 * `fetch` + `AbortSignal.timeout` only — Hermes-safe.
 */
import type { ChainCall, ChainTransfer, ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { fromBase64 } from './rpc.js'
import { CAIP2 } from './types.js'
import { bigintToNumber } from '@anywalletkit/core'

// ── Public types ─────────────────────────────────────────────────────────────

export type HistoryFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Options for {@link createNearHistory}. */
export interface NearHistoryOptions {
  /** nearblocks root. Default `https://api.nearblocks.io` (`https://api-testnet.nearblocks.io` on testnet). */
  nearblocksUrl?: string
  /** nearblocks Bearer key. Keyless use is limited to a few requests per minute. */
  apiKey?: string
  /** Archival JSON-RPC (`https://archival-rpc.mainnet.near.org`). When set, `getTransaction` is refined with exact amounts, fee and NEP-141 events. */
  rpcUrl?: string
  network?: 'mainnet' | 'testnet'
  fetch?: HistoryFetch
  /** nearblocks requests per second. Default 0.1 (6/min) without a key, 5 with one. */
  rateLimit?: number
  /** Per request, ms. Default 15 000. */
  timeoutMs?: number
}

export interface NearHistoryRaw {
  /** nearblocks receipt rows of this transaction (account `/txns`). */
  receipts: NearblocksReceiptRow[]
  /** nearblocks NEP-141 rows of this transaction (account `/ft-txns`). */
  ft: NearblocksFtRow[]
  /** `/v1/txns/{hash}` row (single-transaction reads). */
  txn?: NearblocksTxn
  /** `EXPERIMENTAL_tx_status` result when the RPC answered. */
  rpc?: RpcTxStatus
  /** Set when an amount or the fee came from a value nearblocks had already rounded to a double. */
  approximate?: true
}

export interface NearChainTx extends ChainTx {
  raw: NearHistoryRaw
}

export interface NearHistoryPage extends HistoryPage {
  items: NearChainTx[]
}

/**
 * NEAR history from the nearblocks API, with an archival RPC for single transactions. Build it with
 * {@link createNearHistory}.
 */
export interface NearHistorySource extends HistorySource {
  listActivity(address: string, query?: HistoryQuery): Promise<NearHistoryPage>
  getTransaction(hash: string, address: string): Promise<NearChainTx | undefined>
}

/** Every configured history backend failed. */
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
const MAX_LIMIT = 25
const DEFAULT_TIMEOUT_MS = 15_000
/** NEP-141 convention: 1 yoctoNEAR attached to prove a full-access key; not a payment. */
const ONE_YOCTO = 1n

// ── Cursor: per-list keyset positions, base64 JSON ───────────────────────────

export interface NearHistoryCursor {
  v: 1
  /** `/txns`: `id` of the last consumed row; '' = not started; null = exhausted. */
  tx: string | null
  /** `/ft-txns`: `event_index` of the last consumed row; '' = not started; null = exhausted. */
  ft: string | null
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

export function encodeCursor(c: NearHistoryCursor): string {
  return b64encode(JSON.stringify(c))
}

export function decodeCursor(s: string): NearHistoryCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(b64decode(s))
  } catch {
    throw new Error('@anywalletkit/wallet-near: malformed history cursor')
  }
  const c = parsed as Partial<NearHistoryCursor> | null
  const ok = (v: unknown) => v === null || typeof v === 'string'
  if (!c || c.v !== 1 || !ok(c.tx) || !ok(c.ft)) throw new Error('@anywalletkit/wallet-near: malformed history cursor')
  return { v: 1, tx: c.tx as string | null, ft: c.ft as string | null }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number
  private last = Date.now()
  private chain: Promise<void> = Promise.resolve()
  constructor(private readonly rate: number, private readonly burst = Math.max(2, Math.ceil(rate))) {
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

/**
 * `JSON.parse` that keeps integer literals of 16+ digits exact by quoting them
 * first (outside strings only). Numbers with a fraction or exponent are left
 * to the double parser — nearblocks already rounded those.
 */
export function parseJsonPreservingBigInts(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i
      if (text[j] === '-') j++
      while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++
      const next = text[j]
      const isInteger = next !== '.' && next !== 'e' && next !== 'E'
      if (isInteger) {
        const tok = text.slice(i, j)
        out += tok.replace('-', '').length >= 16 ? `"${tok}"` : tok
        i = j
        continue
      }
      while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j++
      out += text.slice(i, j)
      i = j
      continue
    }
    out += ch
    i++
  }
  return JSON.parse(out)
}

/** Number / decimal string → bigint; `approx` is set when a double had to be used. */
function big(v: unknown, approx: { value: boolean }): bigint | undefined {
  if (typeof v === 'bigint') return v
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (!Number.isSafeInteger(v)) approx.value = true
    return BigInt(Math.trunc(v))
  }
  return undefined
}

const nsToSeconds = (ts: unknown): number => {
  if (typeof ts === 'string' && /^\d+$/.test(ts)) return bigintToNumber(BigInt(ts) / 1_000_000_000n)
  if (typeof ts === 'number') return Math.floor(ts / 1e9)
  return 0
}

// ── nearblocks shapes ────────────────────────────────────────────────────────

export interface NearblocksAction {
  action: string
  method?: string | null
  deposit?: number | string | null
  args?: string | null
}
export interface NearblocksReceiptRow {
  id: string
  receipt_id?: string
  predecessor_account_id: string
  receiver_account_id: string
  receipt_kind?: string
  transaction_hash: string
  /** ns, decimal string (the transaction's block). */
  block_timestamp: string | number
  block?: { block_height?: number }
  actions?: NearblocksAction[] | null
  outcomes?: { status?: boolean | null }
  outcomes_agg?: { transaction_fee?: number | string | null }
}
export interface NearblocksFtRow {
  event_index: string
  affected_account_id: string
  involved_account_id?: string | null
  /** Signed, decimal string (exact). */
  delta_amount: string | number
  cause?: string
  transaction_hash: string
  block_timestamp: string | number
  block?: { block_height?: number }
  outcomes?: { status?: boolean | null }
  ft?: { contract: string; symbol?: string | null; decimals?: number | null }
  ft_meta?: { contract: string; symbol?: string | null; decimals?: number | null }
}
export interface NearblocksTxn {
  transaction_hash: string
  block_timestamp: string | number
  signer_account_id: string
  receiver_account_id: string
  block?: { block_height?: number }
  actions?: NearblocksAction[] | null
  outcomes?: { status?: boolean | null }
  outcomes_agg?: { transaction_fee?: number | string | null }
  receipts?: Array<{ fts?: Array<Pick<NearblocksFtRow, 'affected_account_id' | 'involved_account_id' | 'delta_amount' | 'cause' | 'ft_meta'>> }>
}

function ftTransfer(row: Pick<NearblocksFtRow, 'affected_account_id' | 'involved_account_id' | 'delta_amount' | 'cause' | 'ft' | 'ft_meta'>, approx: { value: boolean }): ChainTransfer | undefined {
  const meta = row.ft ?? row.ft_meta
  if (!meta?.contract) return undefined
  const delta = big(row.delta_amount, approx)
  if (delta === undefined || delta === 0n) return undefined
  const other = row.involved_account_id ?? meta.contract
  const t: ChainTransfer = { token: meta.contract, from: delta < 0n ? row.affected_account_id : other, to: delta < 0n ? other : row.affected_account_id, amount: delta < 0n ? -delta : delta, standard: 'nep141' }
  if (typeof meta.symbol === 'string') t.symbol = meta.symbol
  if (typeof meta.decimals === 'number') t.decimals = meta.decimals
  return t
}

interface ActionFold {
  transfers: ChainTransfer[]
  programs: string[]
  call?: ChainCall
}

/** Fold nearblocks actions of one receipt (predecessor → receiver) into transfers / call; the first non-transfer action becomes the call. */
function foldActions(actions: NearblocksAction[] | null | undefined, from: string, to: string, fold: ActionFold, approx: { value: boolean }): void {
  for (const a of actions ?? []) {
    const deposit = big(a.deposit, approx) ?? 0n
    if (a.action === 'TRANSFER') {
      if (deposit > 0n) fold.transfers.push({ token: null, from, to, amount: deposit })
      continue
    }
    if (a.action === 'DELEGATE_ACTION') continue
    const method = a.action === 'FUNCTION_CALL' ? (a.method ?? 'function_call') : a.action.toLowerCase()
    fold.programs.push(method)
    if (a.action === 'FUNCTION_CALL' && deposit > 0n && deposit !== ONE_YOCTO) fold.transfers.push({ token: null, from, to, amount: deposit })
    fold.call ??= { to, method, programs: fold.programs }
  }
}

/** One transaction from its nearblocks receipt rows + NEP-141 rows. */
export function mapNearblocksGroup(chain: string, address: string, receipts: NearblocksReceiptRow[], ft: NearblocksFtRow[]): NearChainTx {
  const approx = { value: false }
  const rows = [...receipts].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
  const real = rows.filter((r) => r.predecessor_account_id !== 'system' && (r.receipt_kind ?? 'ACTION') === 'ACTION')
  const fold: ActionFold = { transfers: [], programs: [] }
  // The receipt addressed to someone else carries the call that matters; a receipt to ourselves (delegate wrapper, refund) is secondary.
  const ordered = [...real.filter((r) => r.receiver_account_id !== address), ...real.filter((r) => r.receiver_account_id === address)]
  for (const r of ordered) foldActions(r.actions, r.predecessor_account_id, r.receiver_account_id, fold, approx)
  for (const f of ft) {
    const t = ftTransfer(f, approx)
    if (t) fold.transfers.push(t)
  }
  const head = ordered[0] ?? rows[0] ?? ft[0]
  const hash = head?.transaction_hash ?? ''
  const from = ordered[0]?.predecessor_account_id ?? (ft.length ? (ftTransfer(ft[0]!, approx)?.from ?? address) : address)
  const involves = (t: ChainTransfer) => t.from === address || t.to === address
  const primary = fold.transfers.find((t) => t.token !== null && involves(t)) ?? fold.transfers.find(involves) ?? fold.transfers[0]
  const to = fold.call?.to ?? primary?.to ?? ordered[0]?.receiver_account_id ?? null
  let nativeValue = 0n
  for (const t of fold.transfers) if (t.token === null && t.from === from) nativeValue += t.amount
  const statuses = [...rows.map((r) => r.outcomes?.status), ...ft.map((r) => r.outcomes?.status)].filter((s): s is boolean => typeof s === 'boolean')
  const status: ChainTx['status'] = statuses.length === 0 ? 'confirmed' : statuses.every(Boolean) ? 'confirmed' : 'failed'
  const feeSrc = rows.find((r) => r.outcomes_agg?.transaction_fee != null)?.outcomes_agg?.transaction_fee
  const fee = big(feeSrc, approx)
  const heights = [...rows, ...ft].map((r) => r.block?.block_height).filter((h): h is number => typeof h === 'number')
  const raw: NearHistoryRaw = { receipts: rows, ft }
  if (approx.value) raw.approximate = true
  const out: NearChainTx = {
    chain, hash, time: nsToSeconds(head?.block_timestamp), status, address, from, to, nativeValue, transfers: fold.transfers, raw,
  }
  if (fee !== undefined) out.fee = fee
  if (fold.call) out.call = fold.call
  if (heights.length) out.block = BigInt(Math.min(...heights))
  return out
}

/** `/v1/txns/{hash}`: transaction-level actions, signer / receiver, approximate NEP-141 deltas from the receipts. */
export function mapNearblocksTxn(chain: string, address: string, txn: NearblocksTxn): NearChainTx {
  const approx = { value: false }
  const fold: ActionFold = { transfers: [], programs: [] }
  foldActions(txn.actions, txn.signer_account_id, txn.receiver_account_id, fold, approx)
  for (const r of txn.receipts ?? []) {
    for (const f of r.fts ?? []) {
      // nearblocks lists both sides of a movement; keep the one whose affected account is in the pair's "from" position.
      const delta = big(f.delta_amount, approx)
      if (delta === undefined || delta >= 0n) continue
      const t = ftTransfer(f, approx)
      if (t) fold.transfers.push(t)
    }
  }
  const from = txn.signer_account_id
  const involves = (t: ChainTransfer) => t.from === address || t.to === address
  const primary = fold.transfers.find((t) => t.token !== null && involves(t)) ?? fold.transfers.find(involves) ?? fold.transfers[0]
  let nativeValue = 0n
  for (const t of fold.transfers) if (t.token === null && t.from === from) nativeValue += t.amount
  const fee = big(txn.outcomes_agg?.transaction_fee, approx)
  const raw: NearHistoryRaw = { receipts: [], ft: [], txn }
  if (approx.value) raw.approximate = true
  const out: NearChainTx = {
    chain, hash: txn.transaction_hash, time: nsToSeconds(txn.block_timestamp), status: txn.outcomes?.status === false ? 'failed' : 'confirmed', address, from,
    to: fold.call?.to ?? primary?.to ?? txn.receiver_account_id, nativeValue, transfers: fold.transfers, raw,
  }
  if (fee !== undefined) out.fee = fee
  if (fold.call) out.call = fold.call
  if (typeof txn.block?.block_height === 'number') out.block = BigInt(txn.block.block_height)
  return out
}

// ── RPC refinement ───────────────────────────────────────────────────────────

interface RpcAction {
  Transfer?: { deposit: string }
  FunctionCall?: { method_name: string; args: string; deposit: string; gas?: number }
  Delegate?: { delegate_action: { sender_id: string; receiver_id: string; actions: RpcAction[] } }
  [other: string]: unknown
}
export interface RpcTxStatus {
  status?: Record<string, unknown>
  transaction?: { signer_id: string; receiver_id: string; hash?: string; actions?: RpcAction[] }
  transaction_outcome?: { outcome?: { tokens_burnt?: string; executor_id?: string; logs?: string[] } }
  receipts_outcome?: Array<{ outcome?: { executor_id?: string; tokens_burnt?: string; logs?: string[]; status?: Record<string, unknown> } }>
}

const utf8 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++]!
    let cp: number
    if (b0 < 0x80) cp = b0
    else if (b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f)
    else if (b0 < 0xf0) cp = ((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    else cp = ((b0 & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    s += String.fromCodePoint(cp)
  }
  return s
}

/** Rebuild transfers / call / fee / status exactly from an `EXPERIMENTAL_tx_status` result. */
export function mapRpcTxStatus(chain: string, address: string, r: RpcTxStatus, base?: NearChainTx): NearChainTx {
  const tx = r.transaction
  const transfers: ChainTransfer[] = []
  const programs: string[] = []
  let call: ChainCall | undefined
  const walk = (actions: RpcAction[] | undefined, from: string, to: string) => {
    for (const a of actions ?? []) {
      if (a.Transfer) {
        const d = BigInt(a.Transfer.deposit)
        if (d > 0n) transfers.push({ token: null, from, to, amount: d })
      } else if (a.FunctionCall) {
        const d = BigInt(a.FunctionCall.deposit || '0')
        programs.push(a.FunctionCall.method_name)
        if (d > 0n && d !== ONE_YOCTO) transfers.push({ token: null, from, to, amount: d })
        call ??= { to, method: a.FunctionCall.method_name, programs }
      } else if (a.Delegate) {
        walk(a.Delegate.delegate_action.actions, a.Delegate.delegate_action.sender_id, a.Delegate.delegate_action.receiver_id)
      } else {
        const name = Object.keys(a)[0]
        if (name) {
          const method = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
          programs.push(method)
          call ??= { to, method, programs }
        }
      }
    }
  }
  if (tx) walk(tx.actions, tx.signer_id, tx.receiver_id)
  let fee = 0n
  const burnt = r.transaction_outcome?.outcome?.tokens_burnt
  if (burnt) fee += BigInt(burnt)
  let failed = false
  for (const ro of r.receipts_outcome ?? []) {
    const o = ro.outcome
    if (!o) continue
    if (o.tokens_burnt) fee += BigInt(o.tokens_burnt)
    if (o.status && 'Failure' in o.status) failed = true
    const token = o.executor_id
    for (const log of o.logs ?? []) {
      if (!token) continue
      const legacy = /^Transfer (\d+) from (\S+) to (\S+)$/.exec(log)
      if (legacy) {
        transfers.push({ token, from: legacy[2]!, to: legacy[3]!, amount: BigInt(legacy[1]!), standard: 'nep141' })
        continue
      }
      if (!log.startsWith('EVENT_JSON:')) continue
      let ev: { standard?: string; event?: string; data?: Array<{ old_owner_id?: string; new_owner_id?: string; owner_id?: string; amount?: string }> }
      try {
        ev = JSON.parse(log.slice('EVENT_JSON:'.length)) as typeof ev
      } catch {
        continue
      }
      if (ev.standard !== 'nep141') continue
      for (const d of ev.data ?? []) {
        if (!d.amount || !/^\d+$/.test(d.amount)) continue
        if (ev.event === 'ft_transfer' && d.old_owner_id && d.new_owner_id) transfers.push({ token, from: d.old_owner_id, to: d.new_owner_id, amount: BigInt(d.amount), standard: 'nep141' })
        else if (ev.event === 'ft_mint' && d.owner_id) transfers.push({ token, from: token, to: d.owner_id, amount: BigInt(d.amount), standard: 'nep141' })
        else if (ev.event === 'ft_burn' && d.owner_id) transfers.push({ token, from: d.owner_id, to: token, amount: BigInt(d.amount), standard: 'nep141' })
      }
    }
  }
  if (r.status && 'Failure' in r.status) failed = true
  // Keep symbol / decimals nearblocks knew for the same token.
  for (const t of transfers) {
    const known = base?.transfers.find((x) => x.token === t.token && (x.symbol !== undefined || x.decimals !== undefined))
    if (known?.symbol !== undefined) t.symbol = known.symbol
    if (known?.decimals !== undefined) t.decimals = known.decimals
  }
  const from = tx?.signer_id ?? base?.from ?? address
  const involves = (t: ChainTransfer) => t.from === address || t.to === address
  const primary = transfers.find((t) => t.token !== null && involves(t)) ?? transfers.find(involves) ?? transfers[0]
  let nativeValue = 0n
  for (const t of transfers) if (t.token === null && t.from === from) nativeValue += t.amount
  const raw: NearHistoryRaw = { ...(base?.raw ?? { receipts: [], ft: [] }), rpc: r }
  delete raw.approximate
  const out: NearChainTx = {
    chain, hash: tx?.hash ?? base?.hash ?? '', time: base?.time ?? 0, status: failed ? 'failed' : 'confirmed', address, from,
    to: call?.to ?? primary?.to ?? tx?.receiver_id ?? base?.to ?? null, nativeValue, transfers, fee, raw,
  }
  if (call) out.call = call
  if (base?.block !== undefined) out.block = base.block
  return out
}

/** Decode `FunctionCall.args` (base64 JSON) — exported for callers that want the arguments of a call. */
export function decodeFunctionCallArgs(args: string): unknown {
  try {
    return JSON.parse(utf8(fromBase64(args)))
  } catch {
    return undefined
  }
}

// ── Source ───────────────────────────────────────────────────────────────────

/** Nearblocks link for a transaction. */
export function nearExplorerTxUrl(hash: string, network: 'mainnet' | 'testnet' = 'mainnet'): string {
  return `https://${network === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${hash}`
}

/** A history source for NEAR accounts backed by nearblocks. */
export function createNearHistory(options: NearHistoryOptions = {}): NearHistorySource {
  const network = options.network ?? 'mainnet'
  const chain = CAIP2[network] ?? CAIP2.mainnet!
  const base = (options.nearblocksUrl ?? (network === 'testnet' ? 'https://api-testnet.nearblocks.io' : 'https://api.nearblocks.io')).replace(/\/+$/, '')
  const fetchFn: HistoryFetch = options.fetch ?? ((globalThis as { fetch?: HistoryFetch }).fetch as HistoryFetch)
  if (typeof fetchFn !== 'function') throw new Error('@anywalletkit/wallet-near: no global fetch; pass `fetch` in the options')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const bucket = new TokenBucket(options.rateLimit ?? (options.apiKey ? 5 : 0.1))

  async function get(path: string): Promise<unknown> {
    await bucket.acquire()
    const url = `${base}${path}`
    let res: Awaited<ReturnType<HistoryFetch>>
    try {
      const signal = timeoutSignal(timeoutMs)
      res = await fetchFn(url, { headers: { accept: 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) }, ...(signal ? { signal } : {}) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new HistoryUnavailableError(chain, `${path}: ${msg}`, [`nearblocks: ${msg}`])
    }
    const text = await res.text()
    let body: unknown
    try {
      body = parseJsonPreservingBigInts(text)
    } catch {
      body = undefined
    }
    if (!res.ok) {
      const msg = (body as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`
      throw new HistoryUnavailableError(chain, `${path}: ${msg}`, [`nearblocks: HTTP ${res.status} ${msg}`])
    }
    return body
  }

  async function rpcTxStatus(hash: string, signer: string): Promise<RpcTxStatus | undefined> {
    if (!options.rpcUrl) return undefined
    const signal = timeoutSignal(timeoutMs)
    const res = await fetchFn(options.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'EXPERIMENTAL_tx_status', params: { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' } }),
      ...(signal ? { signal } : {}),
    })
    const json = JSON.parse(await res.text()) as { result?: RpcTxStatus; error?: unknown }
    if (!res.ok || json.error || !json.result) return undefined
    return json.result
  }

  return {
    chain,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<NearHistoryPage> {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))
      const cursor = query.cursor ? decodeCursor(query.cursor) : { v: 1 as const, tx: '', ft: '' }
      const acct = encodeURIComponent(address)
      // Receipt rows come ~2 per transaction (the call and its refund), so the receipt list is asked for twice the limit.
      const perPage = Math.min(MAX_LIMIT, limit * 2)
      const txRows: NearblocksReceiptRow[] = cursor.tx === null ? [] : (((await get(`/v1/account/${acct}/txns?per_page=${perPage}&order=desc${cursor.tx ? `&cursor=${encodeURIComponent(cursor.tx)}` : ''}`)) as { txns?: NearblocksReceiptRow[] } | undefined)?.txns ?? [])
      const ftRows: NearblocksFtRow[] = cursor.ft === null ? [] : (((await get(`/v1/account/${acct}/ft-txns?per_page=${limit}&order=desc${cursor.ft ? `&cursor=${encodeURIComponent(cursor.ft)}` : ''}`)) as { txns?: NearblocksFtRow[] } | undefined)?.txns ?? [])
      // Global order by the transaction's block time; emit the top `limit` hashes plus ties, so each list's consumed rows are a prefix.
      const key = (r: { block_timestamp: string | number }) => BigInt(typeof r.block_timestamp === 'string' ? r.block_timestamp : Math.trunc(r.block_timestamp))
      const all = [...txRows.map((r) => ({ k: key(r), h: r.transaction_hash })), ...ftRows.map((r) => ({ k: key(r), h: r.transaction_hash }))]
      all.sort((a, b) => (a.k > b.k ? -1 : a.k < b.k ? 1 : 0))
      const chosen = new Set<string>()
      let boundary: bigint | undefined
      for (const e of all) {
        if (chosen.has(e.h)) continue
        if (chosen.size >= limit && boundary !== undefined && e.k < boundary) break
        chosen.add(e.h)
        if (chosen.size === limit) boundary = e.k
      }
      // Consumed = the prefix of each list whose hashes were chosen; a list is exhausted once it came back short and fully consumed.
      const consume = <T extends { transaction_hash: string }>(rows: T[], asked: number, wasAt: string | null, pos: (r: T) => string): { used: T[]; next: string | null } => {
        if (wasAt === null) return { used: [], next: null }
        let n = 0
        while (n < rows.length && chosen.has(rows[n]!.transaction_hash)) n++
        const used = rows.slice(0, n)
        if (rows.length < asked && n === rows.length) return { used, next: null }
        return { used, next: n > 0 ? pos(used[n - 1]!) : wasAt }
      }
      const txC = consume(txRows, perPage, cursor.tx, (r) => r.id)
      const ftC = consume(ftRows, limit, cursor.ft, (r) => r.event_index)
      const nextTx = txC.next, nextFt = ftC.next
      const groups = new Map<string, { receipts: NearblocksReceiptRow[]; ft: NearblocksFtRow[] }>()
      for (const h of chosen) groups.set(h, { receipts: [], ft: [] })
      for (const r of txC.used) groups.get(r.transaction_hash)!.receipts.push(r)
      for (const r of ftC.used) groups.get(r.transaction_hash)!.ft.push(r)
      let items = [...groups.entries()].map(([, g]) => mapNearblocksGroup(chain, address, g.receipts, g.ft)).filter((t) => t.hash)
      items.sort((a, b) => b.time - a.time)
      let more = nextTx !== null || nextFt !== null
      if (query.since !== undefined) {
        const since = query.since
        if (items.some((t) => t.time < since)) more = false
        items = items.filter((t) => t.time >= since)
      }
      const page: NearHistoryPage = { items }
      if (more) page.cursor = encodeCursor({ v: 1, tx: nextTx, ft: nextFt })
      return page
    },

    async getTransaction(hash: string, address: string): Promise<NearChainTx | undefined> {
      const body = (await get(`/v1/txns/${encodeURIComponent(hash)}`)) as { txns?: NearblocksTxn[] } | undefined
      const txn = body?.txns?.[0]
      if (!txn) return undefined
      const base = mapNearblocksTxn(chain, address, txn)
      if (!options.rpcUrl) return base
      try {
        const r = await rpcTxStatus(hash, txn.signer_account_id)
        return r ? mapRpcTxStatus(chain, address, r, base) : base
      } catch {
        return base
      }
    },

    explorerTxUrl(hash: string): string {
      return nearExplorerTxUrl(hash, network)
    },
  }
}
