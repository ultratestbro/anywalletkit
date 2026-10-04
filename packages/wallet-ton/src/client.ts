import { NetworkError } from '@forgewallet/core'
import { TonClient } from '@ton/ton'
import type { TonConfig, TonEndpoint } from './types.js'

const isClient = (p: unknown): p is TonClient => p instanceof TonClient

type HttpApi = TonClient extends { api: infer A } ? A : never
/** TonClient marks `api` protected; it is a plain field at runtime. */
const apiOf = (c: TonClient) => (c as unknown as { api: HttpApi }).api
const setApi = (c: TonClient, api: HttpApi) => { (c as unknown as { api: HttpApi }).api = api }

/**
 * One TonClient, or a TonClient whose low-level `api` fails over across the
 * endpoint list: every api method
 * walks the list in order; `retries` extra rounds after the first full pass.
 */
export function createTonClient(config: TonConfig): TonClient | undefined {
  const target = config.tonClient ?? config.provider
  if (target === undefined) return undefined
  const list = (Array.isArray(target) ? target : [target]).map((e) =>
    isClient(e) ? e : new TonClient({ endpoint: (e as TonEndpoint).url, ...((e as TonEndpoint).secretKey ? { apiKey: (e as TonEndpoint).secretKey } : {}) }),
  )
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  const primary = list[0]!
  const client = new TonClient({ endpoint: primary.parameters.endpoint })
  const apis = list.map((c) => apiOf(c) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)
  setApi(client, new Proxy(apiOf(primary), {
    get: (_t, method: string) => async (...args: unknown[]) => {
      let lastError: unknown
      for (let i = 0; i < attempts; i++) {
        const api = apis[i % apis.length]!
        try { return await api[method]!(...args) } catch (e) { lastError = e }
      }
      throw new NetworkError(`All TON endpoints failed for ${method}`, { cause: lastError })
    },
  }) as HttpApi)
  return client
}
