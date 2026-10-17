import { ExplorerError } from './errors.js'
import { postJson } from './http.js'
import type { ListPage, ListSpec } from './paginate.js'
import { sleep, type TokenBucket } from './rate-limit.js'
import { parseReceiptTransfers, txRowFromRpc } from './rpc-rows.js'
import { parseBig, parseInt10, parseIsoSeconds, type ExplorerRows, type InternalRow, type TokenRow, type TxRow } from './rows.js'
import type { FetchLike } from './types.js'

/**
 * Alchemy backend: `alchemy_getAssetTransfers` (Transfers API) for the address
 * lists, plain JSON-RPC on the same endpoint for what the Transfers API lacks
 * (fee, status, calldata). Free tier: 30M CU / month; a Transfers call is
 * 120 CU, `eth_getTransactionByHash` 15 CU, `eth_getTransactionReceipt` 15 CU.
 *
 * Lists: one per direction (`fromAddress`, `toAddress`), both paged by block
 * (`toBlock = below - 1`, `order: desc`, `maxCount = limit`) exactly like the
 * Etherscan lists. The API's own `pageKey` is deliberately NOT used as the
 * list cursor: measured 2026-10-14 on base-mainnet, a request carrying a
 * `pageKey` ignores `toBlock`, an unknown / expired pageKey (TTL 10 min)
 * silently restarts from the first page, and a malformed one is a 400 — none
 * of which fits a cursor that may be resumed hours later or re-fetched with a
 * narrower window. Block paging has no TTL and is idempotent.
 */

export interface AlchemyClientOptions {
  /** Network slug, e.g. `base-mainnet`. */
  network: string
  apiKey: string
  /** `https://{network}.g.alchemy.com/v2/{key}` by default. */
  urlTemplate?: string
  /** Ask for the `internal` category (only where Alchemy supports it; elsewhere the call is rejected). */
  internal: boolean
  fetch: FetchLike
  bucket: TokenBucket
  timeoutMs: number
}

type Row = Record<string, unknown>

interface RpcError {
  code?: unknown
  message?: unknown
}

interface RpcResponse {
  id?: unknown
  result?: unknown
  error?: RpcError | string
}

/** One normalized Transfers API row (the `block` field is what the window engine pages on). */
export interface AlchemyTransfer {
  block: number
  uniqueId: string
  hash: string
  from: string
  to: string
  category: string
  /** Token contract (lower-cased) for `erc20`; undefined for native. */
  token?: string
  /** Raw integer amount (wei / token base units) from `rawContract.value`. */
  amount: bigint
  symbol?: string
  decimals?: number
  /** Unix seconds from `metadata.blockTimestamp`; 0 when absent. */
  time: number
  raw: Row
}

/** Rows of `alchemy_getAssetTransfers` we fold into a tx. ERC-721 / 1155 / special NFTs are skipped. */
const CATEGORIES = ['external', 'erc20'] as const

/** Requests per JSON-RPC batch (Alchemy accepts far more; 20 keeps answers small and retries cheap). */
const BATCH_SIZE = 10
/**
 * Alchemy meters throughput in compute units per second, not HTTP calls: a
 * batch costs the sum of its members. Published per-method costs; anything
 * unlisted is charged the generic 26.
 */
const COMPUTE_UNITS: Readonly<Record<string, number>> = {
  alchemy_getAssetTransfers: 120,
  eth_getTransactionReceipt: 20,
  eth_getTransactionByHash: 17,
  eth_getBlockByNumber: 16,
  eth_blockNumber: 10,
}
const DEFAULT_COMPUTE_UNITS = 26
const costOf = (body: unknown): number =>
  (Array.isArray(body) ? body : [body]).reduce<number>((sum, r) => sum + (COMPUTE_UNITS[String((r as { method?: unknown })?.method)] ?? DEFAULT_COMPUTE_UNITS), 0)
/** Rate-limit answers are retried this many times in total, with exponential backoff. */
const MAX_ATTEMPTS = 4

const UNAVAILABLE_PATTERNS = [/not enabled for this app/i, /unauthorized/i, /invalid api key/i, /forbidden/i, /must be authenticated/i, /not supported/i, /unsupported method/i, /method not found/i, /does not exist/i]
const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /throughput/i, /capacity/i, /compute units? per second/i]

export class AlchemyClient {
  readonly backend = 'alchemy' as const
  private readonly o: AlchemyClientOptions
  readonly url: string
  /** Last enrichment failure `toRows` absorbed (tests / diagnostics); cleared on the next successful batch. */
  degraded: ExplorerError | undefined

  constructor(options: AlchemyClientOptions) {
    this.o = options
    this.url = (options.urlTemplate ?? 'https://{network}.g.alchemy.com/v2/{key}').replace('{network}', options.network).replace('{key}', options.apiKey)
  }

  private classify(status: number, err: RpcError | string | undefined): ExplorerError {
    const msg = typeof err === 'string' ? err : err ? String(err.message ?? `code ${String(err.code)}`) : `HTTP ${status}`
    const code = typeof err === 'object' && err ? Number(err.code) : undefined
    if (status === 429 || RATE_LIMIT_PATTERNS.some((p) => p.test(msg))) return new ExplorerError(this.backend, 'rate-limit', msg)
    if (status === 401 || status === 403 || code === -32601 || UNAVAILABLE_PATTERNS.some((p) => p.test(msg))) return new ExplorerError(this.backend, 'unavailable', msg)
    return new ExplorerError(this.backend, 'http', msg)
  }

  /**
   * POST a JSON-RPC body (single or batch) with the limiter; up to three retries with
   * backoff on 429 / 5xx / rate-limit answers and on transport failures (timeout,
   * abort, DNS — the bucket is charged in compute units); key / plan refusals and
   * "network not enabled" are `unavailable` (no retry, the source falls through).
   */
  private async post(body: unknown): Promise<unknown> {
    let retry: ExplorerError | undefined
    const cost = costOf(body)
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Backoff before a retry: 0.5 s, 1 s, 2 s (+ jitter so concurrent chains do not retry in lockstep).
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250))
      await this.o.bucket.acquire(cost)
      let res: Awaited<ReturnType<typeof postJson>>
      try {
        res = await postJson(this.o.fetch, this.backend, this.url, body, this.o.timeoutMs)
      } catch (e) {
        // A timeout / abort / DNS hiccup on one call is not a verdict on the backend: retry with the same backoff.
        if (e instanceof ExplorerError && e.kind === 'network') { retry = e; continue }
        throw e
      }
      const envelope = res.body as RpcResponse | RpcResponse[] | undefined
      // Transport-level failures first: 429 / 5xx retry once, 401 / 403 fall through.
      if (res.status === 429 || res.status >= 500) {
        retry = this.classify(res.status, Array.isArray(envelope) ? undefined : envelope?.error)
        continue
      }
      if (res.status >= 400) {
        const err = Array.isArray(envelope) ? envelope.find((r) => r.error)?.error : envelope?.error
        throw this.classify(res.status, err)
      }
      if (envelope === undefined) throw new ExplorerError(this.backend, 'http', `HTTP ${res.status}: not JSON`)
      // A 200 that is still a rate-limit answer (Alchemy sometimes answers 200 + error 429 inside) → retry once.
      const errs = (Array.isArray(envelope) ? envelope : [envelope]).map((r) => r.error).filter((e): e is RpcError | string => e !== undefined)
      if (errs.length > 0) {
        const classified = this.classify(res.status, errs[0]!)
        if (classified.kind === 'rate-limit') {
          retry = classified
          continue
        }
        throw classified
      }
      return envelope
    }
    throw retry ?? new ExplorerError(this.backend, 'rate-limit', 'rate limited')
  }

  async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = (await this.post({ jsonrpc: '2.0', id: 1, method, params })) as RpcResponse
    return res.result
  }

  /** JSON-RPC batch in chunks of `BATCH_SIZE`; results in call order (`null` where the node had nothing). */
  async batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const out: unknown[] = new Array<unknown>(calls.length).fill(null)
    for (let start = 0; start < calls.length; start += BATCH_SIZE) {
      const chunk = calls.slice(start, start + BATCH_SIZE)
      const body = chunk.map((c, i) => ({ jsonrpc: '2.0', id: start + i + 1, method: c.method, params: c.params }))
      const res = await this.post(body)
      if (!Array.isArray(res)) throw new ExplorerError(this.backend, 'http', 'batch answer is not an array')
      for (const r of res as RpcResponse[]) {
        const id = Number(r.id)
        if (Number.isInteger(id) && id >= 1 && id <= calls.length) out[id - 1] = r.result ?? null
      }
    }
    return out
  }

  // --- lists ---

  private categories(): string[] {
    return this.o.internal ? [...CATEGORIES, 'internal'] : [...CATEGORIES]
  }

  private async transfers(direction: 'fromAddress' | 'toAddress', address: string, limit: number, below: number | undefined): Promise<{ rows: AlchemyTransfer[]; more: boolean }> {
    const params: Row = {
      [direction]: address,
      category: this.categories(),
      order: 'desc',
      withMetadata: true,
      excludeZeroValue: false, // zero-value transfers are what the spam rule flags; Alchemy hides them by default
      maxCount: hex(limit),
    }
    if (below !== undefined) params['toBlock'] = hex(Math.max(0, below - 1))
    const result = (await this.rpc('alchemy_getAssetTransfers', [params])) as { transfers?: unknown; pageKey?: unknown } | null
    const raw = Array.isArray(result?.transfers) ? (result.transfers as Row[]) : []
    const rows: AlchemyTransfer[] = []
    for (const r of raw) {
      const t = parseAlchemyTransfer(r)
      if (t) rows.push(t)
    }
    return { rows, more: (typeof result?.pageKey === 'string' && result.pageKey !== '') || raw.length >= limit }
  }

  /** Two window-pagination lists (`from`, `to`); `next` is a marker, paging is by `toBlock`. */
  listSpecs(address: string): ListSpec<{ block: number }>[] {
    const spec = (key: string, direction: 'fromAddress' | 'toAddress'): ListSpec<AlchemyTransfer> => ({
      key,
      fetch: async (_cursor, limit, below): Promise<ListPage<AlchemyTransfer>> => {
        const { rows, more } = await this.transfers(direction, address, limit, below)
        return { rows, next: more ? 'more' : null }
      },
    })
    return [spec('from', 'fromAddress'), spec('to', 'toAddress')]
  }

  /**
   * Window rows (`from` + `to` transfers) → the three explorer lists. Transfers
   * are de-duplicated by `uniqueId` (a self-transfer, or a swap whose legs sit
   * in both lists, appears twice), grouped by hash, and every unique hash gets
   * `eth_getTransactionByHash` + `eth_getTransactionReceipt` in one batch
   * (≤ 10 requests per HTTP call, retried on rate limits). `erc20` rows → token rows,
   * `internal` rows → internal rows, `external` rows are the transaction's own
   * value and are already covered by the tx row (no second native transfer);
   * only when the node has no tx (dropped / reorged) is the external row
   * turned into a bare tx row so the item still renders.
   */
  async toRows(rows: Map<string, { block: number }[]>): Promise<ExplorerRows> {
    const seen = new Set<string>()
    const transfers: AlchemyTransfer[] = []
    for (const list of rows.values()) {
      for (const r of list as AlchemyTransfer[]) {
        if (seen.has(r.uniqueId)) continue
        seen.add(r.uniqueId)
        transfers.push(r)
      }
    }
    const byHash = new Map<string, AlchemyTransfer[]>()
    for (const t of transfers) {
      const k = t.hash.toLowerCase()
      const l = byHash.get(k)
      if (l) l.push(t)
      else byHash.set(k, [t])
    }
    const hashes = [...byHash.keys()]

    // Blocks whose timestamp no transfer carried (networks without `withMetadata`) are fetched in the same batch.
    const timeByBlock = new Map<number, number>()
    for (const t of transfers) if (t.time > 0) timeByBlock.set(t.block, t.time)
    const blocksMissing = [...new Set(transfers.filter((t) => !timeByBlock.has(t.block)).map((t) => t.block))]

    const calls: { method: string; params: unknown[] }[] = []
    for (const h of hashes) calls.push({ method: 'eth_getTransactionByHash', params: [h] }, { method: 'eth_getTransactionReceipt', params: [h] })
    for (const b of blocksMissing) calls.push({ method: 'eth_getBlockByNumber', params: [hex(b), false] })
    // The Transfers lists already hold hash / parties / amounts / time; the batch only adds fee,
    // status and calldata. When it fails after its own retries (a 15 s abort on a phone, a shared
    // compute-unit bucket starved by six sibling chains) the page is still served from the
    // transfers alone — bare rows (status confirmed, no fee) beat "History unavailable".
    let answers: unknown[] = []
    if (calls.length > 0) {
      try {
        answers = await this.batch(calls)
        this.degraded = undefined
      } catch (e) {
        if (!(e instanceof ExplorerError)) throw e
        this.degraded = e
      }
    }
    for (let i = 0; i < blocksMissing.length; i++) {
      const block = answers[hashes.length * 2 + i] as Row | null
      if (block && typeof block['timestamp'] === 'string') timeByBlock.set(blocksMissing[i]!, parseInt10(block['timestamp']))
    }

    const out: ExplorerRows = { tx: [], tokens: [], internal: [] }
    hashes.forEach((hash, i) => {
      const legs = byHash.get(hash)!
      const tx = answers[i * 2] as Row | null
      const receipt = answers[i * 2 + 1] as Row | null
      const time = timeByBlock.get(legs[0]!.block) ?? 0
      if (tx && typeof tx['hash'] === 'string') {
        out.tx.push(txRowFromRpc(tx, receipt, time))
      } else {
        const external = legs.find((l) => l.category === 'external')
        if (external) out.tx.push({ hash: external.hash, block: external.block, time, from: external.from, to: external.to || null, value: external.amount, input: '0x', status: 'confirmed', raw: { tx: null, receipt: null, transfer: external.raw } })
      }
      for (const l of legs) {
        if (l.category === 'erc20' && l.token) {
          const row: TokenRow = { hash: l.hash, block: l.block, time, from: l.from, to: l.to, token: l.token, amount: l.amount, raw: l.raw }
          if (l.symbol !== undefined) row.symbol = l.symbol
          if (l.decimals !== undefined) row.decimals = l.decimals
          out.tokens.push(row)
        } else if (l.category === 'internal') {
          const row: InternalRow = { hash: l.hash, block: l.block, time, from: l.from, to: l.to, value: l.amount, raw: l.raw }
          out.internal.push(row)
        }
      }
    })
    return out
  }

  /** `eth_getTransactionByHash` + receipt in one batch; ERC-20 `Transfer` logs → token rows; block timestamp fetched when needed. */
  async getTransaction(hash: string): Promise<{ tx: TxRow; tokens: TokenRow[] } | undefined> {
    const [tx, receipt] = (await this.batch([
      { method: 'eth_getTransactionByHash', params: [hash] },
      { method: 'eth_getTransactionReceipt', params: [hash] },
    ])) as [Row | null, Row | null]
    if (!tx || typeof tx !== 'object' || !tx['hash']) return undefined
    const blockHex = (receipt?.['blockNumber'] ?? tx['blockNumber']) as string | null | undefined
    let time = 0
    if (blockHex) {
      const block = (await this.rpc('eth_getBlockByNumber', [blockHex, false])) as Row | null
      if (block && typeof block['timestamp'] === 'string') time = parseInt10(block['timestamp'])
    }
    const row = txRowFromRpc(tx, receipt, time)
    return { tx: row, tokens: receipt ? parseReceiptTransfers(receipt, row) : [] }
  }
}

/** One `alchemy_getAssetTransfers` row → `AlchemyTransfer`; NFT categories and malformed rows → undefined. */
export function parseAlchemyTransfer(r: Row): AlchemyTransfer | undefined {
  const hash = r['hash'], category = r['category']
  if (typeof hash !== 'string' || typeof category !== 'string') return undefined
  if (category !== 'external' && category !== 'erc20' && category !== 'internal') return undefined
  const rawContract = (r['rawContract'] ?? {}) as Row
  const metadata = (r['metadata'] ?? {}) as Row
  const uniqueId = typeof r['uniqueId'] === 'string' ? r['uniqueId'] : `${hash}:${category}:${String(r['from'])}:${String(r['to'])}:${String(rawContract['value'])}`
  const t: AlchemyTransfer = {
    block: parseInt10(r['blockNum']),
    uniqueId,
    hash,
    from: String(r['from'] ?? '').toLowerCase(),
    to: typeof r['to'] === 'string' ? r['to'].toLowerCase() : '',
    category,
    amount: parseBig(rawContract['value']),
    time: parseIsoSeconds(metadata['blockTimestamp']),
    raw: r,
  }
  if (category === 'erc20') {
    if (typeof rawContract['address'] !== 'string' || !rawContract['address']) return undefined
    t.token = rawContract['address'].toLowerCase()
    if (typeof r['asset'] === 'string' && r['asset']) t.symbol = r['asset']
    if (typeof rawContract['decimal'] === 'string' && rawContract['decimal']) t.decimals = parseInt10(rawContract['decimal'])
  }
  return t
}

function hex(n: number): string {
  return `0x${Math.max(0, Math.floor(n)).toString(16)}`
}
