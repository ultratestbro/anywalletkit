import { ExplorerError } from './errors.js'
import { fetchJson, query } from './http.js'
import type { ListPage, ListSpec } from './paginate.js'
import type { TokenBucket } from './rate-limit.js'
import { parseReceiptTransfers, txRowFromRpc } from './rpc-rows.js'
import { parseBig, parseInt10, type InternalRow, type TokenRow, type TxRow } from './rows.js'
import type { FetchLike, HistoryBackend } from './types.js'

export { parseReceiptTransfers, TRANSFER_TOPIC } from './rpc-rows.js'

export interface EtherscanClientOptions {
  backend: HistoryBackend
  /** `https://api.etherscan.io/v2/api` or a Routescan-style mirror. */
  baseUrl: string
  /** Added as `chainid=` (Etherscan v2) or `chain_id=` (Blockscout PRO), see `chainParam`. */
  chainId?: number
  /** Query parameter name for the chain id. Default `chainid`. */
  chainParam?: 'chainid' | 'chain_id'
  apiKey?: string
  fetch: FetchLike
  bucket: TokenBucket
  timeoutMs: number
}

type Row = Record<string, unknown>

interface EtherscanEnvelope {
  status?: unknown
  message?: unknown
  result?: unknown
  error?: unknown
}

/** Etherscan status "0" messages that mean "do not retry, this backend cannot serve the chain". */
const UNAVAILABLE_PATTERNS = [/invalid api key/i, /missing.*api key/i, /free api access/i, /unsupported chain/i, /community free api limit/i, /chain not supported/i, /upgrade.*plan/i, /unauthorized/i, /proceed with api key/i, /x402/i]
const RATE_LIMIT_PATTERNS = [/rate limit/i, /max calls per sec/i, /too many requests/i]
const EMPTY_PATTERNS = [/no transactions found/i, /no records found/i]

/** Etherscan-format explorer client (Etherscan v2, or a keyless mirror such as Routescan). */
export class EtherscanClient {
  readonly backend: HistoryBackend
  private readonly o: EtherscanClientOptions

  constructor(options: EtherscanClientOptions) {
    this.o = options
    this.backend = options.backend
  }

  url(params: Record<string, string | number | undefined>): string {
    const all: Record<string, string | number | undefined> = {}
    if (this.o.chainId !== undefined) all[this.o.chainParam ?? 'chainid'] = this.o.chainId
    Object.assign(all, params)
    if (this.o.apiKey) all['apikey'] = this.o.apiKey
    return `${this.o.baseUrl}${this.o.baseUrl.includes('?') ? '&' : '?'}${query(all)}`
  }

  /** One API call with the limiter, one retry on rate limiting; classified failures. */
  async call(params: Record<string, string | number | undefined>): Promise<unknown> {
    const url = this.url(params)
    let lastRate: ExplorerError | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.o.bucket.acquire()
      const res = await fetchJson(this.o.fetch, this.backend, url, this.o.timeoutMs)
      if (res.status === 429 || res.status >= 500) {
        lastRate = new ExplorerError(this.backend, res.status === 429 ? 'rate-limit' : 'http', `HTTP ${res.status}`)
        continue
      }
      if (res.status >= 400) throw new ExplorerError(this.backend, 'http', `HTTP ${res.status}`)
      const env = (res.body ?? {}) as EtherscanEnvelope
      if (typeof env.error === 'string' && env.error) throw new ExplorerError(this.backend, 'unavailable', env.error) // Blockscout PRO: {"error":"Unauthorized"}
      if (env.error && typeof env.error === 'object') {
        const msg = String((env.error as { message?: unknown }).message ?? 'error')
        throw new ExplorerError(this.backend, 'unavailable', msg)
      }
      if (env.status === '0' || env.status === 0) {
        const text = `${String(env.message ?? '')} ${typeof env.result === 'string' ? env.result : ''}`.trim()
        if (EMPTY_PATTERNS.some((p) => p.test(text))) return []
        if (RATE_LIMIT_PATTERNS.some((p) => p.test(text))) {
          lastRate = new ExplorerError(this.backend, 'rate-limit', text)
          continue
        }
        throw new ExplorerError(this.backend, UNAVAILABLE_PATTERNS.some((p) => p.test(text)) ? 'unavailable' : 'http', text || 'NOTOK')
      }
      return env.result
    }
    throw lastRate ?? new ExplorerError(this.backend, 'rate-limit', 'rate limited')
  }

  private async list(action: string, address: string, limit: number, below: number | undefined): Promise<Row[]> {
    const result = await this.call({
      module: 'account',
      action,
      address,
      startblock: 0,
      endblock: below === undefined ? undefined : Math.max(0, below - 1),
      page: 1,
      offset: limit,
      sort: 'desc',
    })
    return Array.isArray(result) ? (result as Row[]) : []
  }

  /** The three address lists as window-pagination specs; `next` is a marker (Etherscan pages by `endblock`, not cursors). */
  listSpecs(address: string): ListSpec<{ block: number }>[] {
    const spec = <R extends { block: number }>(key: string, action: string, parse: (r: Row) => R | undefined): ListSpec<R> => ({
      key,
      fetch: async (_cursor, limit, below): Promise<ListPage<R>> => {
        const raw = await this.list(action, address, limit, below)
        const rows: R[] = []
        for (const r of raw) {
          const p = parse(r)
          if (p) rows.push(p)
        }
        return { rows, next: raw.length >= limit ? 'more' : null }
      },
    })
    return [spec('tx', 'txlist', parseTxlistRow), spec('tokens', 'tokentx', parseTokentxRow), spec('internal', 'txlistinternal', parseInternalRow)]
  }

  /** `proxy` module: transaction + receipt (+ block for the timestamp when the node does not inline it). */
  async getTransaction(hash: string): Promise<{ tx: TxRow; tokens: TokenRow[] } | undefined> {
    const tx = (await this.call({ module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash })) as Row | null
    if (!tx || typeof tx !== 'object' || !tx['hash']) return undefined
    const receipt = (await this.call({ module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hash })) as Row | null
    const blockHex = (receipt?.['blockNumber'] ?? tx['blockNumber']) as string | null | undefined
    let time = 0
    if (typeof tx['blockTimestamp'] === 'string') time = parseInt10(tx['blockTimestamp'])
    else if (blockHex) {
      const block = (await this.call({ module: 'proxy', action: 'eth_getBlockByNumber', tag: blockHex, boolean: 'false' })) as Row | null
      if (block && typeof block['timestamp'] === 'string') time = parseInt10(block['timestamp'])
    }
    const row = txRowFromRpc(tx, receipt, time)
    return { tx: row, tokens: receipt ? parseReceiptTransfers(receipt, row) : [] }
  }
}

// --- row parsers (exported for tests) ---

export function parseTxlistRow(r: Row): TxRow | undefined {
  const hash = r['hash']
  if (typeof hash !== 'string') return undefined
  const gasUsed = parseBig(r['gasUsed']), gasPrice = parseBig(r['gasPrice'])
  const row: TxRow = {
    hash,
    block: parseInt10(r['blockNumber']),
    time: parseInt10(r['timeStamp']),
    from: String(r['from'] ?? ''),
    to: typeof r['to'] === 'string' && r['to'] ? (r['to'] as string) : null,
    value: parseBig(r['value']),
    input: typeof r['input'] === 'string' && r['input'] ? (r['input'] as string) : '0x',
    status: r['isError'] === '1' || r['txreceipt_status'] === '0' ? 'failed' : 'confirmed',
    raw: r,
  }
  if (gasUsed > 0n && gasPrice > 0n) row.fee = gasUsed * gasPrice
  if (typeof r['contractAddress'] === 'string' && r['contractAddress']) row.contractAddress = r['contractAddress'] as string
  return row
}

export function parseTokentxRow(r: Row): TokenRow | undefined {
  const hash = r['hash'], token = r['contractAddress']
  if (typeof hash !== 'string' || typeof token !== 'string' || !token) return undefined
  // tokenID present → ERC-721 / 1155 row (tokennfttx / token1155tx); out of scope in v1.
  if (r['tokenID'] !== undefined) return undefined
  const row: TokenRow = {
    hash,
    block: parseInt10(r['blockNumber']),
    time: parseInt10(r['timeStamp']),
    from: String(r['from'] ?? ''),
    to: String(r['to'] ?? ''),
    token: token.toLowerCase(),
    amount: parseBig(r['value']),
    raw: r,
  }
  if (typeof r['tokenSymbol'] === 'string' && r['tokenSymbol']) row.symbol = r['tokenSymbol'] as string
  const dec = r['tokenDecimal']
  if ((typeof dec === 'string' && dec !== '') || typeof dec === 'number') row.decimals = parseInt10(dec)
  return row
}

export function parseInternalRow(r: Row): InternalRow | undefined {
  const hash = r['hash']
  if (typeof hash !== 'string') return undefined
  if (r['isError'] === '1') return undefined
  return {
    hash,
    block: parseInt10(r['blockNumber']),
    time: parseInt10(r['timeStamp']),
    from: String(r['from'] ?? ''),
    to: String(r['to'] ?? ''),
    value: parseBig(r['value']),
    raw: r,
  }
}
