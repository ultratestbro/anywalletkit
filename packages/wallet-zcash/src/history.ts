/**
 * Activity history for Zcash transparent addresses: a `HistorySource` over
 * Blockchair's address dashboard (transaction hashes, newest first) and
 * transaction dashboards (inputs / outputs with addresses and values, fetched
 * ten at a time). Shielded legs of a transaction show up only as the
 * transparent value that entered or left it.
 */
import type { ChainTransfer, ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { BlockchairClient, blockchairTime, type BlockchairTxDashboard } from './blockchair.js'
import { DEFAULT_TIMEOUT_MS } from './http.js'
import { CAIP2 } from './types.js'

/** Options for {@link createZcashHistory}. */
export interface ZcashHistoryOptions {
  /** Blockchair base (`https://api.blockchair.com/zcash`); optional API key. */
  blockchairUrl?: string
  key?: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Rows per page (max 100). Default: the query limit, capped at 100. */
  pageSize?: number
}

export interface ZcashHistoryRaw {
  tx: BlockchairTxDashboard
  ownIn: bigint
  ownOut: bigint
}

export interface ZcashChainTx extends ChainTx { raw: ZcashHistoryRaw }

export interface ZcashHistoryPage extends HistoryPage {
  items: ZcashChainTx[]
  offset: number
  total?: number
}

/** Zcash transparent-address history from Blockchair. Build it with {@link createZcashHistory}. */
export interface ZcashHistorySource extends HistorySource {
  listActivity(address: string, query?: HistoryQuery): Promise<ZcashHistoryPage>
  getTransaction(hash: string, address: string): Promise<ZcashChainTx | undefined>
}

/** The history backend failed. */
export class HistoryUnavailableError extends Error {
  readonly chain: string
  readonly reason: string
  constructor(chain: string, reason: string) {
    super(`History unavailable for ${chain}: ${reason}`)
    this.name = 'HistoryUnavailableError'
    this.chain = chain
    this.reason = reason
  }
}

const DEFAULT_LIMIT = 25
const MAX_PAGE_SIZE = 100

export interface ZcashHistoryCursor { v: 1; o: number; s: number }

export function encodeCursor(c: ZcashHistoryCursor): string {
  return `${c.v}:${c.o}:${c.s}`
}

export function decodeCursor(s: string): ZcashHistoryCursor {
  const m = /^1:(\d+):(\d+)$/.exec(s)
  if (!m) throw new Error('@anywalletkit/wallet-zcash: malformed history cursor')
  const o = Number(m[1]), size = Number(m[2])
  if (size < 1) throw new Error('@anywalletkit/wallet-zcash: malformed history cursor')
  return { v: 1, o, s: size }
}

export function mapDashboardTx(chain: string, address: string, d: BlockchairTxDashboard): ZcashChainTx {
  let ownIn = 0n, ownOut = 0n, sentToOthers = 0n
  for (const i of d.inputs) if (i.recipient === address) ownIn += BigInt(i.value)
  for (const o of d.outputs) { if (o.recipient === address) ownOut += BigInt(o.value); else sentToOthers += BigInt(o.value) }
  const firstInput = d.inputs.find((i) => i.recipient)?.recipient
  const firstOther = d.outputs.find((o) => o.recipient && o.recipient !== address)?.recipient
  const transfers: ChainTransfer[] = []
  let from: string, to: string | null, nativeValue: bigint
  if (ownIn > 0n) {
    from = address
    to = firstOther ?? address
    nativeValue = firstOther ? sentToOthers : ownOut
    if (nativeValue > 0n) transfers.push({ token: null, from: address, to, amount: nativeValue })
  } else {
    from = firstInput ?? (d.inputs.length === 0 ? 'shielded' : 'coinbase')
    to = address
    nativeValue = ownOut
    if (nativeValue > 0n) transfers.push({ token: null, from, to: address, amount: nativeValue })
  }
  const t = d.transaction as BlockchairTxDashboard['transaction'] & { confirmations?: number }
  const confirmed = t.block_id > 0
  const out: ZcashChainTx = {
    chain, hash: t.hash, time: blockchairTime(t.time) ?? 0, status: confirmed ? 'confirmed' : 'pending', address, from, to, nativeValue, transfers,
    raw: { tx: d, ownIn, ownOut },
  }
  if (typeof t.fee === 'number') out.fee = BigInt(t.fee)
  if (confirmed) out.block = BigInt(t.block_id)
  return out
}

/** Blockchair link for a transaction. */
export function zcashExplorerTxUrl(hash: string): string {
  return `https://blockchair.com/zcash/transaction/${hash}`
}

/**
 * A history source for transparent Zcash addresses backed by Blockchair (mainnet).
 *
 * @throws Error when no `fetch` is available.
 */
export function createZcashHistory(options: ZcashHistoryOptions = {}): ZcashHistorySource {
  const chain = CAIP2.mainnet
  const fetchFn = options.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') throw new Error('@anywalletkit/wallet-zcash: no global fetch; pass `fetch` in the options')
  const client = new BlockchairClient({ ...(options.blockchairUrl ? { url: options.blockchairUrl } : {}), ...(options.key ? { key: options.key } : {}) }, fetchFn, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run() } catch (e) { throw new HistoryUnavailableError(chain, e instanceof Error ? e.message : String(e)) }
  }

  return {
    chain,

    async listActivity(address: string, query: HistoryQuery = {}): Promise<ZcashHistoryPage> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
      const pageSize = cursor?.s ?? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? query.limit ?? DEFAULT_LIMIT)))
      const offset = cursor?.o ?? 0
      const { hashes, total } = await wrap(() => client.listTransactions(address, pageSize, offset))
      const dashboards = hashes.length ? await wrap(() => client.getTransactionDashboards(hashes)) : new Map()
      let items = hashes.map((h) => dashboards.get(h)).filter((d): d is BlockchairTxDashboard => !!d).map((d) => mapDashboardTx(chain, address, d))
      items.sort((a, b) => (b.block === undefined ? 1 : a.block === undefined ? -1 : (b.block > a.block ? 1 : b.block < a.block ? -1 : 0)) || b.time - a.time)
      let more = total !== undefined ? offset + hashes.length < total : hashes.length === pageSize
      if (query.since !== undefined) {
        const since = query.since
        if (items.some((t) => t.status === 'confirmed' && t.time < since)) more = false
        items = items.filter((t) => t.status !== 'confirmed' || t.time >= since)
      }
      const page: ZcashHistoryPage = { items, offset, ...(total !== undefined ? { total } : {}) }
      if (more) page.cursor = encodeCursor({ v: 1, o: offset + hashes.length, s: pageSize })
      return page
    },

    async getTransaction(hash: string, address: string): Promise<ZcashChainTx | undefined> {
      const d = await wrap(() => client.getTransactionDashboard(hash))
      return d ? mapDashboardTx(chain, address, d) : undefined
    },

    explorerTxUrl: zcashExplorerTxUrl,
  }
}
