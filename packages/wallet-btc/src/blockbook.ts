import { NetworkError } from '@forgewallet/core'
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, isIntString, isRecord } from './http.js'
import type { BlockbookTx, BtcClient, Utxo } from './types.js'

const MEMPOOL_SPACE_URL = 'https://mempool.space'

export interface BlockbookVin { txid?: string; vout?: number; n?: number; isAddress?: boolean; isOwn?: boolean; addresses?: string[]; value?: string }
export interface BlockbookVout { n: number; isAddress?: boolean; isOwn?: boolean; addresses?: string[]; value?: string; spent?: boolean }
interface BlockbookAddressTx { txid: string; blockHeight: number; vin?: BlockbookVin[]; vout?: BlockbookVout[] }
/** A Blockbook transaction with its inputs and outputs (`/api/v2/tx/{txid}`, or one row of `?details=txs`). */
export interface BlockbookTxDetails extends BlockbookTx {
  vin?: BlockbookVin[]
  vout?: BlockbookVout[]
  value?: string
  valueIn?: string
}
/** One `/api/v2/address/{a}?details=txs` page. */
export interface BlockbookAddressPage {
  page?: number
  totalPages?: number
  itemsOnPage?: number
  address?: string
  balance?: string
  unconfirmedBalance?: string
  txs?: number
  transactions?: BlockbookTxDetails[]
}

/**
 * Pending outgoing value the way Bitcoin Core's wallet counts it: a pending tx
 * is trusted only if every input is ours and confirmed or chained from another
 * trusted tx; only then its change counts back.
 */
export function unconfirmedOutgoing(transactions: BlockbookAddressTx[] | undefined, address: string): bigint {
  const pending = (transactions ?? []).filter((tx) => tx.blockHeight === -1)
  const pendingIds = new Set(pending.map((t) => t.txid))
  const byId = new Map(pending.map((t) => [t.txid, t]))
  const trusted = new Map<string, boolean>()
  const owned = (entries: Array<BlockbookVin | BlockbookVout> | undefined) =>
    (entries ?? []).filter((e) => e.isAddress && e.addresses?.includes(address)).reduce((s, e) => s + BigInt(e.value ?? 0), 0n)
  const isTrusted = (tx: BlockbookAddressTx): boolean => {
    if (trusted.has(tx.txid)) return trusted.get(tx.txid)!
    trusted.set(tx.txid, false)
    const vins = tx.vin ?? []
    const ours = vins.filter((v) => v.isAddress && v.addresses?.includes(address))
    const ok = vins.length > 0 && ours.length === vins.length && ours.every((v) => !v.txid || !pendingIds.has(v.txid) || isTrusted(byId.get(v.txid)!))
    trusted.set(tx.txid, ok)
    return ok
  }
  const consumed = new Set<string>()
  for (const tx of pending) for (const v of tx.vin ?? []) if (v.txid && pendingIds.has(v.txid)) consumed.add(`${v.txid}:${v.vout}`)
  return pending.reduce((total, tx) => {
    const spent = owned((tx.vin ?? []).filter((v) => !v.txid || !pendingIds.has(v.txid)))
    const change = isTrusted(tx) ? owned((tx.vout ?? []).filter((o) => !consumed.has(`${tx.txid}:${o.n}`))) : 0n
    return total + (spent - change)
  }, 0n)
}

/** Blockbook REST transport (Trezor's indexer; QuickNode's Blockbook add-on speaks the same API). */
export class BlockbookClient implements BtcClient {
  private readonly base: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(config: { url: string }, fetchFn: typeof fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.base = config.url.replace(/\/+$/, '').replace(/\/api$/, '')
    this.fetchFn = fetchFn
    this.timeoutMs = timeoutMs
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  private async get<T>(path: string, check: (v: unknown) => v is T): Promise<T> {
    const url = `${this.base}/api${path}`
    const res = await fetchWithTimeout(this.fetchFn, url, undefined, this.timeoutMs, this.base)
    if (!res.ok) throw new NetworkError(`Blockbook request failed: ${res.status} ${res.statusText} (${url})`, { provider: this.base })
    let body: unknown
    try { body = await res.json() } catch (e) { throw new NetworkError(`Blockbook returned non-JSON for ${url}`, { provider: this.base, cause: e }) }
    if (!check(body)) throw new NetworkError(`Blockbook returned an unexpected shape for ${url}`, { provider: this.base })
    return body
  }

  async getBalance(address: string) {
    const data = await this.get(`/v2/address/${address}?details=txs`, (v): v is { balance: string; unconfirmedBalance: string; transactions?: BlockbookAddressTx[] } =>
      isRecord(v) && isIntString(v.balance) && isIntString(v.unconfirmedBalance) && (v.transactions === undefined || Array.isArray(v.transactions)))
    return { confirmed: BigInt(data.balance), unconfirmed: BigInt(data.unconfirmedBalance), unconfirmedOutgoing: unconfirmedOutgoing(data.transactions, address) }
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    const data = await this.get(`/v2/utxo/${address}`, (v): v is Array<{ txid: string; vout: number; value: string; height?: number }> =>
      Array.isArray(v) && v.every((u) => isRecord(u) && typeof u.txid === 'string' && typeof u.vout === 'number' && isIntString(u.value)))
    return data.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), height: u.height ?? -1 }))
  }

  async getHistory(address: string) {
    const items: Array<{ txid: string; height: number }> = []
    for (let page = 1; ; page++) {
      const data = await this.get(`/v2/address/${address}?details=txslight&pageSize=1000&page=${page}`, (v): v is { transactions?: Array<{ txid: string; blockHeight: number }>; totalPages?: number } =>
        isRecord(v) && (v.transactions === undefined || Array.isArray(v.transactions)))
      for (const tx of data.transactions ?? []) items.push({ txid: tx.txid, height: tx.blockHeight })
      if (page >= (data.totalPages ?? 1)) break
    }
    return items
  }

  /** One page of the address's transactions, newest first, with inputs / outputs (what the activity history reads). */
  async getAddressPage(address: string, page = 1, pageSize = 25): Promise<BlockbookAddressPage> {
    const data = await this.get(`/v2/address/${address}?details=txs&page=${page}&pageSize=${pageSize}`, (v): v is BlockbookAddressPage =>
      isRecord(v) && (v.transactions === undefined || (Array.isArray(v.transactions) && v.transactions.every(BlockbookClient.isTx))))
    const out: BlockbookAddressPage = { ...data }
    for (const tx of out.transactions ?? []) delete (tx as { hex?: string }).hex
    return out
  }

  /** A transaction with its inputs / outputs; undefined when Blockbook does not know it. */
  async getTransactionDetails(txid: string): Promise<BlockbookTxDetails | undefined> {
    try {
      const tx = await this.get(`/v2/tx/${txid}`, (v): v is BlockbookTxDetails => BlockbookClient.isTx(v))
      const out: BlockbookTxDetails = { ...tx }
      delete (out as { hex?: string }).hex
      return out
    } catch (e) {
      if (e instanceof NetworkError && /\b(400|404)\b/.test(e.message)) return undefined
      throw e
    }
  }

  private static isTx(v: unknown): v is BlockbookTx {
    return isRecord(v) && typeof v.txid === 'string' && typeof v.blockHeight === 'number' && typeof v.confirmations === 'number'
  }

  async getTransactionInfo(txid: string): Promise<BlockbookTx | undefined> {
    try { return await this.get(`/v2/tx/${txid}`, BlockbookClient.isTx) } catch (e) {
      if (e instanceof NetworkError && /\b(400|404)\b/.test(e.message)) return undefined
      throw e
    }
  }

  async getTransaction(txid: string): Promise<string> {
    const data = await this.get(`/v2/tx/${txid}`, BlockbookClient.isTx)
    if (typeof data.hex !== 'string' || !data.hex) throw new NetworkError(`Transaction ${txid} has no hex data`, { provider: this.base })
    return data.hex
  }

  async broadcast(rawTx: string): Promise<string> {
    const data = await this.get(`/v2/sendtx/${rawTx}`, (v): v is { result?: string; error?: { message?: string } | string } => isRecord(v))
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message ?? 'broadcast failed')
    if (!data.result) throw new NetworkError('Blockbook returned no txid', { provider: this.base })
    return data.result
  }

  /** sat/vB. Blockbook reports BTC/kB (×1e5 → sat/vB); falls back to mempool.space when it has no estimate. */
  async estimateFee(blocks: number): Promise<number> {
    try {
      const data = await this.get(`/v1/estimatefee/${blocks}`, (v): v is { result?: string } | string => typeof v === 'string' || isRecord(v))
      const rate = Number(typeof data === 'string' ? data : data.result)
      if (rate > 0) return Math.max(rate * 100_000, 1)
    } catch { /* fall through */ }
    const res = await fetchWithTimeout(this.fetchFn, `${MEMPOOL_SPACE_URL}/api/v1/fees/recommended`, undefined, this.timeoutMs, MEMPOOL_SPACE_URL)
    if (!res.ok) throw new NetworkError('Fee estimation request failed', { provider: MEMPOOL_SPACE_URL })
    const d = (await res.json()) as { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }
    const satPerVb = blocks <= 1 ? d.fastestFee : blocks <= 3 ? d.halfHourFee : blocks <= 6 ? d.hourFee : d.economyFee
    if (!satPerVb || satPerVb <= 0) throw new NetworkError('Fee estimation is unavailable', { provider: MEMPOOL_SPACE_URL })
    return satPerVb
  }

  async getBlockHeight(): Promise<number> {
    const data = await this.get('/v2', (v): v is { blockbook?: { bestHeight?: number } } => isRecord(v))
    const h = data.blockbook?.bestHeight
    if (typeof h !== 'number' || h <= 0) throw new NetworkError('Blockbook did not report a block height', { provider: this.base })
    return h
  }
}
