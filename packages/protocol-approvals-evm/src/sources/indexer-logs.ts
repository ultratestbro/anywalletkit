import { ApprovalsError } from '../approvals-protocol.js'
import { DISCOVERY_TOPICS, ownerTopic } from '../standards.js'
import { isRangeError, mergeCandidates, parseApprovalLog, type ApprovalSource, type Candidate, type CollectResult, type RawLog } from './rpc-logs.js'

/** Etherscan-style `getLogs` answers are capped at this many rows; a full page means "split the range". */
export const PAGE_LIMIT = 1000

/** The part of a `fetch` Response the sources read. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null } | undefined
  json(): Promise<unknown>
}

/** A `fetch` implementation (the global one, or a wrapper that adds a proxy's auth). */
export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponseLike>

export interface IndexerSourceOptions {
  /** One request per event signature instead of one per range (default false). */
  perTopic?: boolean
  /** Fetch implementation (default global). */
  fetch?: FetchLike
  /** Extra request headers (an auth token for a proxy, say). */
  headers?: Record<string, string>
  /** Parallel requests (default 1). */
  concurrency?: number
  /** Retries for transient errors and 429s (default 3). */
  retries?: number
  /** Base delay between retries, doubled each time; a 429's reset hint wins when longer (default 1000 ms). */
  retryDelay?: number
  /** A 429 whose reset is further away than this fails at once with the wait in the message (default 20 000 ms). */
  maxRetryWait?: number
}

/** What a subclass turns into a URL. */
export interface IndexerQuery {
  topic0: string | null
  topic1: string
  fromBlock: number
  toBlock: number
}

type TaggedError = Error & { fatal?: boolean; transient?: boolean; retryAfterMs?: number }

const tag = (error: Error, flags: { fatal?: boolean; transient?: boolean; retryAfterMs?: number }): TaggedError => Object.assign(error, flags)

/**
 * Shared engine of the indexer-backed sources (Etherscan V2, Blockscout —
 * both speak the Etherscan `module=logs&action=getLogs` dialect). One
 * request per range asks for every log with the owner in `topic1`; the
 * parser keeps the approval-shaped ones. A full page (1000 rows) or a
 * "range too large" answer halves the range. Subclasses only build the URL.
 */
export default class IndexerLogsSource implements ApprovalSource {
  /** Source name reported in `coverage.source`. */
  readonly name: string
  /** Requests issued by the last `collect` (diagnostics). */
  requests: number
  protected readonly _perTopic: boolean
  protected readonly _fetch: FetchLike
  protected readonly _headers: Record<string, string>
  protected readonly _concurrency: number
  protected readonly _retries: number
  protected readonly _retryDelay: number
  protected readonly _maxRetryWait: number

  constructor (name: string, { perTopic = false, fetch: fetchImpl, headers, concurrency = 1, retries = 3, retryDelay = 1000, maxRetryWait = 20_000 }: IndexerSourceOptions = {}) {
    this.name = name
    this._perTopic = perTopic
    this._fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    if (typeof this._fetch !== 'function') throw new ApprovalsError(`${name} needs a fetch implementation.`, 'source-failed')
    this._headers = { accept: 'application/json', ...(headers ?? {}) }
    this._concurrency = Math.max(1, concurrency)
    this._retries = retries
    this._retryDelay = retryDelay
    this._maxRetryWait = maxRetryWait
    this.requests = 0
  }

  /** The request URL for one query; implemented by each source. */
  protected _url (_query: IndexerQuery): string {
    throw new ApprovalsError('_url(query) must be implemented by the source.', 'source-failed')
  }

  async collect (owner: string, { fromBlock, toBlock }: { fromBlock: number; toBlock: number }): Promise<CollectResult> {
    this.requests = 0
    if (toBlock < fromBlock) return { candidates: [], complete: true, gaps: [] }
    const topic1 = ownerTopic(owner)
    const pending: Array<[string | null, number, number]> = this._perTopic
      ? DISCOVERY_TOPICS.map((topic0): [string | null, number, number] => [topic0, fromBlock, toBlock])
      : [[null, fromBlock, toBlock]]
    const wanted = new Set<string>(DISCOVERY_TOPICS)
    const found: Candidate[] = []
    const gaps: Array<[number, number]> = []
    let failure: unknown = null
    const worker = async (): Promise<void> => {
      while (pending.length && !failure) {
        const [topic0, a, b] = pending.pop()!
        try {
          const logs = await this._getLogs({ topic0, topic1, fromBlock: a, toBlock: b })
          if (logs.length >= PAGE_LIMIT && a < b) {
            const mid = a + Math.floor((b - a) / 2)
            pending.push([topic0, a, mid], [topic0, mid + 1, b])
            continue
          }
          if (logs.length >= PAGE_LIMIT) gaps.push([a, b])
          for (const log of logs) {
            if (!wanted.has(log.topics[0]!)) continue
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
    if (failure) throw new ApprovalsError(`${this.name} getLogs failed: ${(failure as { message?: string }).message ?? failure}`, 'source-failed', { cause: failure })
    const dedupedGaps = [...new Map(gaps.map((g) => [g.join(':'), g])).values()].sort((x, y) => x[0] - y[0])
    return { candidates: mergeCandidates(found), complete: dedupedGaps.length === 0, gaps: dedupedGaps }
  }

  protected async _getLogs (query: IndexerQuery): Promise<RawLog[]> {
    const url = this._url(query)
    let lastErr: unknown
    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        this.requests++
        const res = await this._fetch(url, { headers: this._headers })
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers?.get?.('retry-after') ?? 0) * 1000
          const reset = Number(res.headers?.get?.('x-ratelimit-reset') ?? 0) // Blockscout: milliseconds until the window resets
          const retryAfterMs = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, Number.isFinite(reset) ? reset : 0)
          if (res.status === 429 && retryAfterMs > this._maxRetryWait) {
            throw tag(new Error(`${this.name} rate limit reached (${res.headers?.get?.('x-ratelimit-limit') ?? '?'} requests per window); resets in ${Math.ceil(retryAfterMs / 60_000)} min`), { fatal: true })
          }
          throw tag(new Error(`HTTP ${res.status}`), { retryAfterMs })
        }
        if (!res.ok) throw tag(new Error(`HTTP ${res.status}`), { fatal: true })
        const body = (await res.json()) as { status?: unknown; message?: unknown; result?: unknown }
        if (body.status === '0' && /no records/i.test(typeof body.message === 'string' ? body.message : '')) return []
        if (!Array.isArray(body.result)) {
          const text = typeof body.result === 'string' ? body.result : (typeof body.message === 'string' ? body.message : 'unexpected indexer response')
          // Etherscan says "Max rate limit reached" with status 0; treat it as a 429.
          if (/rate limit/i.test(text)) throw tag(new Error(text), { retryAfterMs: 1000, transient: true })
          throw tag(new Error(text), { fatal: !isRangeError({ message: text }) })
        }
        return (body.result as Array<Record<string, unknown>>).map((l): RawLog => ({
          address: l.address as string,
          topics: ((l.topics as unknown[] | undefined) ?? []).filter((t): t is string => t !== null && t !== undefined),
          data: (l.data as string | undefined) ?? '0x',
          blockNumber: Number(l.blockNumber),
          transactionHash: l.transactionHash as string,
          logIndex: Number(l.logIndex ?? 0)
        }))
      } catch (err) {
        lastErr = err
        const e = err as TaggedError
        if (e.fatal || (!e.transient && isRangeError(err))) throw err
        if (attempt < this._retries && this._retryDelay > 0) {
          const wait = Math.max(this._retryDelay * 2 ** attempt, e.retryAfterMs ?? 0)
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
    }
    throw lastErr
  }
}
