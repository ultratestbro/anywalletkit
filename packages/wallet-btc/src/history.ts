/**
 * Activity history for Bitcoin: a `HistorySource` over Blockbook's
 * `/api/v2/address/{a}?details=txs` pages (Trezor's indexer, QuickNode's
 * Blockbook add-on, any self-hosted instance), reusing the package's
 * `BlockbookClient` and failing over across several instances.
 *
 * One transaction = one native transfer in the owner's direction: a send is
 * what left to non-own outputs (fee separate), a receive is what landed on the
 * address. The cursor is the Blockbook page number. Explorer: mempool.space.
 */
import type { ChainTransfer, ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@forgewallet/core'
import { BlockbookClient, type BlockbookAddressPage, type BlockbookTxDetails } from './blockbook.js'
import { DEFAULT_TIMEOUT_MS } from './http.js'
import { CAIP2_GENESIS, type BtcNetwork } from './types.js'

// ── Public types ─────────────────────────────────────────────────────────────

export interface BtcHistoryOptions {
  /** One Blockbook root (`https://btc1.trezor.io`). */
  blockbookUrl?: string
  /** Several roots, tried in order (failover). */
  blockbookUrls?: string[]
  /** `bitcoin` (default), `testnet`, `regtest`. */
  network?: BtcNetwork
  fetch?: typeof fetch
  /** Per request, ms. Default 15 000. */
  timeoutMs?: number
  /** Rows per Blockbook page (its max is 1000). Default: the query limit, capped at 100. */
  pageSize?: number
}

export interface BtcHistoryRaw {
  /** The Blockbook transaction (vin / vout with addresses and values; `hex` dropped). */
  tx: BlockbookTxDetails
  /** Sum of inputs spent by the address, sats. */
  ownIn: bigint
  /** Sum of outputs paid to the address, sats. */
  ownOut: bigint
}

export interface BtcChainTx extends ChainTx {
  raw: BtcHistoryRaw
}

export interface BtcHistoryPage extends HistoryPage {
  items: BtcChainTx[]
  /** Blockbook page served / total pages. */
  page?: number
  totalPages?: number
}

export interface BtcHistorySource extends HistorySource {
  listActivity(address: string, query?: HistoryQuery): Promise<BtcHistoryPage>
  getTransaction(hash: string, address: string): Promise<BtcChainTx | undefined>
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
const MAX_PAGE_SIZE = 100

// ── Cursor: the next Blockbook page, base64 JSON ─────────────────────────────

export interface BtcHistoryCursor {
  v: 1
  /** Next page (1-based). */
  p: number
  /** Page size the pagination started with (changing it mid-way would skip or repeat rows). */
  s: number
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64encode(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i += 3) {
    const c = [s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2)]
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

export function encodeCursor(c: BtcHistoryCursor): string {
  return b64encode(JSON.stringify(c))
}

export function decodeCursor(s: string): BtcHistoryCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(b64decode(s))
  } catch {
    throw new Error('@forgewallet/wallet-btc: malformed history cursor')
  }
  const c = parsed as Partial<BtcHistoryCursor> | null
  if (!c || c.v !== 1 || !Number.isInteger(c.p) || (c.p as number) < 1 || !Number.isInteger(c.s) || (c.s as number) < 1) throw new Error('@forgewallet/wallet-btc: malformed history cursor')
  return { v: 1, p: c.p as number, s: c.s as number }
}

// ── Mapping ──────────────────────────────────────────────────────────────────

const big = (v: unknown): bigint => (typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === 'number' ? BigInt(Math.trunc(v)) : 0n)

export function mapBlockbookTx(chain: string, address: string, tx: BlockbookTxDetails): BtcChainTx {
  const owns = (e: { isAddress?: boolean; addresses?: string[] }) => e.isAddress !== false && (e.addresses ?? []).includes(address)
  let ownIn = 0n, ownOut = 0n, sentToOthers = 0n
  for (const vin of tx.vin ?? []) if (owns(vin)) ownIn += big(vin.value)
  for (const vout of tx.vout ?? []) {
    if (owns(vout)) ownOut += big(vout.value)
    else sentToOthers += big(vout.value)
  }
  const firstInput = (tx.vin ?? []).find((v) => v.isAddress !== false && v.addresses?.[0])?.addresses?.[0]
  const firstOtherOutput = (tx.vout ?? []).find((v) => v.isAddress !== false && !owns(v) && v.addresses?.[0])?.addresses?.[0]
  const transfers: ChainTransfer[] = []
  let from: string, to: string | null, nativeValue: bigint
  if (ownIn > 0n) {
    // We spent inputs: a send (or a consolidation when every output is ours).
    from = address
    to = firstOtherOutput ?? address
    nativeValue = firstOtherOutput ? sentToOthers : ownOut
    if (nativeValue > 0n) transfers.push({ token: null, from: address, to, amount: nativeValue })
  } else {
    // Only outputs are ours: a receive (coinbase has no input address).
    from = firstInput ?? 'coinbase'
    to = address
    nativeValue = ownOut
    if (nativeValue > 0n) transfers.push({ token: null, from, to: address, amount: nativeValue })
  }
  const confirmed = tx.confirmations > 0 && tx.blockHeight > 0
  const out: BtcChainTx = {
    chain, hash: tx.txid, time: tx.blockTime ?? 0, status: confirmed ? 'confirmed' : 'pending', address, from, to, nativeValue, transfers,
    raw: { tx, ownIn, ownOut },
  }
  if (tx.fees !== undefined) out.fee = big(tx.fees)
  if (confirmed) out.block = BigInt(tx.blockHeight)
  return out
}

// ── Source ───────────────────────────────────────────────────────────────────

export function btcExplorerTxUrl(hash: string, network: BtcNetwork = 'bitcoin'): string {
  return `https://mempool.space/${network === 'testnet' ? 'testnet/' : ''}tx/${hash}`
}

export function createBtcHistory(options: BtcHistoryOptions = {}): BtcHistorySource {
  const network = options.network ?? 'bitcoin'
  const chain = CAIP2_GENESIS[network]
  const urls = [...(options.blockbookUrls ?? []), ...(options.blockbookUrl ? [options.blockbookUrl] : [])]
  if (urls.length === 0) throw new Error('@forgewallet/wallet-btc: createBtcHistory needs blockbookUrl or blockbookUrls')
  const fetchFn = options.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') throw new Error('@forgewallet/wallet-btc: no global fetch; pass `fetch` in the options')
  const clients = urls.map((url) => ({ url, client: new BlockbookClient({ url }, fetchFn, options.timeoutMs ?? DEFAULT_TIMEOUT_MS) }))

  async function failover<T>(run: (client: BlockbookClient) => Promise<T>): Promise<T> {
    const attempts: string[] = []
    for (const { url, client } of clients) {
      try {
        return await run(client)
      } catch (e) {
        attempts.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    throw new HistoryUnavailableError(chain, attempts[attempts.length - 1] ?? 'every Blockbook failed', attempts)
  }

  return {
    chain,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<BtcHistoryPage> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      const pageSize = cursor?.s ?? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? query.limit ?? DEFAULT_LIMIT)))
      const pageNo = cursor?.p ?? 1
      const data: BlockbookAddressPage = await failover((c) => c.getAddressPage(address, pageNo, pageSize))
      let items = (data.transactions ?? []).map((tx) => mapBlockbookTx(chain, address, tx))
      items.sort((a, b) => (b.block === undefined ? 1 : a.block === undefined ? -1 : Number(b.block - a.block)) || b.time - a.time)
      const totalPages = data.totalPages ?? 1
      let more = pageNo < totalPages
      if (query.since !== undefined) {
        const since = query.since
        if (items.some((t) => t.status === 'confirmed' && t.time < since)) more = false
        items = items.filter((t) => t.status !== 'confirmed' || t.time >= since)
      }
      const page: BtcHistoryPage = { items, page: pageNo, totalPages }
      if (more) page.cursor = encodeCursor({ v: 1, p: pageNo + 1, s: pageSize })
      return page
    },

    async getTransaction(hash: string, address: string): Promise<BtcChainTx | undefined> {
      const tx = await failover((c) => c.getTransactionDetails(hash))
      return tx ? mapBlockbookTx(chain, address, tx) : undefined
    },

    explorerTxUrl(hash: string): string {
      return btcExplorerTxUrl(hash, network)
    },
  }
}

