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

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)
export const isIntString = (v: unknown): v is string => typeof v === 'string' && /^-?\d+$/.test(v)
