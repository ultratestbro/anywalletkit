import { ApprovalsError } from '../approvals-protocol.js'
import IndexerLogsSource, { PAGE_LIMIT, type IndexerQuery, type IndexerSourceOptions } from './indexer-logs.js'

/** Etherscan V2 — one endpoint and one key for every chain Etherscan indexes. */
export const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api'

export interface EtherscanSourceOptions extends IndexerSourceOptions {
  /** Etherscan `chainid`. */
  chainId?: number
  /** Sent as `apikey` (omit when a proxy adds it). */
  apiKey?: string
  /** Endpoint (default {@link ETHERSCAN_V2_URL}); a proxy that forwards the same query works. */
  baseUrl?: string
}

/**
 * Discovery through the Etherscan V2 API:
 * `GET /v2/api?chainid=<id>&module=logs&action=getLogs&fromBlock&toBlock&topic1=<owner>&page=1&offset=1000&apikey=…`.
 *
 * A key is required (the free tier covers Ethereum, Arbitrum, Polygon and
 * more at 5 requests/s; Base, Optimism, BNB and Avalanche need a paid
 * plan — the API answers "Free API access is not supported for this
 * chain"). Keep the key server-side: point `baseUrl` at your own proxy that
 * appends it, and pass `headers` for the proxy's auth.
 */
export default class EtherscanSource extends IndexerLogsSource {
  private readonly _chainId: number
  private readonly _apiKey: string | null
  private readonly _baseUrl: string

  constructor ({ chainId, apiKey, baseUrl = ETHERSCAN_V2_URL, ...rest }: EtherscanSourceOptions = {}) {
    super('etherscan', rest)
    if (chainId === undefined || chainId === null) throw new ApprovalsError('EtherscanSource needs a chainId.', 'source-failed')
    this._chainId = Number(chainId)
    this._apiKey = apiKey ?? null
    this._baseUrl = baseUrl
  }

  protected override _url ({ topic0, topic1, fromBlock, toBlock }: IndexerQuery): string {
    const topics = topic0 ? `&topic0=${topic0}&topic1=${topic1}&topic0_1_opr=and` : `&topic1=${topic1}`
    const sep = this._baseUrl.includes('?') ? '&' : '?'
    return `${this._baseUrl}${sep}chainid=${this._chainId}&module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}${topics}&page=1&offset=${PAGE_LIMIT}${this._apiKey ? `&apikey=${this._apiKey}` : ''}`
  }
}
