/**
 * Activity history for TON: a `HistorySource` over tonapi account events
 * (`/v2/accounts/{a}/events`, keyless or with a Bearer key) with toncenter v3
 * (`/api/v3/transactions`) as a reduced fallback.
 *
 * tonapi groups a whole trace (the wallet's message and everything it caused)
 * into one event with typed actions; each action becomes native / jetton
 * transfers and the first contract-level action becomes `call`. The fee is
 * tonapi's `extra` (what the account lost beyond its actions). toncenter sees
 * only the account's own transactions: TON in / out and op codes, no jettons.
 * Addresses are kept raw (`0:…`, lowercase) as both indexers return them;
 * recognizers normalize. `fetch` + `AbortSignal.timeout` only — Hermes-safe.
 */
import { Address } from '@ton/core'
import { Buffer } from 'buffer'
import type { ChainCall, ChainTransfer, ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { CAIP2 } from './types.js'

// ── Public types ─────────────────────────────────────────────────────────────

export type HistoryFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type TonHistoryBackend = 'tonapi' | 'toncenter'

export interface TonHistoryOptions {
  /** tonapi root. Default `https://tonapi.io` (`https://testnet.tonapi.io` on testnet). `null` disables tonapi. */
  tonapiUrl?: string | null
  /** tonapi Bearer key. Keyless tonapi allows ~1 request/s. */
  apiKey?: string
  /** toncenter root for the v3 fallback. Default `https://toncenter.com` (`https://testnet.toncenter.com`). `null` disables it. */
  toncenterUrl?: string | null
  /** toncenter `X-API-Key`. */
  toncenterApiKey?: string
  network?: 'mainnet' | 'testnet'
  fetch?: HistoryFetch
  /** tonapi requests per second. Default 1 without a key, 10 with one. */
  rateLimit?: number
  /** Per request, ms. Default 15 000. */
  timeoutMs?: number
}

export interface TonHistoryRaw {
  backend: TonHistoryBackend
  /** The tonapi account event, or the toncenter v3 transaction row. */
  event: unknown
  /** tonapi flagged the event as scam. */
  scam?: boolean
  /** tonapi `value_flow` for the account when it had to be fetched to recover jetton movements. */
  valueFlow?: unknown
}

export interface TonChainTx extends ChainTx {
  /** Mirrors `raw.scam`; the app hides these by default. */
  scam?: boolean
  raw: TonHistoryRaw
}

export interface TonHistoryPage extends HistoryPage {
  items: TonChainTx[]
  backend?: TonHistoryBackend
}

export interface TonHistorySource extends HistorySource {
  listActivity(address: string, query?: HistoryQuery): Promise<TonHistoryPage>
  getTransaction(hash: string, address: string): Promise<TonChainTx | undefined>
}

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
const MAX_LIMIT = 100
const DEFAULT_TIMEOUT_MS = 15_000

// ── Cursor: an exclusive `lt` upper bound, base64 JSON ───────────────────────

export interface TonHistoryCursor {
  v: 1
  b: TonHistoryBackend
  /** Next page = events / transactions with `lt < this` (decimal string). */
  lt: string
}

export function encodeCursor(c: TonHistoryCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64')
}

export function decodeCursor(s: string): TonHistoryCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64').toString('utf8'))
  } catch {
    throw new Error('@anywalletkit/wallet-ton: malformed history cursor')
  }
  const c = parsed as Partial<TonHistoryCursor> | null
  if (!c || c.v !== 1 || (c.b !== 'tonapi' && c.b !== 'toncenter') || typeof c.lt !== 'string' || !/^\d+$/.test(c.lt)) {
    throw new Error('@anywalletkit/wallet-ton: malformed history cursor')
  }
  return { v: 1, b: c.b, lt: c.lt }
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

/** Any spelling → raw lowercase `wc:hex`; unparsable input is returned as-is. */
export function rawTonAddress(a: string): string {
  try {
    return Address.parse(a).toRawString().toLowerCase()
  } catch {
    return a.toLowerCase()
  }
}

const big = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  return 0n
}

const isHexOp = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-f]{1,8}$/i.test(s)

// ── tonapi shapes (what the mapper reads) ────────────────────────────────────

interface TonapiAccount { address: string; is_wallet?: boolean; is_scam?: boolean; name?: string }
interface TonapiJetton { address: string; symbol?: string; decimals?: number; name?: string }
export interface TonapiAction {
  type: string
  status: 'ok' | 'failed' | string
  [body: string]: unknown
}
export interface TonapiEvent {
  event_id: string
  account?: TonapiAccount
  timestamp: number
  lt: number | string
  in_progress: boolean
  is_scam: boolean
  actions: TonapiAction[]
  /** Account-scoped events only: TON the account lost beyond its actions (negative = fees). */
  extra?: number
  value_flow?: Array<{ account: TonapiAccount; ton: number; jettons?: Array<{ jetton: TonapiJetton; quantity: number | string }> }>
}

interface MappedActions {
  transfers: ChainTransfer[]
  call?: ChainCall
  /** Who initiated the event as far as the first action tells. */
  initiator?: string
  /** The event needs `value_flow` to recover a jetton movement tonapi did not spell out (unstake requests). */
  needsValueFlow?: { counterparty: string }
}

const jettonMeta = (j: TonapiJetton | undefined): Pick<ChainTransfer, 'symbol' | 'decimals'> => {
  const m: Pick<ChainTransfer, 'symbol' | 'decimals'> = {}
  if (j?.symbol !== undefined) m.symbol = j.symbol
  if (j?.decimals !== undefined) m.decimals = j.decimals
  return m
}

const addr = (a: unknown): string | undefined => (typeof a === 'object' && a !== null && typeof (a as TonapiAccount).address === 'string' ? (a as TonapiAccount).address.toLowerCase() : typeof a === 'string' ? a.toLowerCase() : undefined)
const isWallet = (a: unknown): boolean => typeof a === 'object' && a !== null && (a as TonapiAccount).is_wallet === true

/** tonapi actions → transfers + the contract call. Only `ok` actions move value. */
export function mapActions(actions: TonapiAction[]): MappedActions {
  const out: MappedActions = { transfers: [] }
  const native = (from: string | undefined, to: string | undefined, amount: bigint) => {
    if (from === undefined || to === undefined || amount <= 0n) return
    out.transfers.push({ token: null, from, to, amount })
  }
  const jetton = (j: TonapiJetton | undefined, from: string | undefined, to: string | undefined, amount: bigint) => {
    if (!j || from === undefined || to === undefined || amount <= 0n) return
    out.transfers.push({ token: j.address.toLowerCase(), from, to, amount, standard: 'jetton', ...jettonMeta(j) })
  }
  const setCall = (c: ChainCall | undefined) => {
    if (c && !out.call) out.call = c
  }
  const init = (a: string | undefined) => {
    if (out.initiator === undefined && a !== undefined) out.initiator = a
  }
  for (const a of actions) {
    const b = (a[a.type] ?? {}) as Record<string, unknown>
    const ok = a.status === 'ok'
    switch (a.type) {
      case 'TonTransfer': {
        const from = addr(b.sender), to = addr(b.recipient)
        init(from)
        if (ok) native(from, to, big(b.amount))
        break
      }
      case 'JettonTransfer': {
        const from = addr(b.sender) ?? addr(b.senders_wallet), to = addr(b.recipient) ?? addr(b.recipients_wallet)
        init(from)
        if (ok) jetton(b.jetton as TonapiJetton, from, to, big(b.amount))
        // A jetton sent to a contract with a forward payload is a call; tonapi surfaces the op as "Call: 0x…".
        if (to !== undefined && b.recipient !== undefined && !isWallet(b.recipient)) {
          const c: ChainCall = { to, method: 'jetton_transfer' }
          const m = typeof b.comment === 'string' ? /^Call:\s*(0x[0-9a-f]+)/i.exec(b.comment) : null
          if (m) c.data = m[1]!.toLowerCase()
          setCall(c)
        }
        break
      }
      case 'JettonMint': {
        const j = b.jetton as TonapiJetton | undefined
        if (ok) jetton(j, j?.address.toLowerCase(), addr(b.recipient) ?? addr(b.recipients_wallet), big(b.amount))
        break
      }
      case 'JettonBurn': {
        const j = b.jetton as TonapiJetton | undefined
        const from = addr(b.sender) ?? addr(b.senders_wallet)
        init(from)
        if (ok) jetton(j, from, j?.address.toLowerCase(), big(b.amount))
        setCall(j ? { to: j.address.toLowerCase(), method: 'jetton_burn' } : undefined)
        break
      }
      case 'JettonSwap': {
        const user = addr(b.user_wallet), router = addr(b.router)
        init(user)
        if (ok) {
          native(user, router, big(b.ton_in))
          jetton(b.jetton_master_in as TonapiJetton | undefined, user, router, big(b.amount_in))
          native(router, user, big(b.ton_out))
          jetton(b.jetton_master_out as TonapiJetton | undefined, router, user, big(b.amount_out))
        }
        if (router !== undefined) setCall({ to: router, method: 'swap' })
        break
      }
      case 'SmartContractExec': {
        const executor = addr(b.executor), contract = addr(b.contract)
        init(executor)
        if (ok) native(executor, contract, big(b.ton_attached))
        if (contract !== undefined) {
          const c: ChainCall = { to: contract }
          if (isHexOp(b.operation)) c.data = b.operation.toLowerCase()
          else if (typeof b.operation === 'string' && b.operation) c.method = b.operation
          setCall(c)
        }
        break
      }
      case 'DepositStake': {
        const staker = addr(b.staker), pool = addr(b.pool)
        init(staker)
        if (ok) native(staker, pool, big(b.amount))
        if (pool !== undefined) setCall({ to: pool, method: 'stake' })
        break
      }
      case 'WithdrawStakeRequest': {
        const staker = addr(b.staker), pool = addr(b.pool)
        init(staker)
        if (ok && b.amount !== undefined) native(staker, pool, big(b.amount))
        if (pool !== undefined) {
          setCall({ to: pool, method: 'unstake' })
          // tonapi does not spell out the pool-token burn; `value_flow` has it.
          if (ok) out.needsValueFlow ??= { counterparty: pool }
        }
        break
      }
      case 'WithdrawStake': {
        const staker = addr(b.staker), pool = addr(b.pool)
        init(pool)
        if (ok) native(pool, staker, big(b.amount))
        if (pool !== undefined) setCall({ to: pool, method: 'withdraw_stake' })
        break
      }
      case 'ElectionsDepositStake':
      case 'ElectionsRecoverStake': {
        const staker = addr(b.staker)
        init(staker)
        // The elector has no address in the action; keep the movement against the elector pseudo-account.
        if (ok) a.type === 'ElectionsDepositStake' ? native(staker, '-1:3333333333333333333333333333333333333333333333333333333333333333', big(b.amount)) : native('-1:3333333333333333333333333333333333333333333333333333333333333333', staker, big(b.amount))
        break
      }
      case 'Subscribe':
      case 'UnSubscribe': {
        const subscriber = addr(b.subscriber), beneficiary = addr(b.beneficiary), subscription = addr(b.subscription)
        init(subscriber)
        if (ok && a.type === 'Subscribe') native(subscriber, beneficiary, big(b.amount))
        if (subscription !== undefined) setCall({ to: subscription, method: a.type === 'Subscribe' ? 'subscribe' : 'unsubscribe' })
        break
      }
      case 'NftPurchase': {
        const buyer = addr(b.buyer), seller = addr(b.seller), nft = addr(b.nft)
        init(buyer)
        if (ok) native(buyer, seller, big((b.amount as { value?: unknown } | undefined)?.value ?? b.amount))
        if (nft !== undefined) setCall({ to: nft, method: 'nft_purchase' })
        break
      }
      case 'ContractDeploy': {
        const deployed = addr(b.address)
        if (deployed !== undefined) setCall({ to: deployed, method: 'deploy' })
        break
      }
      default:
        // NftItemTransfer, AuctionBid, DomainRenew, Unknown…: nothing to account for.
        break
    }
  }
  return out
}

/** The account's jetton deltas from `value_flow` as transfers against `counterparty`. */
export function valueFlowTransfers(event: TonapiEvent, own: string, counterparty: string): ChainTransfer[] {
  const flow = event.value_flow?.find((v) => addr(v.account) === own)
  const out: ChainTransfer[] = []
  for (const j of flow?.jettons ?? []) {
    const q = big(j.quantity)
    if (q === 0n) continue
    const t: ChainTransfer = { token: j.jetton.address.toLowerCase(), from: q < 0n ? own : counterparty, to: q < 0n ? counterparty : own, amount: q < 0n ? -q : q, standard: 'jetton', ...jettonMeta(j.jetton) }
    out.push(t)
  }
  return out
}

export function mapTonapiEvent(chain: string, address: string, own: string, event: TonapiEvent, valueFlow?: TonapiEvent): TonChainTx {
  const mapped = mapActions(event.actions ?? [])
  const transfers = mapped.transfers
  const raw: TonHistoryRaw = { backend: 'tonapi', event }
  if (mapped.needsValueFlow && valueFlow) {
    raw.valueFlow = valueFlow.value_flow
    const extra = valueFlowTransfers(valueFlow, own, mapped.needsValueFlow.counterparty)
    for (const t of extra) if (!transfers.some((x) => x.token === t.token && x.from === t.from && x.to === t.to && x.amount === t.amount)) transfers.push(t)
  }
  const from = mapped.initiator ?? own
  const involves = (t: ChainTransfer) => t.from === own || t.to === own
  const primary = transfers.find((t) => t.token !== null && involves(t)) ?? transfers.find(involves) ?? transfers[0]
  const to = mapped.call?.to ?? primary?.to ?? null
  let nativeValue = 0n
  for (const t of transfers) if (t.token === null && t.from === from) nativeValue += t.amount
  const actions = event.actions ?? []
  const status: ChainTx['status'] = event.in_progress ? 'pending' : actions.length > 0 && actions.every((a) => a.status !== 'ok') ? 'failed' : 'confirmed'
  const out: TonChainTx = {
    chain, hash: event.event_id, time: event.timestamp, status, address, from, to, nativeValue, transfers, block: big(event.lt), raw,
  }
  if (typeof event.extra === 'number' && event.extra < 0) out.fee = BigInt(-event.extra)
  if (mapped.call) out.call = mapped.call
  if (event.is_scam) {
    out.scam = true
    raw.scam = true
  }
  return out
}

// ── toncenter v3 shapes ──────────────────────────────────────────────────────

interface V3Message {
  source?: string | null
  destination?: string | null
  value?: string | null
  opcode?: string | null
  decoded_opcode?: string | null
}
export interface V3Transaction {
  account: string
  /** base64. */
  hash: string
  lt: string
  now: number
  total_fees: string
  description?: { aborted?: boolean; compute_ph?: { success?: boolean; exit_code?: number; skipped?: boolean }; action?: { success?: boolean } }
  in_msg?: V3Message | null
  out_msgs?: V3Message[]
}

const TEXT_COMMENT_OP = '0x00000000'

/** Reduced mapping: TON in / out and op codes of the account's own transaction; jettons are not visible here. */
export function mapToncenterTransaction(chain: string, address: string, row: V3Transaction): TonChainTx {
  const own = row.account.toLowerCase()
  const hash = Buffer.from(row.hash, 'base64').toString('hex')
  const d = row.description
  const failed = d?.aborted === true || (d?.compute_ph?.skipped !== true && d?.compute_ph?.success === false) || d?.action?.success === false
  const transfers: ChainTransfer[] = []
  let from = own
  let to: string | null = null
  let call: ChainCall | undefined
  const source = row.in_msg?.source ? row.in_msg.source.toLowerCase() : undefined
  if (source === undefined) {
    // External message: the wallet acted. Its outgoing messages are the transfers.
    for (const m of row.out_msgs ?? []) {
      const dest = m.destination?.toLowerCase()
      if (!dest) continue
      const value = big(m.value)
      if (value > 0n) transfers.push({ token: null, from: own, to: dest, amount: value })
      if (!call && m.opcode && m.opcode !== TEXT_COMMENT_OP) {
        call = { to: dest, data: m.opcode.toLowerCase() }
        if (m.decoded_opcode) call.method = m.decoded_opcode
      }
      to ??= dest
    }
  } else {
    from = source
    to = own
    const value = big(row.in_msg?.value)
    if (value > 0n) transfers.push({ token: null, from: source, to: own, amount: value })
    const op = row.in_msg?.opcode
    if (op && op !== TEXT_COMMENT_OP) {
      call = { to: own, data: op.toLowerCase() }
      if (row.in_msg?.decoded_opcode) call.method = row.in_msg.decoded_opcode
    }
  }
  let nativeValue = 0n
  for (const t of transfers) if (t.token === null && t.from === from) nativeValue += t.amount
  const out: TonChainTx = {
    chain, hash, time: row.now, status: failed ? 'failed' : 'confirmed', address, from, to: call?.to ?? to, nativeValue, transfers, fee: big(row.total_fees), block: big(row.lt),
    raw: { backend: 'toncenter', event: row },
  }
  if (call) out.call = call
  return out
}

// ── Source ───────────────────────────────────────────────────────────────────

export function tonExplorerTxUrl(hash: string, network: 'mainnet' | 'testnet' = 'mainnet'): string {
  return `https://${network === 'testnet' ? 'testnet.' : ''}tonviewer.com/transaction/${hash}`
}

/**
 * A `HistorySource` for TON: tonapi account events first, toncenter v3 when
 * tonapi is down or disabled. Both page by `lt`, so a cursor from one backend
 * resumes on the other.
 */
export function createTonHistory(options: TonHistoryOptions = {}): TonHistorySource {
  const network = options.network ?? 'mainnet'
  const chain = CAIP2[network]
  const fetchFn: HistoryFetch = options.fetch ?? ((globalThis as { fetch?: HistoryFetch }).fetch as HistoryFetch)
  if (typeof fetchFn !== 'function') throw new Error('@anywalletkit/wallet-ton: no global fetch; pass `fetch` in the options')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const tonapiUrl = options.tonapiUrl === null ? undefined : (options.tonapiUrl ?? (network === 'testnet' ? 'https://testnet.tonapi.io' : 'https://tonapi.io')).replace(/\/+$/, '')
  const toncenterUrl = options.toncenterUrl === null ? undefined : (options.toncenterUrl ?? (network === 'testnet' ? 'https://testnet.toncenter.com' : 'https://toncenter.com')).replace(/\/+$/, '')
  if (!tonapiUrl && !toncenterUrl) throw new Error('@anywalletkit/wallet-ton: createTonHistory needs tonapi or toncenter')
  const tonapiBucket = new TokenBucket(options.rateLimit ?? (options.apiKey ? 10 : 1))
  const toncenterBucket = new TokenBucket(options.toncenterApiKey ? 10 : 1)

  async function getJson(backend: TonHistoryBackend, url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    await (backend === 'tonapi' ? tonapiBucket : toncenterBucket).acquire()
    let res: Awaited<ReturnType<HistoryFetch>>
    try {
      const signal = timeoutSignal(timeoutMs)
      res = await fetchFn(url, { headers: { accept: 'application/json', ...headers }, ...(signal ? { signal } : {}) })
    } catch (e) {
      throw new Error(`${backend}: ${e instanceof Error ? e.message : String(e)}`)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    return { status: res.status, body }
  }

  const tonapiHeaders = () => (options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
  const toncenterHeaders = () => (options.toncenterApiKey ? { 'x-api-key': options.toncenterApiKey } : {})

  const fail = (backend: TonHistoryBackend, r: { status: number; body: unknown }): never => {
    const msg = typeof r.body === 'object' && r.body !== null && typeof (r.body as { error?: unknown }).error === 'string' ? (r.body as { error: string }).error : ''
    throw new Error(`${backend}: HTTP ${r.status}${msg ? ` ${msg}` : ''}`)
  }

  async function tonapiEventFull(eventId: string): Promise<TonapiEvent | undefined> {
    const r = await getJson('tonapi', `${tonapiUrl}/v2/events/${eventId}`, tonapiHeaders())
    if (r.status === 404) return undefined
    if (r.status !== 200) fail('tonapi', r)
    return r.body as TonapiEvent
  }

  async function finishTonapi(address: string, own: string, event: TonapiEvent): Promise<TonChainTx> {
    const probe = mapActions(event.actions ?? [])
    let flow: TonapiEvent | undefined
    if (probe.needsValueFlow) {
      try {
        flow = await tonapiEventFull(event.event_id)
      } catch {
        flow = undefined // best effort: the row still carries the call
      }
    }
    return mapTonapiEvent(chain, address, own, event, flow)
  }

  async function tonapiPage(address: string, own: string, limit: number, before?: string): Promise<TonHistoryPage> {
    if (!tonapiUrl) throw new Error('tonapi: disabled')
    const q = `limit=${limit}${before ? `&before_lt=${before}` : ''}`
    const r = await getJson('tonapi', `${tonapiUrl}/v2/accounts/${encodeURIComponent(address)}/events?${q}`, tonapiHeaders())
    if (r.status !== 200) fail('tonapi', r)
    const body = r.body as { events?: TonapiEvent[]; next_from?: number | string } | undefined
    const events = body?.events ?? []
    const items: TonChainTx[] = []
    for (const e of events) items.push(await finishTonapi(address, own, e))
    const page: TonHistoryPage = { items, backend: 'tonapi' }
    if (events.length >= limit) {
      const last = events[events.length - 1]!
      page.cursor = encodeCursor({ v: 1, b: 'tonapi', lt: String(body?.next_from ?? last.lt) })
    }
    return page
  }

  async function toncenterPage(address: string, limit: number, before?: string): Promise<TonHistoryPage> {
    if (!toncenterUrl) throw new Error('toncenter: disabled')
    const endLt = before ? (BigInt(before) - 1n).toString() : undefined
    const q = `account=${encodeURIComponent(address)}&limit=${limit}&sort=desc${endLt ? `&end_lt=${endLt}` : ''}`
    const r = await getJson('toncenter', `${toncenterUrl}/api/v3/transactions?${q}`, toncenterHeaders())
    if (r.status !== 200) fail('toncenter', r)
    const rows = (r.body as { transactions?: V3Transaction[] } | undefined)?.transactions ?? []
    const items = rows.map((row) => mapToncenterTransaction(chain, address, row))
    const page: TonHistoryPage = { items, backend: 'toncenter' }
    if (rows.length >= limit) page.cursor = encodeCursor({ v: 1, b: 'toncenter', lt: rows[rows.length - 1]!.lt })
    return page
  }

  const backends: TonHistoryBackend[] = [...(tonapiUrl ? ['tonapi' as const] : []), ...(toncenterUrl ? ['toncenter' as const] : [])]

  return {
    chain,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<TonHistoryPage> {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)))
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      const own = rawTonAddress(address)
      const ordered = cursor ? [...backends].sort((a, b) => (a === cursor.b ? -1 : b === cursor.b ? 1 : 0)) : backends
      const attempts: string[] = []
      for (const b of ordered) {
        try {
          let page = b === 'tonapi' ? await tonapiPage(address, own, limit, cursor?.lt) : await toncenterPage(address, limit, cursor?.lt)
          if (query.since !== undefined) {
            const since = query.since
            if (page.items.some((t) => t.time < since)) delete page.cursor
            page = { ...page, items: page.items.filter((t) => t.time >= since) }
          }
          return page
        } catch (e) {
          attempts.push(e instanceof Error ? e.message : String(e))
        }
      }
      throw new HistoryUnavailableError(chain, attempts[attempts.length - 1] ?? 'no backend configured', attempts)
    },

    async getTransaction(hash: string, address: string): Promise<TonChainTx | undefined> {
      const own = rawTonAddress(address)
      const attempts: string[] = []
      for (const b of backends) {
        try {
          if (b === 'tonapi') {
            const r = await getJson('tonapi', `${tonapiUrl}/v2/accounts/${encodeURIComponent(address)}/events/${encodeURIComponent(hash)}`, tonapiHeaders())
            if (r.status === 404) return undefined
            if (r.status !== 200) fail('tonapi', r)
            return await finishTonapi(address, own, r.body as TonapiEvent)
          }
          const r = await getJson('toncenter', `${toncenterUrl}/api/v3/transactions?hash=${encodeURIComponent(hash)}`, toncenterHeaders())
          if (r.status !== 200) fail('toncenter', r)
          const rows = (r.body as { transactions?: V3Transaction[] } | undefined)?.transactions ?? []
          const row = rows.find((x) => x.account.toLowerCase() === own) ?? rows[0]
          return row ? mapToncenterTransaction(chain, address, row) : undefined
        } catch (e) {
          attempts.push(e instanceof Error ? e.message : String(e))
        }
      }
      throw new HistoryUnavailableError(chain, attempts[attempts.length - 1] ?? 'no backend configured', attempts)
    },

    explorerTxUrl(hash: string): string {
      return tonExplorerTxUrl(hash, network)
    },
  }
}
