import { NetworkError } from '@anywalletkit/core'
import { NearRpcError } from './errors.js'
import type { NearConfig, NearFetch } from './types.js'

/** Base64 helpers that work in Node, browsers and Hermes (no Buffer). */
export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
    return btoa(s)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer.from(bytes).toString('base64')
}
export function fromBase64(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(s, 'base64'))
}

/** Default per-request timeout for url providers. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** A signal that aborts after `ms`: `AbortSignal.timeout` where the runtime has it, else a timer (Hermes without runtime-hermes). */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  if (typeof AbortController === 'undefined') return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms) as unknown as { unref?: () => void }
  timer.unref?.()
  return controller.signal
}

function httpTransport(url: string, headers: Record<string, string> | undefined, timeoutMs: number): NearFetch {
  let id = 0
  return async (method, params) => {
    const signal = timeoutSignal(timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: String(++id), method, params }),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      throw new NetworkError(`${method}: ${signal?.aborted ? `no answer within ${timeoutMs} ms` : 'request failed'}`, { provider: url, cause: e })
    }
    if (!res.ok) throw new NetworkError(`${method}: HTTP ${res.status}`, { provider: url })
    const json = (await res.json()) as { result?: unknown; error?: { name?: string; message?: string; cause?: { name?: string }; data?: unknown; code?: number } }
    if (json.error) throw new NearRpcError(method, json.error)
    return json.result
  }
}

/** An `error` from the node is a definitive answer (unknown account, invalid tx…) — never failed over. */
export const isDefinitive = (e: unknown) => e instanceof NearRpcError && !/TIMEOUT|INTERNAL|UNAVAILABLE|NO_SYNCED/i.test(e.errorName ?? '')

/** Methods that hand a signed transaction to the network: a lost answer is ambiguous, so they are never re-sent elsewhere. */
const BROADCAST_METHODS: ReadonlySet<string> = new Set(['send_tx', 'broadcast_tx_commit', 'broadcast_tx_async'])

/**
 * One transport, or a failover transport over the list. Reads fail over on anything but a
 * definitive node answer; a broadcast is sent once — the account turns an unanswered one into
 * `BroadcastUnknownError`.
 */
export function createClient(config: NearConfig): NearFetch | undefined {
  if (config.provider === undefined) return undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = (Array.isArray(config.provider) ? config.provider : [config.provider]).map((p) =>
    typeof p === 'string' ? httpTransport(p, config.headers, timeoutMs) : p,
  )
  if (list.length === 0) throw new Error("The 'provider' option cannot be set to an empty list.")
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  return async (method, params) => {
    if (BROADCAST_METHODS.has(method)) return list[0]!(method, params)
    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
      try { return await list[i % list.length]!(method, params) } catch (e) {
        if (isDefinitive(e)) throw e
        lastError = e
      }
    }
    throw new NetworkError(`All NEAR providers failed for ${method}`, { cause: lastError })
  }
}

// ── Typed helpers over `query` ───────────────────────────────────────────────

export interface RawAccountView { amount: string; locked: string; storage_usage: number; code_hash?: string; block_height?: number; block_hash?: string }
export interface RawAccessKeyView { nonce: number; permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } }; block_hash?: string; block_height?: number }
export interface RawCallResult { result: number[]; logs?: string[]; block_hash?: string; block_height?: number; error?: string }
export interface RawFinalOutcome {
  status?: Record<string, unknown>
  final_execution_status?: string
  transaction?: { hash?: string; signer_id?: string }
  transaction_outcome?: { id?: string; block_hash?: string; outcome?: { status?: Record<string, unknown>; gas_burnt?: number; tokens_burnt?: string } }
  receipts_outcome?: Array<{ id?: string; block_hash?: string; outcome?: { status?: Record<string, unknown>; gas_burnt?: number; tokens_burnt?: string } }>
}

const UNKNOWN = /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|UNKNOWN_TRANSACTION|does not exist/i

/** The NEAR JSON-RPC calls a wallet uses, with parsed results. */
export class NearRpc {
  constructor(readonly fetch: NearFetch) {}

  /** `undefined` when the account does not exist. */
  async viewAccount(accountId: string): Promise<RawAccountView | undefined> {
    try {
      return (await this.fetch('query', { request_type: 'view_account', finality: 'final', account_id: accountId })) as RawAccountView
    } catch (e) {
      if (e instanceof NearRpcError && UNKNOWN.test(e.errorName ?? e.message)) return undefined
      throw e
    }
  }

  /** `undefined` when the key is not on the account. */
  async viewAccessKey(accountId: string, publicKey: string): Promise<RawAccessKeyView | undefined> {
    try {
      return (await this.fetch('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey })) as RawAccessKeyView
    } catch (e) {
      if (e instanceof NearRpcError && UNKNOWN.test(e.errorName ?? e.message)) return undefined
      throw e
    }
  }

  /** View call; the JSON-decoded return value (`null` for an empty result). */
  async callFunction<T = unknown>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = (await this.fetch('query', {
      request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
    })) as RawCallResult
    if (r.error) throw new NearRpcError('query', { name: 'HANDLER_ERROR', message: r.error, cause: { name: 'CONTRACT_EXECUTION_ERROR' } })
    const text = new TextDecoder().decode(Uint8Array.from(r.result ?? []))
    if (!text.length) return null as T
    return JSON.parse(text) as T
  }

  async latestBlockHash(): Promise<string> {
    const b = (await this.fetch('block', { finality: 'final' })) as { header?: { hash?: string } }
    if (!b.header?.hash) throw new NetworkError('block: no header hash in the response')
    return b.header.hash
  }

  async gasPrice(): Promise<bigint> {
    const r = (await this.fetch('gas_price', [null])) as { gas_price?: string }
    if (!r.gas_price) throw new NetworkError('gas_price: no price in the response')
    return BigInt(r.gas_price)
  }

  async sendTx(signedTxBase64: string, waitUntil: 'NONE' | 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'INCLUDED_FINAL' | 'EXECUTED' | 'FINAL' = 'EXECUTED_OPTIMISTIC'): Promise<RawFinalOutcome> {
    return (await this.fetch('send_tx', { signed_tx_base64: signedTxBase64, wait_until: waitUntil })) as RawFinalOutcome
  }

  /** `undefined` when the node does not know the transaction. */
  async txStatus(hash: string, senderId: string): Promise<RawFinalOutcome | undefined> {
    try {
      return (await this.fetch('tx', { tx_hash: hash, sender_account_id: senderId, wait_until: 'NONE' })) as RawFinalOutcome
    } catch (e) {
      if (e instanceof NearRpcError && UNKNOWN.test(e.errorName ?? e.message)) return undefined
      throw e
    }
  }
}

/** Human-readable failure from an execution `status` (`{Failure: {...}}`), or undefined on success. */
export function failureOf(status: Record<string, unknown> | undefined): string | undefined {
  if (!status || !('Failure' in status)) return undefined
  const f = status.Failure
  try {
    const json = JSON.stringify(f)
    const m = /"ExecutionError":"([^"]+)"/.exec(json) ?? /"error_message":"([^"]+)"/.exec(json) ?? /"kind":(\{[^}]*\})/.exec(json)
    return m?.[1] ?? json.slice(0, 300)
  } catch { return String(f) }
}

/** Did the whole transaction (every receipt) succeed? */
export function outcomeFailed(o: RawFinalOutcome): string | undefined {
  const top = failureOf(o.status)
  if (top) return top
  for (const r of o.receipts_outcome ?? []) {
    const f = failureOf(r.outcome?.status)
    if (f) return f
  }
  return undefined
}
