'use strict'

import { ApprovalsError } from '../approvals-protocol.js'
import { DISCOVERY_TOPICS, ownerTopic } from '../standards.js'
import { isRangeError, mergeCandidates, parseApprovalLog } from './rpc-logs.js'

/** Etherscan-style `getLogs` answers are capped at this many rows; a full page means "split the range". */
export const PAGE_LIMIT = 1000

/**
 * Shared engine of the indexer-backed sources (Etherscan V2, Blockscout —
 * both speak the Etherscan `module=logs&action=getLogs` dialect). One
 * request per range asks for every log with the owner in `topic1`; the
 * parser keeps the approval-shaped ones. A full page (1000 rows) or a
 * "range too large" answer halves the range. Subclasses only build the URL.
 *
 * @abstract
 */
export default class IndexerLogsSource {
  /**
   * @param {Object} options
   * @param {string} name - Source name reported in `coverage.source`.
   * @param {boolean} [options.perTopic] - One request per event signature instead of one per range (default false).
   * @param {typeof fetch} [options.fetch] - Fetch implementation (default global).
   * @param {Record<string, string>} [options.headers] - Extra request headers (an auth token for a proxy, say).
   * @param {number} [options.concurrency] - Parallel requests (default 1).
   * @param {number} [options.retries] - Retries for transient errors and 429s (default 3).
   * @param {number} [options.retryDelay] - Base delay between retries, doubled each time; a 429's reset hint wins when longer (default 1000 ms).
   * @param {number} [options.maxRetryWait] - A 429 whose reset is further away than this fails at once with the wait in the message (default 20 000 ms).
   */
  constructor (name, { perTopic = false, fetch: fetchImpl, headers, concurrency = 1, retries = 3, retryDelay = 1000, maxRetryWait = 20_000 } = {}) {
    this.name = name
    /** @protected */
    this._perTopic = perTopic
    /** @protected */
    this._fetch = fetchImpl ?? globalThis.fetch
    if (typeof this._fetch !== 'function') throw new ApprovalsError(`${name} needs a fetch implementation.`, 'source-failed')
    /** @protected */
    this._headers = { accept: 'application/json', ...(headers ?? {}) }
    /** @protected */
    this._concurrency = Math.max(1, concurrency)
    /** @protected */
    this._retries = retries
    /** @protected */
    this._retryDelay = retryDelay
    /** @protected */
    this._maxRetryWait = maxRetryWait
    /** Requests issued by the last `collect` (diagnostics). */
    this.requests = 0
  }

  /**
   * @abstract
   * @protected
   * @param {{ topic0: string | null, topic1: string, fromBlock: number, toBlock: number }} query
   * @returns {string}
   */
  _url (query) {
    throw new ApprovalsError('_url(query) must be implemented by the source.', 'source-failed')
  }

  /**
   * @param {string} owner
   * @param {{ fromBlock: number, toBlock: number }} range
   * @returns {Promise<import('./rpc-logs.js').CollectResult>}
   */
  async collect (owner, { fromBlock, toBlock }) {
    this.requests = 0
    if (toBlock < fromBlock) return { candidates: [], complete: true, gaps: [] }
    const topic1 = ownerTopic(owner)
    const pending = this._perTopic ? DISCOVERY_TOPICS.map((topic0) => [topic0, fromBlock, toBlock]) : [[null, fromBlock, toBlock]]
    const wanted = new Set(DISCOVERY_TOPICS)
    const found = []
    const gaps = []
    let failure = null
    const worker = async () => {
      while (pending.length && !failure) {
        const [topic0, a, b] = pending.pop()
        try {
          const logs = await this._getLogs({ topic0, topic1, fromBlock: a, toBlock: b })
          if (logs.length >= PAGE_LIMIT && a < b) {
            const mid = a + Math.floor((b - a) / 2)
            pending.push([topic0, a, mid], [topic0, mid + 1, b])
            continue
          }
          if (logs.length >= PAGE_LIMIT) gaps.push([a, b])
          for (const log of logs) {
            if (!wanted.has(log.topics[0])) continue
            const c = parseApprovalLog(log, owner)
            if (c) found.push(c)
          }
        } catch (err) {
          if (isRangeError(err) && a < b) {
            const mid = a + Math.floor((b - a) / 2)
            pending.push([topic0, a, mid], [topic0, mid + 1, b])
            continue
          }
          failure = err
        }
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    if (failure) throw new ApprovalsError(`${this.name} getLogs failed: ${failure.message ?? failure}`, 'source-failed', { cause: failure })
    const dedupedGaps = [...new Map(gaps.map((g) => [g.join(':'), g])).values()].sort((x, y) => x[0] - y[0])
    return { candidates: mergeCandidates(found), complete: dedupedGaps.length === 0, gaps: dedupedGaps }
  }

  /** @protected */
  async _getLogs (query) {
    const url = this._url(query)
    let lastErr
    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        this.requests++
        const res = await this._fetch(url, { headers: this._headers })
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers?.get?.('retry-after') ?? 0) * 1000
          const reset = Number(res.headers?.get?.('x-ratelimit-reset') ?? 0) // Blockscout: milliseconds until the window resets
          const retryAfterMs = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, Number.isFinite(reset) ? reset : 0)
          if (res.status === 429 && retryAfterMs > this._maxRetryWait) {
            throw Object.assign(new Error(`${this.name} rate limit reached (${res.headers?.get?.('x-ratelimit-limit') ?? '?'} requests per window); resets in ${Math.ceil(retryAfterMs / 60_000)} min`), { fatal: true })
          }
          throw Object.assign(new Error(`HTTP ${res.status}`), { retryAfterMs })
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
        const body = await res.json()
        if (body.status === '0' && /no records/i.test(body.message ?? '')) return []
        if (!Array.isArray(body.result)) {
          const text = typeof body.result === 'string' ? body.result : (body.message ?? 'unexpected indexer response')
          // Etherscan says "Max rate limit reached" with status 0; treat it as a 429.
          if (/rate limit/i.test(text)) throw Object.assign(new Error(text), { retryAfterMs: 1000, transient: true })
          throw Object.assign(new Error(text), { fatal: !isRangeError({ message: text }) })
        }
        return body.result.map((l) => ({
          address: l.address,
          topics: (l.topics ?? []).filter((t) => t !== null && t !== undefined),
          data: l.data ?? '0x',
          blockNumber: Number(l.blockNumber),
          transactionHash: l.transactionHash,
          logIndex: Number(l.logIndex ?? 0)
        }))
      } catch (err) {
        lastErr = err
        if (err.fatal || (!err.transient && isRangeError(err))) throw err
        if (attempt < this._retries && this._retryDelay > 0) {
          const wait = Math.max(this._retryDelay * 2 ** attempt, err.retryAfterMs ?? 0)
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
    }
    throw lastErr
  }
}
