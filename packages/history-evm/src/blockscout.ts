import { ExplorerError } from './errors.js'
import { fetchJson, query } from './http.js'
import type { ListPage, ListSpec } from './paginate.js'
import type { TokenBucket } from './rate-limit.js'
import { parseBig, parseInt10, parseIsoSeconds, type InternalRow, type TokenRow, type TxRow } from './rows.js'
import type { FetchLike } from './types.js'

export interface BlockscoutClientOptions {
  /** Instance root, e.g. `https://eth.blockscout.com`. */
  baseUrl: string
  fetch: FetchLike
  bucket: TokenBucket
  timeoutMs: number
}

type Item = Record<string, unknown>

interface ItemsEnvelope {
  items?: unknown
  next_page_params?: unknown
  message?: unknown
}

/** Blockscout `/api/v2` client (also works against Blockscout-compatible explorers such as scrollscan.com). */
export class BlockscoutClient {
  readonly backend = 'blockscout' as const
  private readonly o: BlockscoutClientOptions
  private readonly base: string

  constructor(options: BlockscoutClientOptions) {
    this.o = options
    this.base = options.baseUrl.replace(/\/+$/, '')
  }

  url(path: string, params?: Record<string, string | number | undefined>): string {
    const qs = params ? query(params) : ''
    return `${this.base}/api/v2${path}${qs ? `?${qs}` : ''}`
  }

  /** GET with the limiter; one retry on 429/5xx; 404 → `undefined` (unknown address / tx). */
  async get(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = this.url(path, params)
    let last: ExplorerError | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.o.bucket.acquire()
      const res = await fetchJson(this.o.fetch, this.backend, url, this.o.timeoutMs)
      if (res.status === 404) return undefined
      if (res.status === 429 || res.status >= 500) {
        last = new ExplorerError(this.backend, res.status === 429 ? 'rate-limit' : 'http', `HTTP ${res.status}`)
        continue
      }
      if (res.status >= 400) throw new ExplorerError(this.backend, res.status === 403 ? 'unavailable' : 'http', `HTTP ${res.status}`)
      if (res.body === undefined || typeof res.body !== 'object') throw new ExplorerError(this.backend, 'unavailable', 'non-JSON response')
      return res.body
    }
    throw last ?? new ExplorerError(this.backend, 'http', 'failed')
  }

  private async list(path: string, cursor: unknown, extra?: Record<string, string>): Promise<{ items: Item[]; next: unknown }> {
    const params: Record<string, string | number | undefined> = { ...(extra ?? {}) }
    if (cursor && typeof cursor === 'object') {
      for (const [k, v] of Object.entries(cursor as Record<string, unknown>)) {
        if (v === null || v === undefined) continue
        params[k] = typeof v === 'number' ? v : String(v)
      }
    }
    const body = (await this.get(path, params)) as ItemsEnvelope | undefined
    if (!body) return { items: [], next: null }
    const items = Array.isArray(body.items) ? (body.items as Item[]) : []
    const next = body.next_page_params && typeof body.next_page_params === 'object' ? body.next_page_params : null
    return { items, next }
  }

  /**
   * Address lists as window-pagination specs. Blockscout pages are fixed at 50
   * items and carry their own `next_page_params`; `limit` is a hint only.
   */
  listSpecs(address: string): ListSpec<{ block: number }>[] {
    const spec = <R extends { block: number }>(key: string, path: string, parse: (i: Item) => R | undefined, extra?: Record<string, string>): ListSpec<R> => ({
      key,
      fetch: async (cursor): Promise<ListPage<R>> => {
        const { items, next } = await this.list(path, cursor, extra)
        const rows: R[] = []
        for (const i of items) {
          const p = parse(i)
          if (p) rows.push(p)
        }
        return { rows, next }
      },
    })
    return [
      spec('tx', `/addresses/${address}/transactions`, parseBlockscoutTx),
      spec('tokens', `/addresses/${address}/token-transfers`, parseBlockscoutTokenTransfer, { type: 'ERC-20' }),
      spec('internal', `/addresses/${address}/internal-transactions`, parseBlockscoutInternal),
    ]
  }

  async getTransaction(hash: string): Promise<{ tx: TxRow; tokens: TokenRow[]; internal: InternalRow[] } | undefined> {
    const item = (await this.get(`/transactions/${hash}`)) as Item | undefined
    if (!item || typeof item['hash'] !== 'string') return undefined
    const tx = parseBlockscoutTx(item)
    if (!tx) return undefined
    const tokens: TokenRow[] = []
    const internal: InternalRow[] = []
    try {
      const tt = (await this.get(`/transactions/${hash}/token-transfers`, { type: 'ERC-20' })) as ItemsEnvelope | undefined
      for (const i of Array.isArray(tt?.items) ? (tt.items as Item[]) : []) {
        const row = parseBlockscoutTokenTransfer(i)
        if (row) tokens.push(row.time ? row : { ...row, time: tx.time })
      }
    } catch {
      /* token transfers are best effort */
    }
    try {
      const it = (await this.get(`/transactions/${hash}/internal-transactions`)) as ItemsEnvelope | undefined
      for (const i of Array.isArray(it?.items) ? (it.items as Item[]) : []) {
        const row = parseBlockscoutInternal(i)
        if (row) internal.push(row)
      }
    } catch {
      /* best effort */
    }
    return { tx, tokens, internal }
  }
}

// --- item parsers (exported for tests) ---

function hashOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof (v as { hash?: unknown }).hash === 'string') return (v as { hash: string }).hash
  return ''
}

export function parseBlockscoutTx(i: Item): TxRow | undefined {
  const hash = i['hash']
  if (typeof hash !== 'string') return undefined
  const status = i['status']
  const txStatus: TxRow['status'] = status === 'ok' ? 'confirmed' : status === 'error' ? 'failed' : i['block_number'] ? 'confirmed' : 'pending'
  const to = hashOf(i['to'])
  const created = hashOf(i['created_contract'])
  const row: TxRow = {
    hash,
    block: parseInt10(i['block_number']),
    time: parseIsoSeconds(i['timestamp']),
    from: hashOf(i['from']),
    to: to || null,
    value: parseBig(i['value']),
    input: typeof i['raw_input'] === 'string' && i['raw_input'] ? (i['raw_input'] as string) : '0x',
    status: txStatus,
    raw: i,
  }
  const fee = i['fee']
  if (fee && typeof fee === 'object' && (fee as { value?: unknown }).value !== undefined) row.fee = parseBig((fee as { value: unknown }).value)
  else {
    const gasUsed = parseBig(i['gas_used']), price = parseBig(i['gas_price'])
    if (gasUsed > 0n && price > 0n) row.fee = gasUsed * price
  }
  if (created) row.contractAddress = created
  return row
}

export function parseBlockscoutTokenTransfer(i: Item): TokenRow | undefined {
  const hash = i['transaction_hash'] ?? i['tx_hash']
  const token = i['token']
  if (typeof hash !== 'string' || !token || typeof token !== 'object') return undefined
  const t = token as Item
  const type = String(i['token_type'] ?? t['type'] ?? '')
  if (type && type !== 'ERC-20') return undefined // NFTs out of scope in v1
  const address = (t['address_hash'] ?? t['address']) as unknown
  if (typeof address !== 'string' || !address) return undefined
  const total = (i['total'] ?? {}) as Item
  const row: TokenRow = {
    hash,
    block: parseInt10(i['block_number']),
    time: parseIsoSeconds(i['timestamp']),
    from: hashOf(i['from']),
    to: hashOf(i['to']),
    token: address.toLowerCase(),
    amount: parseBig(total['value']),
    raw: i,
  }
  if (typeof t['symbol'] === 'string' && t['symbol']) row.symbol = t['symbol'] as string
  const dec = total['decimals'] ?? t['decimals']
  if ((typeof dec === 'string' && dec !== '') || typeof dec === 'number') row.decimals = parseInt10(dec)
  return row
}

export function parseBlockscoutInternal(i: Item): InternalRow | undefined {
  const hash = i['transaction_hash']
  if (typeof hash !== 'string') return undefined
  if (i['success'] === false || (typeof i['error'] === 'string' && i['error'])) return undefined
  return {
    hash,
    block: parseInt10(i['block_number']),
    time: parseIsoSeconds(i['timestamp']),
    from: hashOf(i['from']),
    to: hashOf(i['to']),
    value: parseBig(i['value']),
    raw: i,
  }
}
