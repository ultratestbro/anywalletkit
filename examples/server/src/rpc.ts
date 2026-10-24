// The "Ship a wallet" docs page renders the #region blocks of this file.

// #region rpc
/**
 * A JSON-RPC proxy: the app talks to `POST /rpc/<caip2>`, the server adds the keyed upstream.
 * Only the methods a wallet needs pass (reads, fee data, simulation, broadcasting a SIGNED
 * transaction); anything that could sign or administer a node — eth_sign*, personal_*, admin_*,
 * debug_*, eth_sendTransaction — is refused. Errors never carry the upstream URL or key.
 */
export interface RpcProxyOptions {
  /** Upstream URLs per CAIP-2 chain, tried in order (failover on network errors and 5xx). */
  upstreams: Readonly<Record<string, readonly string[]>>
  /** Raw body cap; a signed transaction is the largest legitimate request. */
  maxBodyBytes?: number
  /** Batch size cap. */
  maxBatch?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const EVM_METHODS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode',
  'eth_getStorageAt', 'eth_call', 'eth_estimateGas', 'eth_createAccessList', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getLogs', 'eth_simulateV1', 'eth_sendRawTransaction',
])
const SOLANA_METHODS = new Set([
  'getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getLatestBlockhash', 'getBlockHeight', 'getSlot', 'getEpochInfo',
  'getFeeForMessage', 'getRecentPrioritizationFees', 'getMinimumBalanceForRentExemption', 'getTokenAccountsByOwner',
  'getTokenAccountBalance', 'getSignaturesForAddress', 'getSignatureStatuses', 'getTransaction', 'simulateTransaction',
  'sendTransaction', 'isBlockhashValid',
])
const ALLOWED: Record<string, ReadonlySet<string>> = { eip155: EVM_METHODS, solana: SOLANA_METHODS }

export interface RpcResult { status: number; body: string }

const rpcError = (status: number, id: unknown, message: string): RpcResult =>
  ({ status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: status === 400 ? -32600 : -32603, message } }) })

export function createRpcProxy(opts: RpcProxyOptions) {
  const maxBody = opts.maxBodyBytes ?? 256 * 1024
  const maxBatch = opts.maxBatch ?? 20
  const timeoutMs = opts.timeoutMs ?? 15_000
  const doFetch = opts.fetchImpl ?? fetch
  return async function proxy(chain: string, rawBody: string): Promise<RpcResult> {
    const urls = opts.upstreams[chain]
    if (!urls?.length) return rpcError(404, null, `no RPC configured for ${chain.slice(0, 64)}`)
    if (Buffer.byteLength(rawBody) > maxBody) return rpcError(413, null, 'request too large')
    let payload: unknown
    try { payload = JSON.parse(rawBody) } catch { return rpcError(400, null, 'invalid JSON') }
    const calls = Array.isArray(payload) ? payload : [payload]
    if (calls.length === 0 || calls.length > maxBatch) return rpcError(400, null, `batch of 1..${maxBatch} calls`)
    const allowed = ALLOWED[chain.split(':')[0]!]
    for (const c of calls) {
      const method = (c as { method?: unknown })?.method
      if (typeof method !== 'string' || !allowed?.has(method)) {
        return rpcError(403, (c as { id?: unknown })?.id, `method not allowed: ${String(method).slice(0, 60)}`)
      }
    }
    for (const url of urls) {
      try {
        const res = await doFetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.status >= 500) continue // the next upstream
        return { status: res.status, body: await res.text() }
      } catch { /* network error or timeout: the next upstream */ }
    }
    return rpcError(502, null, 'upstream unavailable') // no URL, no key
  }
}
// #endregion rpc
