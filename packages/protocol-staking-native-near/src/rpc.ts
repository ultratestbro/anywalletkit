import type { IWalletAccount, IWalletAccountReadOnly } from '@anywalletkit/core'
import { NearRpc, createClient, type NearFetch, type NearProvider } from '@anywalletkit/wallet-near'

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
