import { createPublicClient, custom, fallback, http, type PublicClient, type Transport } from 'viem'

/** The EIP-1193 surface reads can go through when no RPC url is given. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/** RPC url or EIP-1193 provider. */
export type MonadProvider = string | Eip1193Provider

/** Default per-request timeout for URL providers. */
export const DEFAULT_TIMEOUT_MS = 15_000
/**
 * Reads in flight at once: public Monad RPCs cap requests per second, and JSON-RPC batching does not
 * help (each call counts). 4 measured ~43 rps with no 429 on rpc.monad.xyz; 6 drew 15 % 429s.
 */
export const DEFAULT_CONCURRENCY = 4
/** Retries of a URL read that failed for any retryable reason (a timeout, a 5xx), 150 then 300 ms apart. */
export const RETRY_COUNT = 2
export const RETRY_DELAY_MS = 150
/**
 * Retries of a rate-limited URL read (HTTP 429, JSON-RPC 429 / -32007), backing off 400, 800, 1600,
 * 3200 ms or the RPC's Retry-After (at most {@link RATE_LIMIT_MAX_DELAY_MS}): a 429 waits past a 1 s
 * rate window. Only rate limits get these: a hung RPC still fails after 3 timeouts, not 5.
 */
export const RATE_LIMIT_RETRY_COUNT = 4
export const RATE_LIMIT_DELAY_MS = 400
export const RATE_LIMIT_MAX_DELAY_MS = 5_000

/** A viem client over one provider or a list (fails over in order, like the account's own client). */
export function createReadClient(providers: MonadProvider[], timeoutMs = DEFAULT_TIMEOUT_MS): PublicClient | undefined {
  if (providers.length === 0) return undefined
  // viem's own retries are off (retryCount 0): withReadRetries owns the policy, so a 429 is not retried twice over.
  const one = (p: MonadProvider): Transport => (typeof p === 'string' ? withReadRetries(http(p, { timeout: timeoutMs, retryCount: 0 })) : custom(p))
  return createPublicClient({ transport: providers.length === 1 ? one(providers[0]!) : fallback(providers.map(one)), ccipRead: false })
}

/**
 * Wraps a transport whose own retries are off: a rate-limited request is retried up to
 * {@link RATE_LIMIT_RETRY_COUNT} times with backoff, any other request viem would retry (a timeout,
 * a 5xx, an unknown error) up to {@link RETRY_COUNT} times, as viem's `retryCount: 2, retryDelay: 150` did.
 */
export function withReadRetries(transport: Transport): Transport {
  return (options) => {
    const t = transport(options)
    const request = (async (args: Parameters<typeof t.request>[0], opts?: Parameters<typeof t.request>[1]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await t.request(args, opts)
        } catch (e) {
          const limited = isRateLimited(e)
          if (attempt >= (limited ? RATE_LIMIT_RETRY_COUNT : RETRY_COUNT) || !(limited || isRetryable(e))) throw e
          const signal = (opts as { signal?: AbortSignal } | undefined)?.signal
          if (signal?.aborted) throw e
          await sleep(limited ? (retryAfterMs(e) ?? RATE_LIMIT_DELAY_MS * 2 ** attempt) : RETRY_DELAY_MS * 2 ** attempt)
        }
      }
    }) as typeof t.request
    return { ...t, request }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The errors and their causes, outermost first. */
function causes(error: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let node: unknown = error
  for (let i = 0; i < 8 && node && typeof node === 'object'; i++) {
    out.push(node as Record<string, unknown>)
    node = (node as Record<string, unknown>).cause
  }
  return out
}

/** Rate-limit words in an error's short message or details (never `message`: it carries the request body, whose id is a counter). */
const RATE_LIMIT_TEXT = /too many requests|rate[ -]?limit|\b(?:status|http)\s*:?\s*429\b/i

/**
 * Whether an RPC error is a rate limit: HTTP 429, JSON-RPC 429 or -32007 (a request-limit code), or
 * the words in its short message or details.
 */
export function isRateLimited(error: unknown): boolean {
  const chain = causes(error)
  if (chain.some((e) => e.status === 429 || e.code === 429 || e.code === -32007)) return true
  return chain.some((e) => ['shortMessage', 'details'].some((k) => typeof e[k] === 'string' && RATE_LIMIT_TEXT.test(e[k] as string)))
}

/** HTTP statuses viem retries. */
const RETRY_STATUSES = new Set([403, 408, 413, 429, 500, 502, 503, 504])
/** JSON-RPC codes viem retries: unknown, limit exceeded, internal error, 429, request limit. */
const RETRY_CODES = new Set([-1, -32005, -32603, 429, -32007])

/** Whether viem would retry this error (its `shouldRetry`, which it does not export). */
export function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true
  const e = error as Record<string, unknown>
  if (e.name === 'AbortError') return false
  if (typeof e.code === 'number') return RETRY_CODES.has(e.code)
  if (e.name === 'HttpRequestError' && typeof e.status === 'number' && e.status) return RETRY_STATUSES.has(e.status)
  return true
}

/** The RPC's Retry-After in ms (whole seconds, capped), if a rate-limit response carried one. */
function retryAfterMs(error: unknown): number | undefined {
  for (const e of causes(error)) {
    const headers = e.headers as { get?: (name: string) => string | null } | undefined
    const value = typeof headers?.get === 'function' ? headers.get('Retry-After') : null
    if (value && /^\s*\d+\s*$/.test(value)) return Math.min(Number.parseInt(value, 10) * 1000, RATE_LIMIT_MAX_DELAY_MS)
  }
  return undefined
}

/**
 * Whether a failed read never got a usable answer from the node: a timeout, an abort, a network error
 * or an HTTP 408 / 5xx. Such a failure says nothing about the call itself.
 */
export function isTransportFailure(error: unknown): boolean {
  return causes(error).some((e) => {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
    if (e.name !== 'HttpRequestError') return false
    const status = e.status
    return typeof status !== 'number' || !status || status === 408 || status >= 500
  })
}

/** Maps `items` with at most `limit` calls in flight, keeping the order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    for (;;) {
      const i = next++
      if (failed || i >= items.length) return
      try {
        out[i] = await fn(items[i]!, i)
      } catch (e) {
        failed = true // the other workers stop instead of spending the rate limit on a call that already failed
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/**
 * Reads every page of a paginated precompile getter: `(isDone, next, ids)`, following `next` until
 * `isDone`. Pages are shorter than the documented 100 in practice; the guard stops a node that never
 * says done.
 */
export async function paginate<C extends bigint | number>(page: (start: C) => Promise<readonly [boolean, C, readonly bigint[]]>, first: C, maxPages = 50): Promise<bigint[]> {
  const ids: bigint[] = []
  let start = first
  for (let i = 0; i < maxPages; i++) {
    const [done, next, list] = await page(start)
    ids.push(...list)
    if (done || next === start) return ids
    start = next
  }
  throw new Error(`Pagination did not finish after ${maxPages} pages.`)
}
