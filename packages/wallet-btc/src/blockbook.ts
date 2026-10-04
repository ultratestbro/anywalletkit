import { NetworkError, NotImplementedError } from '@forgewallet/core'
import type { BlockbookTx, BtcClient, BtcClientConfig, BtcConfig, Utxo } from './types.js'

const MEMPOOL_SPACE_URL = 'https://mempool.space'

interface BlockbookVin { txid?: string; vout?: number; isAddress?: boolean; addresses?: string[]; value?: string }
interface BlockbookVout { n: number; isAddress?: boolean; addresses?: string[]; value?: string }
interface BlockbookAddressTx { txid: string; blockHeight: number; vin?: BlockbookVin[]; vout?: BlockbookVout[] }

/**
 * Pending outgoing value the way Bitcoin Core's wallet counts it:
 * a pending tx is trusted only if every input is ours and confirmed or
 * chained from another trusted tx; only then its change counts back.
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

/** Blockbook REST transport (Trezor's indexer; also what common `blockbook-http` clients speak). */
export class BlockbookClient implements BtcClient {
  private readonly base: string
  private readonly fetchFn: typeof fetch

  constructor(config: { url: string }, fetchFn: typeof fetch = globalThis.fetch) {
    this.base = config.url.replace(/\/+$/, '').replace(/\/api$/, '')
    this.fetchFn = fetchFn
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  private async get<T>(path: string): Promise<T> {
    const url = `${this.base}/api${path}`
    let res: Response
    try { res = await this.fetchFn(url) } catch (e) { throw new NetworkError(`Blockbook request failed: ${url}`, { provider: this.base, cause: e }) }
    if (!res.ok) throw new NetworkError(`Blockbook request failed: ${res.status} ${res.statusText} (${url})`, { provider: this.base })
    return res.json() as Promise<T>
  }

  async getBalance(address: string) {
    const data = await this.get<{ balance: string; unconfirmedBalance: string; transactions?: BlockbookAddressTx[] }>(`/v2/address/${address}?details=txs`)
    return { confirmed: BigInt(data.balance), unconfirmed: BigInt(data.unconfirmedBalance), unconfirmedOutgoing: unconfirmedOutgoing(data.transactions, address) }
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    const data = await this.get<Array<{ txid: string; vout: number; value: string; height?: number }>>(`/v2/utxo/${address}`)
    return data.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), height: u.height ?? -1 }))
  }

  async getHistory(address: string) {
    const items: Array<{ txid: string; height: number }> = []
    for (let page = 1; ; page++) {
      const data = await this.get<{ transactions?: Array<{ txid: string; blockHeight: number }>; totalPages?: number }>(`/v2/address/${address}?details=txslight&pageSize=1000&page=${page}`)
      for (const tx of data.transactions ?? []) items.push({ txid: tx.txid, height: tx.blockHeight })
      if (page >= (data.totalPages ?? 1)) break
    }
    return items
  }

  async getTransactionInfo(txid: string): Promise<BlockbookTx | undefined> {
    try { return await this.get<BlockbookTx>(`/v2/tx/${txid}`) } catch (e) {
      if (e instanceof NetworkError && /\b(400|404)\b/.test(e.message)) return undefined
      throw e
    }
  }

  async getTransaction(txid: string): Promise<string> {
    const data = await this.get<BlockbookTx>(`/v2/tx/${txid}`)
    if (!data.hex) throw new Error(`Transaction ${txid} has no hex data`)
    return data.hex
  }

  async broadcast(rawTx: string): Promise<string> {
    const data = await this.get<{ result?: string; error?: { message?: string } | string }>(`/v2/sendtx/${rawTx}`)
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message ?? 'broadcast failed')
    if (!data.result) throw new Error('Blockbook returned no txid')
    return data.result
  }

  /** sat/vB. Blockbook reports BTC/kB (×1e5 → sat/vB); falls back to mempool.space when it has no estimate. */
  async estimateFee(blocks: number): Promise<number> {
    try {
      const data = await this.get<{ result?: string } | string>(`/v1/estimatefee/${blocks}`)
      const rate = Number(typeof data === 'string' ? data : data.result)
      if (rate > 0) return Math.max(rate * 100_000, 1)
    } catch { /* fall through */ }
    const res = await this.fetchFn(`${MEMPOOL_SPACE_URL}/api/v1/fees/recommended`)
    if (!res.ok) throw new NetworkError('Fee estimation request failed', { provider: MEMPOOL_SPACE_URL })
    const d = (await res.json()) as { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number }
    const satPerVb = blocks <= 1 ? d.fastestFee : blocks <= 3 ? d.halfHourFee : blocks <= 6 ? d.hourFee : d.economyFee
    if (!satPerVb || satPerVb <= 0) throw new NetworkError('Fee estimation is unavailable', { provider: MEMPOOL_SPACE_URL })
    return satPerVb
  }
}

const isClient = (c: unknown): c is BtcClient => typeof c === 'object' && c !== null && typeof (c as BtcClient).listUnspent === 'function'

function toClient(c: BtcClientConfig | BtcClient, fetchFn: typeof fetch | undefined): BtcClient {
  if (isClient(c)) return c
  switch (c.type) {
    case 'blockbook-http': return new BlockbookClient(c.clientConfig, fetchFn)
    case 'electrum-ws': throw new NotImplementedError('electrum-ws transport (use blockbook-http in this version)')
    default: throw new Error(`Unknown BTC client type: ${String((c as { type: string }).type)}`)
  }
}

/** One client, or a failover client over the list: each call walks the list in order, `retries` extra rounds. */
export function createClient(config: BtcConfig): BtcClient | undefined {
  if (config.client === undefined) return undefined
  const list = (Array.isArray(config.client) ? config.client : [config.client]).map((c) => toClient(c, config.fetch))
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  const call = (method: keyof BtcClient) => async (...args: unknown[]) => {
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      const c = list[i % list.length]! as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      try { return await c[method]!(...args) } catch (e) { last = e }
    }
    throw new NetworkError(`All BTC clients failed for ${method}`, { cause: last })
  }
  return {
    connect: call('connect') as BtcClient['connect'], close: call('close') as BtcClient['close'],
    getBalance: call('getBalance') as BtcClient['getBalance'], listUnspent: call('listUnspent') as BtcClient['listUnspent'],
    getHistory: call('getHistory') as BtcClient['getHistory'], getTransaction: call('getTransaction') as BtcClient['getTransaction'],
    getTransactionInfo: call('getTransactionInfo') as NonNullable<BtcClient['getTransactionInfo']>, broadcast: call('broadcast') as BtcClient['broadcast'],
    estimateFee: call('estimateFee') as BtcClient['estimateFee'],
  }
}
