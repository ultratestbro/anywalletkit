import { NetworkError } from '@anywalletkit/core'
import { parseJsonExact } from './json.js'
import type { TronConfig, TronFetch } from './types.js'

/** Default per-request timeout for url providers. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** A signal that aborts after `ms`: `AbortSignal.timeout` where the runtime has it, else a timer (Hermes without runtime-hermes). */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  if (typeof AbortController === 'undefined') return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms) as unknown as { unref?: () => void }
  timer.unref?.()
  return controller.signal
}

function httpTransport(base: string, headers: Record<string, string> | undefined, timeoutMs: number): TronFetch {
  const root = base.replace(/\/+$/, '')
  return async (path, body) => {
    const signal = timeoutSignal(timeoutMs)
    let res: Response
    try {
      res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      throw new NetworkError(`${path}: ${signal?.aborted ? `no answer within ${timeoutMs} ms` : 'request failed'}`, { provider: root, cause: e })
    }
    if (!res.ok) throw new NetworkError(`${path}: HTTP ${res.status}`, { provider: root })
    return parseJsonExact(await res.text())
  }
}

/**
 * One transport, or a failover transport over the list. Any failure without a node's answer (a
 * timeout, a dropped connection, an HTTP error) moves on to the next provider. That holds for a
 * broadcast too: it re-sends the SAME signed bytes (one `txID`, accepted by the chain once), and
 * the account reads a duplicate answer as accepted.
 */
export function createClient(config: TronConfig): TronFetch | undefined {
  if (config.provider === undefined) return undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = (Array.isArray(config.provider) ? config.provider : [config.provider]).map((p) =>
    typeof p === 'string' ? httpTransport(p, config.headers, timeoutMs) : p,
  )
  if (list.length === 0) throw new Error("The 'provider' option cannot be set to an empty list.")
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  return async (path, body) => {
    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
      try { return await list[i % list.length]!(path, body) } catch (e) { lastError = e }
    }
    throw new NetworkError(`All Tron providers failed for ${path}`, { cause: lastError })
  }
}

/** Full-node responses that carry an error body instead of a transaction. */
export function assertNoError(res: unknown, what: string): void {
  const r = res as { Error?: string; code?: string; message?: string; result?: { result?: boolean; code?: string; message?: string } }
  const hexMsg = (m: string | undefined) => (m && /^[0-9a-f]+$/i.test(m) ? Buffer_from_hex(m) : m)
  if (r?.Error) throw new Error(`${what}: ${r.Error}`)
  if (r?.result && typeof r.result === 'object' && r.result.result === false) throw new Error(`${what}: ${r.result.code ?? ''} ${hexMsg(r.result.message) ?? ''}`.trim())
  if (r?.code && r.code !== 'SUCCESS' && !('txID' in (r as object))) throw new Error(`${what}: ${r.code} ${hexMsg(r.message) ?? ''}`.trim())
}

function Buffer_from_hex(hex: string): string {
  try { return new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))) } catch { return hex }
}
