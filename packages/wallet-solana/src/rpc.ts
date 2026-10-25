import { NetworkError } from '@anywalletkit/core'
import { createSolanaRpc, isSolanaError, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from '@solana/kit'
import type { SolanaConfig, SolanaRpc } from './types.js'

const isRpc = (p: unknown): p is SolanaRpc => typeof p === 'object' && p !== null && typeof (p as SolanaRpc).getBalance === 'function'

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

type Requests = Record<string, (...a: unknown[]) => { send: (o?: { abortSignal?: AbortSignal }) => Promise<unknown> }>

/**
 * A proxy that answered every property with an RPC method would be a thenable (`await rpc` never
 * settles) and would shadow Object.prototype; like kit's own Rpc, these names are not methods.
 */
function rpcProxy(method: (name: string) => unknown): SolanaRpc {
  return new Proxy({} as SolanaRpc, {
    get: (_t, prop) => {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined
      if (prop in Object.prototype) return Reflect.get(Object.prototype, prop) as unknown
      return method(prop)
    },
  })
}

/** A url Rpc whose every request gives up after `ms` (unless the caller passes its own `abortSignal`). */
function withTimeout(url: string, ms: number): SolanaRpc {
  const rpc = createSolanaRpc(url) as unknown as Requests
  return rpcProxy((method) => (...args: unknown[]) => {
    const pending = rpc[method]!(...args)
    return {
      ...pending, // kit's pending request (reactiveStore…), with `send` bounded by the timeout
      send: async (opts?: { abortSignal?: AbortSignal }) => {
        if (opts?.abortSignal) return pending.send(opts)
        const signal = timeoutSignal(ms)
        try {
          return await pending.send(signal ? { ...opts, abortSignal: signal } : opts)
        } catch (e) {
          if (signal?.aborted) throw new NetworkError(`${method}: no answer within ${ms} ms`, { provider: url, cause: e })
          throw e
        }
      },
    }
  })
}

/**
 * The request was answered and refused, so a transaction in it was not forwarded: a JSON-RPC error
 * (preflight failure, bad signature, unhealthy node, malformed request) or an HTTP 4xx (rate limit,
 * auth, bad request). An internal error, a 408 / 5xx, a timeout or a dropped connection is not an
 * answer.
 */
export function isDefinitive(e: unknown): boolean {
  if (!isSolanaError(e)) return false
  const context = e.context as { __code?: unknown; statusCode?: unknown }
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return typeof context.statusCode === 'number' && context.statusCode >= 400 && context.statusCode < 500 && context.statusCode !== 408
  }
  const code = context.__code
  return typeof code === 'number' && code <= -32000 && code >= -32768 && code !== SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR
}

/** Methods that hand a signed transaction to the network. */
const BROADCAST_METHODS: ReadonlySet<string> = new Set(['sendTransaction'])

/**
 * One Rpc, or a failover Rpc over a list: every `.method(...).send()` walks the
 * list in order until one answers; `retries` extra rounds after the first full
 * pass. A broadcast fails over with the same signed bytes (one signature, so it
 * lands at most once). It is a clean refusal only if every attempt was refused;
 * once one went unanswered the first node may have forwarded it, so the failure
 * is a `NetworkError` the account turns into `BroadcastUnknownError`.
 */
export function createRpc(config: SolanaConfig): SolanaRpc | undefined {
  const target = config.provider ?? config.rpcUrl
  if (target === undefined) return undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = (Array.isArray(target) ? target : [target]).map((p) => (isRpc(p) ? p : withTimeout(p, timeoutMs)))
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  return rpcProxy((method) => (...args: unknown[]) => ({
    send: async (opts?: unknown) => {
      let unanswered = false
      let lastError: unknown
      for (let i = 0; i < attempts; i++) {
        const rpc = list[i % list.length]! as unknown as Record<string, (...a: unknown[]) => { send: (o?: unknown) => Promise<unknown> }>
        try { return await rpc[method]!(...args).send(opts) } catch (e) {
          if (!isDefinitive(e)) unanswered = true
          lastError = e
        }
      }
      if (BROADCAST_METHODS.has(method) && !unanswered) throw lastError
      throw new NetworkError(`All Solana RPC providers failed for ${method}`, { cause: lastError })
    },
  }))
}
