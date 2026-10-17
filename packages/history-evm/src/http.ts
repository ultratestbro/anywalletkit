import { ExplorerError } from './errors.js'
import type { FetchLike } from './types.js'

/**
 * `AbortSignal.timeout`, guarded: Hermes ships AbortController but historically
 * not `AbortSignal.timeout` (see @forgewallet/runtime-hermes). Without it the
 * request simply has no client-side timeout.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } }).AbortSignal
  return typeof ctor?.timeout === 'function' ? ctor.timeout(ms) : undefined
}

export interface HttpJson {
  status: number
  /** Parsed JSON body; `undefined` when the body was not JSON. */
  body: unknown
}

/** GET + parse JSON. Network / timeout failures become `ExplorerError('network')`; HTTP statuses are returned, not thrown. */
export async function fetchJson(fetchFn: FetchLike, backend: string, url: string, timeoutMs: number): Promise<HttpJson> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    const signal = timeoutSignal(timeoutMs)
    res = await fetchFn(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) })
  } catch (e) {
    throw new ExplorerError(backend, 'network', e instanceof Error ? e.message : String(e))
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  return { status: res.status, body }
}

/** POST a JSON body (JSON-RPC) and parse the JSON answer; same failure semantics as `fetchJson`. */
export async function postJson(fetchFn: FetchLike, backend: string, url: string, body: unknown, timeoutMs: number): Promise<HttpJson> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    const signal = timeoutSignal(timeoutMs)
    res = await fetchFn(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (e) {
    throw new ExplorerError(backend, 'network', e instanceof Error ? e.message : String(e))
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

/** `a=1&b=2` with encoded keys/values; `undefined` values are skipped. */
export function query(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.join('&')
}

export function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch
  if (typeof f !== 'function') throw new Error('@forgewallet/history-evm: no global fetch; pass `fetch` in the options')
  return f as FetchLike
}
