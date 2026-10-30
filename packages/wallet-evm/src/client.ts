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
  // No CCIP-Read: a contract's OffchainLookup revert (a token the user added, an airdropped one) must not make the
  // device fetch the URLs it names, LAN addresses included (scan 2026-10-27 modules, F37 class).
  return createPublicClient({ transport, ccipRead: false })
}

/**
 * One public client per DISTINCT configured endpoint (the same url or provider object listed twice is one),
 * with no failover between them: for checks that must hear several endpoints, not the first that answers.
 */
export function createEndpointClients(config: EvmConfig): PublicClient[] {
  if (config.provider === undefined) return []
  const list = Array.isArray(config.provider) ? config.provider : [config.provider]
  return [...new Set(list)].map((p) => createPublicClient({ transport: toTransport(p), ccipRead: false }))
}

