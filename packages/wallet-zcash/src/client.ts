import { NetworkError } from '@forgewallet/core'
import { BlockchairClient } from './blockchair.js'
import { ZcashBlockbookClient } from './blockbook.js'
import { DEFAULT_TIMEOUT_MS } from './http.js'
import type { ZcashClient, ZcashClientConfig, ZcashConfig } from './types.js'

const isClient = (c: unknown): c is ZcashClient => typeof c === 'object' && c !== null && typeof (c as ZcashClient).listUnspent === 'function'

function toClient(c: ZcashClientConfig | ZcashClient, fetchFn: typeof fetch | undefined, timeoutMs: number): ZcashClient {
  if (isClient(c)) return c
  switch (c.type) {
    case 'blockchair': return new BlockchairClient(c.clientConfig ?? {}, fetchFn, timeoutMs)
    case 'blockbook-http': return new ZcashBlockbookClient(c.clientConfig, fetchFn, timeoutMs)
    default: throw new Error(`Unknown Zcash client type: ${String((c as { type: string }).type)}`)
  }
}

const METHODS = ['connect', 'close', 'getBalance', 'listUnspent', 'getTransaction', 'getOutput', 'getTransactionInfo', 'broadcast', 'getBlockHeight'] as const

/**
 * One client, or a failover client over the list: each call walks the list in
 * order, `retries` extra rounds. A node's rejection of a broadcast (plain
 * Error) is final — only transport failures (NetworkError) move on.
 */
export function createClient(config: ZcashConfig): ZcashClient | undefined {
  if (config.client === undefined) return undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = (Array.isArray(config.client) ? config.client : [config.client]).map((c) => toClient(c, config.fetch, timeoutMs))
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  const call = (method: (typeof METHODS)[number]) => async (...args: unknown[]) => {
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      const c = list[i % list.length]! as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      try { return await c[method]!.apply(c, args) } catch (e) {
        if (method === 'broadcast' && !(e instanceof NetworkError)) throw e
        last = e
      }
    }
    throw new NetworkError(`All Zcash clients failed for ${method}`, { cause: last })
  }
  const out = {} as Record<(typeof METHODS)[number], (...args: unknown[]) => Promise<unknown>>
  for (const m of METHODS) out[m] = call(m)
  return out as unknown as ZcashClient
}
