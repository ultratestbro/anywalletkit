import { NetworkError, type IWalletAccount, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { NearRpc, NearRpcError, createClient, type NearFetch, type NearProvider } from '@anywalletkit/wallet-near'

/**
 * The read client: `provider` from the config, else the transport of a wallet-near account
 * (`_client`, or its configured `provider`). Undefined when neither exists; reads then refuse with
 * 'no-provider'. External-signer accounts (wallet-selector adapters) have none: pass `provider`.
 */
export function resolveRpc(
  account: IWalletAccountReadOnly | IWalletAccount,
  config: { provider?: NearProvider | NearProvider[]; timeoutMs?: number },
): NearRpc | undefined {
  if (config.provider !== undefined) {
    const fetch = createClient({ provider: config.provider, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) })
    return fetch ? new NearRpc(fetch) : undefined
  }
  const own = account as unknown as { _client?: NearFetch; _config?: { provider?: NearProvider | NearProvider[]; timeoutMs?: number } }
  if (typeof own._client === 'function') return new NearRpc(own._client)
  if (own._config?.provider !== undefined) {
    const fetch = createClient({ provider: own._config.provider, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) })
    return fetch ? new NearRpc(fetch) : undefined
  }
  return undefined
}

/** The node's own "no such account" answer (as opposed to a transport failure). */
export const isMissingAccount = (e: unknown): boolean =>
  e instanceof NearRpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(`${e.errorName ?? ''} ${e.message}`)

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}

/** A signal that aborts after `ms`: `AbortSignal.timeout` where the runtime has it, else a timer that does not keep Node alive. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  if (typeof AbortController === 'undefined') return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms) as unknown as { unref?: () => void }
  timer.unref?.()
  return controller.signal
}

/** GET a JSON document (the fastnear indexer API); a transport failure or a non-2xx answer is a NetworkError. */
export async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const signal = timeoutSignal(timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) })
  } catch (e) {
    throw new NetworkError(`GET ${url}: ${signal?.aborted ? `no answer within ${timeoutMs} ms` : 'request failed'}`, { provider: url, cause: e })
  }
  if (!res.ok) throw new NetworkError(`GET ${url}: HTTP ${res.status}`, { provider: url })
  return res.json()
}

/** A u128 the node sent as a decimal string; anything else is a malformed answer. */
export function u128(value: unknown, what: string): bigint {
  if (typeof value === 'string' && /^\d{1,39}$/.test(value)) return BigInt(value)
  throw new NetworkError(`${what}: expected a decimal string, got ${String(JSON.stringify(value)).slice(0, 60)}`)
}
