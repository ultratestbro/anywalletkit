import { createPublicClient, custom, fallback, http, type PublicClient, type Transport } from 'viem'
import type { EvmConfig, EvmProvider } from './types.js'

function toTransport(p: EvmProvider): Transport {
  return typeof p === 'string' ? http(p) : custom(p)
}

/** Per failover client: the errors each endpoint answered to `eth_sendRawTransaction`, by raw transaction. */
const broadcastErrors = new WeakMap<PublicClient, Map<string, unknown[]>>()

/**
 * The errors every endpoint of a failover list gave for these raw bytes, in order (the last one is
 * what the send threw), and forget them. A single endpoint reports nothing here.
 */
export function takeBroadcastErrors(client: PublicClient, raw: string): unknown[] {
  const log = broadcastErrors.get(client)
  if (!log) return []
  const key = raw.toLowerCase()
  const errors = log.get(key) ?? []
  log.delete(key)
  return errors
}

type FallbackResponse = { method: string; params: unknown; status: 'success' | 'error'; error?: unknown }

/** viem public client over the provider config (string | EIP-1193 | list → fallback). */
export function createClient(config: EvmConfig): PublicClient | undefined {
  if (config.provider === undefined) return undefined
  const list = Array.isArray(config.provider) ? config.provider : [config.provider]
  if (list.length === 0) return undefined
  const retryCount = config.retries ?? 3
  const transport = list.length === 1 ? toTransport(list[0]!) : fallback(list.map(toTransport), { retryCount })
  // No CCIP-Read: a contract's OffchainLookup revert (a token the user added, an airdropped one) must not make the
  // device fetch the URLs it names, LAN addresses included (scan 2026-10-27 modules, F37 class).
  const client = createPublicClient({ transport, ccipRead: false })
  // The fallback hands the same signed bytes to the next endpoint and throws only the last error;
  // the send needs every endpoint's answer to know whether an earlier one may hold the bytes.
  const onResponse = (client.transport as { onResponse?: (fn: (r: FallbackResponse) => void) => void }).onResponse
  if (list.length > 1 && typeof onResponse === 'function') {
    const log = new Map<string, unknown[]>()
    broadcastErrors.set(client, log)
    onResponse((r) => {
      if (r.method !== 'eth_sendRawTransaction' || r.status !== 'error') return
      const raw = Array.isArray(r.params) ? r.params[0] : undefined
      if (typeof raw !== 'string') return
      const key = raw.toLowerCase()
      const errors = log.get(key) ?? []
      errors.push(r.error)
      log.set(key, errors)
    })
  }
  return client
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

