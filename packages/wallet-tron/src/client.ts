import { NetworkError } from '@anywalletkit/core'
import { parseJsonExact } from './json.js'
import type { TronConfig, TronFetch } from './types.js'

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

function httpTransport(base: string, headers: Record<string, string> | undefined, timeoutMs: number): TronFetch {
  const root = base.replace(/\/+$/, '')
  return async (path, body) => {
    const signal = timeoutSignal(timeoutMs)
    let res: Response
    try {
      res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (e) {
      throw new NetworkError(`${path}: ${signal?.aborted ? `no answer within ${timeoutMs} ms` : 'request failed'}`, { provider: root, cause: e })
    }
    if (!res.ok) throw new NetworkError(`${path}: HTTP ${res.status}`, { provider: root })
    return parseJsonExact(await res.text())
  }
}

/** A provider's answer, with the failure of any earlier provider that was tried for the same call first. */
export interface TronAnswer {
  answer: unknown
  /** True when an earlier provider was tried first and failed (a timeout, a dropped connection, an HTTP error). */
  missed: boolean
  /** That provider's failure. */
  missedError?: unknown
}

/**
 * Present on a failover transport: the same call, also reporting whether an earlier provider was
 * tried and gave no answer. A broadcast needs this: that provider may hold the bytes already.
 */
export const WITH_MISSES = Symbol('tron.failover.withMisses')
export type FailoverFetch = TronFetch & { [WITH_MISSES]?: (path: string, body: unknown) => Promise<TronAnswer> }

/**
 * One transport, or a failover transport over the list. Any failure without a node's answer (a
 * timeout, a dropped connection, an HTTP error) moves on to the next provider. That holds for a
 * broadcast too: it re-sends the SAME signed bytes (one `txID`, accepted by the chain once), and
 * the account reads a duplicate answer as accepted, and a refusal that follows a provider that
 * gave no answer as maybe sent.
 */
export function createClient(config: TronConfig): FailoverFetch | undefined {
  if (config.provider === undefined) return undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const list = (Array.isArray(config.provider) ? config.provider : [config.provider]).map((p) =>
    typeof p === 'string' ? httpTransport(p, config.headers, timeoutMs) : p,
  )
  if (list.length === 0) throw new Error("The 'provider' option cannot be set to an empty list.")
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  const withMisses = async (path: string, body: unknown): Promise<TronAnswer> => {
    let lastError: unknown
    let missed = false
    for (let i = 0; i < attempts; i++) {
      try {
        const answer = await list[i % list.length]!(path, body)
        return missed ? { answer, missed, missedError: lastError } : { answer, missed }
      } catch (e) { lastError = e; missed = true }
    }
    throw new NetworkError(`All Tron providers failed for ${path}`, { cause: lastError })
  }
  const client: FailoverFetch = async (path, body) => (await withMisses(path, body)).answer
  client[WITH_MISSES] = withMisses
  return client
}

/** Full-node responses that carry an error body instead of a transaction. */
export function assertNoError(res: unknown, what: string): void {
  const r = res as { Error?: string; code?: string; message?: string; result?: { result?: boolean; code?: string; message?: string } }
  const hexMsg = (m: string | undefined) => (m && /^[0-9a-f]+$/i.test(m) ? Buffer_from_hex(m) : m)
  if (r?.Error) throw new Error(`${what}: ${r.Error}`)
  if (r?.result && typeof r.result === 'object' && r.result.result === false) throw new Error(`${what}: ${r.result.code ?? ''} ${hexMsg(r.result.message) ?? ''}`.trim())
  if (r?.code && r.code !== 'SUCCESS' && !('txID' in (r as object))) throw new Error(`${what}: ${r.code} ${hexMsg(r.message) ?? ''}`.trim())
}

/**
 * `broadcasttransaction` codes java-tron returns when it refused the transaction before pushing it
 * to the network: nothing was sent, so signing again is safe. `DUP_TRANSACTION_ERROR` (already
 * known) is read as accepted; `OTHER_ERROR` and any other answer may come after the push.
 * `NOT_ENOUGH_EFFECTIVE_CONNECTION` is a refusal only before the push: see {@link isBroadcastRefusal}.
 */
export const BROADCAST_REFUSED: ReadonlySet<string> = new Set([
  'SIGERROR', 'CONTRACT_VALIDATE_ERROR', 'CONTRACT_EXE_ERROR', 'BANDWITH_ERROR', 'TAPOS_ERROR', 'TOO_BIG_TRANSACTION_ERROR',
  'TRANSACTION_EXPIRATION_ERROR', 'SERVER_BUSY', 'NO_CONNECTION', 'NOT_ENOUGH_EFFECTIVE_CONNECTION', 'BLOCK_UNSOLIDIFIED',
])

/**
 * Is this `broadcasttransaction` answer one of the pre-push refusals? java-tron also answers
 * `NOT_ENOUGH_EFFECTIVE_CONNECTION` ("P2P broadcast failed.") after it has put the transaction in
 * its own pending pool, so that message is not a refusal.
 */
export function isBroadcastRefusal(code: unknown, message: unknown): boolean {
  if (typeof code !== 'string' || !BROADCAST_REFUSED.has(code)) return false
  return !(code === 'NOT_ENOUGH_EFFECTIVE_CONNECTION' && /p2p broadcast/i.test(nodeMessage(message)))
}

/** A node message, hex-decoded when it is hex (java-tron hex-encodes `message`). */
export function nodeMessage(m: unknown): string {
  if (typeof m !== 'string') return ''
  return /^[0-9a-f]+$/i.test(m) ? Buffer_from_hex(m) : m
}

function Buffer_from_hex(hex: string): string {
  try { return new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))) } catch { return hex }
}
