import { NetworkError } from '@forgewallet/core'
import { BlockbookClient } from './blockbook.js'
import { EsploraClient } from './esplora.js'
import { DEFAULT_TIMEOUT_MS } from './http.js'
import type { BtcClient, BtcClientConfig, BtcConfig } from './types.js'

const isClient = (c: unknown): c is BtcClient => typeof c === 'object' && c !== null && typeof (c as BtcClient).listUnspent === 'function'

function toClient(c: BtcClientConfig | BtcClient, fetchFn: typeof fetch | undefined, timeoutMs: number): BtcClient {
  if (isClient(c)) return c
  switch (c.type) {
    case 'blockbook-http': return new BlockbookClient(c.clientConfig, fetchFn, timeoutMs)
    case 'esplora-http': return new EsploraClient(c.clientConfig, fetchFn, timeoutMs)
    default: throw new Error(`Unknown BTC client type: ${String((c as { type: string }).type)}`)
  }
}

const METHODS = ['connect', 'close', 'getBalance', 'listUnspent', 'getHistory', 'getTransaction', 'getTransactionInfo', 'broadcast', 'estimateFee', 'getBlockHeight'] as const

/** One client, or a failover client over the list: each call walks the list in order, `retries` extra rounds. */
export function createClient(config: BtcConfig): BtcClient | undefined {
  if (config.client === undefined) return undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = (Array.isArray(config.client) ? config.client : [config.client]).map((c) => toClient(c, config.fetch, timeoutMs))
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  const call = (method: (typeof METHODS)[number]) => async (...args: unknown[]) => {
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      const c = list[i % list.length]! as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>
      const fn = c[method]
      if (!fn) continue // optional method this transport lacks — try the next one
      try { return await fn.apply(c, args) } catch (e) { last = e }
    }
    throw new NetworkError(`All BTC clients failed for ${method}`, { cause: last })
  }
  const out = {} as Record<(typeof METHODS)[number], (...args: unknown[]) => Promise<unknown>>
  for (const m of METHODS) out[m] = call(m)
  return out as unknown as BtcClient
}
