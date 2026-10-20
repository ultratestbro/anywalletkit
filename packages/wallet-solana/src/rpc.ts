import { NetworkError } from '@forgewallet/core'
import { createSolanaRpc } from '@solana/kit'
import type { SolanaConfig, SolanaRpc } from './types.js'

const isRpc = (p: unknown): p is SolanaRpc => typeof p === 'object' && p !== null && typeof (p as SolanaRpc).getBalance === 'function'

/**
 * One Rpc, or a failover Rpc over a list: every `.method(...).send()` walks the
 * list in order until one answers; `retries` extra rounds after the first full
 * pass.
 */
export function createRpc(config: SolanaConfig): SolanaRpc | undefined {
  const target = config.provider ?? config.rpcUrl
  if (target === undefined) return undefined
  const list = (Array.isArray(target) ? target : [target]).map((p) => (isRpc(p) ? p : createSolanaRpc(p)))
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  return new Proxy({} as SolanaRpc, {
    get: (_t, method: string) => (...args: unknown[]) => ({
      send: async (opts?: unknown) => {
        let lastError: unknown
        for (let i = 0; i < attempts; i++) {
          const rpc = list[i % list.length]! as unknown as Record<string, (...a: unknown[]) => { send: (o?: unknown) => Promise<unknown> }>
          try { return await rpc[method]!(...args).send(opts) } catch (e) { lastError = e }
        }
        throw new NetworkError(`All Solana RPC providers failed for ${method}`, { cause: lastError })
      },
    }),
  })
}
