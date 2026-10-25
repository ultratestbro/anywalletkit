// The "Ship a wallet" docs page renders the #region blocks of this file.

// #region rpc
/**
 * A JSON-RPC proxy: the app talks to `POST /rpc/<caip2>`, the server adds the keyed upstream.
 * Only the methods a wallet needs pass (reads, fee data, simulation, broadcasting a SIGNED
 * transaction); anything that could sign or administer a node — eth_sign*, personal_*, admin_*,
 * debug_*, eth_sendTransaction — is refused. Each call is also held to a budget: an
 * `eth_getLogs` block range, no state or block overrides, a cap on the upstream's answer.
 * Errors never carry the upstream URL or key.
 */
export interface RpcProxyOptions {
  /** Upstream URLs per CAIP-2 chain, tried in order (failover on network errors and 5xx). */
  upstreams: Readonly<Record<string, readonly string[]>>
  /** Raw body cap; a signed transaction is the largest legitimate request. */
  maxBodyBytes?: number
  /** Batch size cap. */
  maxBatch?: number
  /** Widest `eth_getLogs` range, in blocks, between two block numbers (default 5 000). */
  maxLogsRange?: number
  /** Largest upstream answer relayed, in bytes (default 4 MiB); a larger one is a 502. */
  maxResponseBytes?: number
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

/** Methods that cost the upstream (and your plan) far more than a balance read: give them their own rate limit. */
export const EXPENSIVE_METHODS: ReadonlySet<string> = new Set([
  'eth_getLogs', 'eth_call', 'eth_estimateGas', 'eth_createAccessList', 'eth_simulateV1',
  'getSignaturesForAddress', 'getTransaction', 'getTokenAccountsByOwner', 'getMultipleAccounts', 'simulateTransaction',
])

export interface RpcResult { status: number; body: string }

const rpcError = (status: number, id: unknown, message: string): RpcResult =>
  ({ status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: status === 400 ? -32600 : -32603, message } }) })

const BLOCK_TAGS = new Set(['latest', 'safe', 'finalized', 'pending'])
const BLOCK_NUMBER = /^0x[0-9a-fA-F]{1,16}$/
const present = (v: unknown) => v !== undefined && v !== null

/** Why one call is over budget, or null. Overrides would let a caller run arbitrary state on your node. */
function overBudget(method: string, params: unknown, maxLogsRange: number): string | null {
  const p = Array.isArray(params) ? params : []
  switch (method) {
    case 'eth_getLogs': {
      const f = p[0] as Record<string, unknown> | undefined
      if (!f || typeof f !== 'object') return 'eth_getLogs expects a filter object'
      if (present(f.blockHash)) return present(f.fromBlock) || present(f.toBlock) ? 'eth_getLogs: blockHash or a range, not both' : null
      const from = f.fromBlock ?? 'latest'
      const to = f.toBlock ?? 'latest'
      if (typeof from === 'string' && typeof to === 'string' && BLOCK_NUMBER.test(from) && BLOCK_NUMBER.test(to)) {
        const span = BigInt(to) - BigInt(from)
        return span >= 0n && span <= BigInt(maxLogsRange) ? null : `eth_getLogs: at most ${maxLogsRange} blocks, from ≤ to`
      }
      if (typeof from === 'string' && typeof to === 'string' && BLOCK_TAGS.has(from) && BLOCK_TAGS.has(to)) return null
      return `eth_getLogs: give two block numbers at most ${maxLogsRange} apart, or a blockHash`
    }
    case 'eth_call':
      return present(p[2]) || present(p[3]) ? 'eth_call: state and block overrides are not allowed' : null
    case 'eth_estimateGas':
    case 'eth_createAccessList':
      return present(p[2]) ? `${method}: state overrides are not allowed` : null
    case 'eth_simulateV1': {
      const blocks = (p[0] as { blockStateCalls?: unknown } | undefined)?.blockStateCalls
      if (!Array.isArray(blocks) || blocks.length > 4) return 'eth_simulateV1: 1..4 blockStateCalls'
      for (const b of blocks as Array<Record<string, unknown>>) {
        if (present(b?.stateOverrides) || present(b?.blockOverrides)) return 'eth_simulateV1: state and block overrides are not allowed'
        if (Array.isArray(b?.calls) && b.calls.length > 16) return 'eth_simulateV1: at most 16 calls per block'
      }
      return null
    }
    default:
      return null
  }
}

/** The upstream's body, or null when it is larger than `cap` (read as a stream, never buffered past the cap). */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > cap) { await res.body?.cancel(); return null }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createRpcProxy(opts: RpcProxyOptions) {
  const maxBody = opts.maxBodyBytes ?? 256 * 1024
  const maxBatch = opts.maxBatch ?? 20
  const maxLogsRange = opts.maxLogsRange ?? 5_000
  const maxResponse = opts.maxResponseBytes ?? 4 * 1024 * 1024
  const timeoutMs = opts.timeoutMs ?? 15_000
  const doFetch = opts.fetchImpl ?? fetch
  /** `charge` sees the methods once the request is valid, before any upstream call: throw to refuse (rate limits). */
  return async function proxy(chain: string, rawBody: string, hooks: { charge?: (methods: readonly string[]) => void | Promise<void> } = {}): Promise<RpcResult> {
    const urls = opts.upstreams[chain]
    if (!urls?.length) return rpcError(404, null, `no RPC configured for ${chain.slice(0, 64)}`)
    if (Buffer.byteLength(rawBody) > maxBody) return rpcError(413, null, 'request too large')
    let payload: unknown
    try { payload = JSON.parse(rawBody) } catch { return rpcError(400, null, 'invalid JSON') }
    const calls = Array.isArray(payload) ? payload : [payload]
    if (calls.length === 0 || calls.length > maxBatch) return rpcError(400, null, `batch of 1..${maxBatch} calls`)
    const allowed = ALLOWED[chain.split(':')[0]!]
    const methods: string[] = []
    for (const c of calls) {
      const { method, params, id } = (c ?? {}) as { method?: unknown; params?: unknown; id?: unknown }
      if (typeof method !== 'string' || !allowed?.has(method)) {
        return rpcError(403, id, `method not allowed: ${String(method).slice(0, 60)}`)
      }
      const why = overBudget(method, params, maxLogsRange)
      if (why) return rpcError(403, id, why)
      methods.push(method)
    }
    await hooks.charge?.(methods)
    for (const url of urls) {
      try {
        const res = await doFetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.status >= 500) { await res.body?.cancel(); continue } // the next upstream
        const body = await readCapped(res, maxResponse)
        if (body === null) return rpcError(502, null, 'upstream response too large')
        return { status: res.status, body }
      } catch { /* network error or timeout: the next upstream */ }
    }
    return rpcError(502, null, 'upstream unavailable') // no URL, no key
  }
}
// #endregion rpc
