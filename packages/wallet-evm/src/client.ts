import { createPublicClient, custom, fallback, http, type PublicClient, type Transport } from 'viem'
import type { EvmConfig, EvmProvider } from './types.js'

function toTransport(p: EvmProvider): Transport {
  return typeof p === 'string' ? http(p) : custom(p)
}

/** viem public client over the provider config (string | EIP-1193 | list → fallback). */
export function createClient(config: EvmConfig): PublicClient | undefined {
  if (config.provider === undefined) return undefined
  const list = Array.isArray(config.provider) ? config.provider : [config.provider]
  if (list.length === 0) return undefined
  const retryCount = config.retries ?? 3
  const transport = list.length === 1 ? toTransport(list[0]!) : fallback(list.map(toTransport), { retryCount })
  return createPublicClient({ transport })
}
