import { NetworkError } from '@anywalletkit/core'

export const DEFAULT_TIMEOUT_MS = 15_000

/** fetch with a per-request timeout when the runtime has `AbortSignal.timeout` (Hermes needs runtime-hermes for it). */
export async function fetchWithTimeout(fetchFn: typeof fetch, url: string, init: RequestInit | undefined, timeoutMs: number, provider: string): Promise<Response> {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
  try {
    return await fetchFn(url, { ...init, ...(signal ? { signal } : {}) })
  } catch (e) {
    throw new NetworkError(`Request failed: ${url}`, { provider, cause: e })
  }
}

/** An HTTP status that is the server refusing the request itself: 4xx, but not 408 (request timeout). */
export const refusedStatus = (status: number): boolean => status >= 400 && status < 500 && status !== 408

/** Mark an error as a node's answer refusing the request: nothing was taken (round 3, M12). */
export function refusal<E extends Error>(e: E): E {
  return Object.assign(e, { answered: true })
}

/**
 * An endpoint answered with a refusal (HTTP 4xx other than 408, or an error body): nothing was
 * taken. A thrown fetch, a timeout, a 5xx or a body that cannot be read may have been.
 */
export function isAnsweredRefusal(e: unknown): boolean {
  return (e as { answered?: unknown } | null)?.answered === true
}

/** The node says it already holds the transaction (an earlier attempt delivered it): it is out, not refused. */
export function isAlreadyKnown(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x instanceof Error && depth < 5; x = x.cause, depth++) {
    if (/txn-already-(in-mempool|known)|already (known|in (the )?(mempool|block ?chain))/i.test(x.message)) return true
  }
  return false
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)
export const isIntString = (v: unknown): v is string => typeof v === 'string' && /^-?\d+$/.test(v)
