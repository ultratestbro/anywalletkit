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
/** Retries of a URL read, backing off 400, 800, 1600, 3200 ms (or the RPC's Retry-After): a 429 waits past a 1 s rate window. */
export const RETRY_COUNT = 4
export const RETRY_DELAY_MS = 400

/** A viem client over one provider or a list (fails over in order, like the account's own client). */
export function createReadClient(providers: MonadProvider[], timeoutMs = DEFAULT_TIMEOUT_MS): PublicClient | undefined {
  if (providers.length === 0) return undefined
  const one = (p: MonadProvider): Transport => (typeof p === 'string' ? http(p, { timeout: timeoutMs, retryCount: RETRY_COUNT, retryDelay: RETRY_DELAY_MS }) : custom(p))
  return createPublicClient({ transport: providers.length === 1 ? one(providers[0]!) : fallback(providers.map(one)), ccipRead: false })
}

/** Whether an RPC error is a rate limit: HTTP 429, JSON-RPC 429 or -32007 (a request-limit code), or the words. */
export function isRateLimited(error: unknown): boolean {
  let node: unknown = error
  for (let i = 0; i < 8 && node && typeof node === 'object'; i++) {
    const e = node as Record<string, unknown>
    if (e.status === 429 || e.code === 429 || e.code === -32007) return true
    for (const k of ['message', 'shortMessage', 'details']) {
      if (typeof e[k] === 'string' && /\b429\b|too many requests|rate limit/i.test(e[k] as string)) return true
    }
    node = e.cause
  }
  return false
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
