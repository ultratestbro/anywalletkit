// A small JSON-RPC client with failover. Reads only: transactions always go through the wallet
// account, which signs and broadcasts them with its own provider.

/** Something that answers Solana JSON-RPC: a URL, a `@solana/rpc` client (what `wallet-solana` accounts hold), or `{ request(method, params) }`. */
export type SolanaRpcSource =
  | string
  | { request(method: string, params: unknown[]): Promise<unknown> }
  | object

/** Default request timeout for URL providers and @solana/rpc clients. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** A node-side rejection (bad params, unsupported method): trying another provider will not help. */
export class RpcError extends Error {
  readonly code: number | undefined
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`)
    this.name = 'RpcError'
    this.code = code
  }
}

/**
 * Errors another provider would answer the same way: the request itself is malformed (parse error,
 * invalid request, invalid params). Everything else — transport failures, timeouts, HTTP errors,
 * rate limits, a method this node does not serve, a slot it no longer keeps — moves to the next one.
 */
const FINAL_CODES = new Set([-32700, -32600, -32602])
const final = (e: unknown) => e instanceof RpcError && e.code !== undefined && FINAL_CODES.has(e.code)

async function withTimeout<T>(ms: number, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  // Hermes has AbortController but not AbortSignal.timeout; a plain timer works everywhere.
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      reject(new Error(`timed out after ${ms} ms`))
    }, ms)
  })
  // The Hermes CLI runs timers that were cleared; a late rejection must not surface as unhandled.
  timeout.catch(() => undefined)
  try {
    return await Promise.race([run(controller?.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface RpcClientOptions {
  timeoutMs?: number
  fetch?: typeof fetch
}

/** Tries each source in order. Transport failures, timeouts and rate limits move on; a node-side rejection is final. */
export class RpcClient {
  private readonly sources: SolanaRpcSource[]
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch | undefined

  constructor(sources: SolanaRpcSource[], options: RpcClientOptions = {}) {
    this.sources = sources
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetch
  }

  get configured(): boolean {
    return this.sources.length > 0
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (this.sources.length === 0) throw new Error('The staking protocol needs a Solana RPC: pass `provider` in its config, or an account connected to one.')
    let last: unknown
    for (const source of this.sources) {
      try {
        // A `{ request }` provider is the app's own transport and keeps its own timeouts; URLs and
        // @solana/rpc clients get this one (and its abort signal).
        const own = typeof source === 'object' && source !== null && typeof (source as Record<string, unknown>)[method] !== 'function' && typeof (source as { request?: unknown }).request === 'function'
        return (own ? await this.once(source, method, params, undefined) : await withTimeout(this.timeoutMs, (signal) => this.once(source, method, params, signal))) as T
      } catch (e) {
        if (final(e)) throw e
        last = e
      }
    }
    throw last instanceof Error ? last : new Error(`${method}: every provider failed`)
  }

  private async once(source: SolanaRpcSource, method: string, params: unknown[], signal: AbortSignal | undefined): Promise<unknown> {
    if (typeof source === 'string') {
      const f = this.fetchImpl ?? fetch
      const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }
      if (signal) init.signal = signal
      const res = await f(source, init)
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
      const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } }
      if (body.error) throw new RpcError(method, String(body.error.message ?? 'error'), body.error.code)
      return body.result
    }
    const s = source as Record<string, unknown>
    // A @solana/rpc client is a Proxy on which every property is a method, `request` included, so
    // it is recognized first: positional params, then .send(). Its errors carry the code in `context`.
    if (typeof s[method] === 'function') {
      try {
        return await (s[method] as (...a: unknown[]) => { send(o?: unknown): Promise<unknown> })(...params).send(signal ? { abortSignal: signal } : undefined)
      } catch (e) {
        // A kit JSON-RPC error carries the node's code in `context.__code`; transport errors carry kit codes (8100002 = HTTP error).
        const err = e as { context?: { __code?: number }; message?: string }
        throw new RpcError(method, String(err?.message ?? e), err?.context?.__code)
      }
    }
    if (typeof s.request === 'function') {
      try {
        return await (s.request as (m: string, p: unknown[]) => Promise<unknown>)(method, params)
      } catch (e) {
        const err = e as { code?: number; message?: string }
        throw new RpcError(method, String(err?.message ?? e), typeof err?.code === 'number' ? err.code : undefined)
      }
    }
    throw new RpcError(method, 'Unsupported provider: expected a URL, a @solana/rpc client or { request(method, params) }.')
  }
}

/** Base64 decode without Buffer (Hermes has `atob`). */
export function fromBase64(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const B = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer
  if (B) return new Uint8Array(B.from(s, 'base64'))
  throw new Error('No base64 decoder: needs atob or Buffer.')
}

/** An integer from a JSON-RPC field (number, bigint from @solana/rpc, or decimal string). */
export function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  throw new Error(`Expected an integer, got ${String(v)}`)
}
