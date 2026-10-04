'use strict'

import { ApprovalsError } from '../approvals-protocol.js'
import IndexerLogsSource from './indexer-logs.js'

/** Public Blockscout instances (Etherscan-compatible `module=logs` API, no key). */
export const BLOCKSCOUT_HOSTS = Object.freeze({
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  100: 'https://gnosis.blockscout.com',
  137: 'https://polygon.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  534352: 'https://scroll.blockscout.com',
  59144: 'https://explorer.linea.build',
  11155111: 'https://eth-sepolia.blockscout.com'
})

/**
 * Discovery through a Blockscout instance:
 * `GET /api?module=logs&action=getLogs&fromBlock&toBlock&topic1=<owner>`.
 *
 * Keyless instances allow about 10 requests per window per client IP and
 * answer 429 with `x-ratelimit-reset`, so the cold start is one request per
 * chain (see {@link IndexerLogsSource}). Pass `apiKey` (free at
 * dev.blockscout.com) to lift the limit.
 */
export default class BlockscoutSource extends IndexerLogsSource {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl] - Instance origin; defaults to {@link BLOCKSCOUT_HOSTS} for `chainId`.
   * @param {number} [options.chainId]
   * @param {string} [options.apiKey] - Sent as `apikey`.
   * @param {boolean} [options.perTopic]
   * @param {typeof fetch} [options.fetch]
   * @param {Record<string, string>} [options.headers]
   * @param {number} [options.concurrency]
   * @param {number} [options.retries]
   * @param {number} [options.retryDelay]
   * @param {number} [options.maxRetryWait]
   */
  constructor ({ baseUrl, chainId, apiKey, ...rest } = {}) {
    super('blockscout', rest)
    const url = baseUrl ?? (chainId !== undefined ? BLOCKSCOUT_HOSTS[chainId] : undefined)
    if (!url) throw new ApprovalsError(`No Blockscout instance known for chain ${chainId}; pass baseUrl.`, 'source-failed', { chainId })
    /** @private */
    this._baseUrl = url.replace(/\/+$/, '')
    /** @private */
    this._apiKey = apiKey ?? null
  }

  /** @protected */
  _url ({ topic0, topic1, fromBlock, toBlock }) {
    const topics = topic0 ? `&topic0=${topic0}&topic1=${topic1}&topic0_1_opr=and` : `&topic1=${topic1}`
    return `${this._baseUrl}/api?module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}${topics}${this._apiKey ? `&apikey=${this._apiKey}` : ''}`
  }
}
