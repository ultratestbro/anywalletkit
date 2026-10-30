/**
 * toncenter v2 JSON-RPC client — the handful of calls a wallet needs, with
 * failover across endpoints, timeouts, api keys and response-shape checks.
 * No axios, no dataloader, no caches: one `fetch` per call.
 */
import { NetworkError } from '@anywalletkit/core'
import { Buffer } from 'buffer'
import { Address, Cell, TupleReader, loadTransaction, type StateInit, type Transaction, type TupleItem } from '@ton/core'
import type { TonConfig, TonEndpoint, TonFees, TonProvider, TonRpc } from './types.js'

const DEFAULT_TIMEOUT_MS = 15_000

const isRpc = (p: TonProvider): p is TonRpc => typeof (p as TonRpc).call === 'function'

/** JSON-RPC over one toncenter v2 endpoint. */
export function tonCenterEndpoint(endpoint: TonEndpoint, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): TonRpc {
  const url = endpoint.url
  const doFetch = opts.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new NetworkError('No fetch available; pass config.fetch', { provider: url })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(endpoint.secretKey ? { 'X-API-Key': endpoint.secretKey } : {}),
          },
          body: JSON.stringify({ id: '1', jsonrpc: '2.0', method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        throw new NetworkError(`${method}: ${e instanceof Error ? e.message : String(e)}`, { provider: url, cause: e })
      }
      let json: { ok?: boolean; result?: T; error?: unknown; code?: unknown }
      try { json = (await res.json()) as typeof json } catch (e) {
        throw new NetworkError(`${method}: HTTP ${res.status}, non-JSON body`, { provider: url, cause: e })
      }
      if (!res.ok || json.ok !== true) {
        const detail = typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? json)
        const err = new NetworkError(`${method}: ${detail} (HTTP ${res.status})`, { provider: url })
        // Only toncenter's own refusal envelope means the node said no; a gateway's JSON 502 / 504, a timeout or a
        // bare `{}` may come after the node took the message (reaudit 2026-10-30, #2).
        throw isNodeRefusal(res.status, json) ? Object.assign(err, { answered: true }) : err
      }
      return json.result as T
    },
  }
}

/** HTTP statuses a gateway or proxy answers with when it lost track of the upstream request. */
const UNKNOWN_STATUS = new Set([408, 502, 503, 504])

/**
 * toncenter's refusal envelope, `{ok: false, error: "<reason>", code}` (a refused `sendBoc` is HTTP 500 with
 * `INVALID_BAG_OF_CELLS: …` or `LITE_SERVER_UNKNOWN: cannot apply external message …`, read live 2026-10-30), and not
 * a timeout: the node had the message and turned it down.
 */
function isNodeRefusal(status: number, json: { ok?: unknown; error?: unknown }): boolean {
  if (UNKNOWN_STATUS.has(status)) return false
  if (json.ok !== false || typeof json.error !== 'string' || json.error.trim() === '') return false
  return !/time[ds]? ?out|timed out|deadline/i.test(json.error)
}

/** An endpoint answered with a node refusal (toncenter's `ok: false` envelope): nothing was taken. A thrown fetch, a timeout, a non-JSON body or a gateway error may have been. */
export function isAnsweredRefusal(e: unknown): boolean {
  return (e as { answered?: unknown } | null)?.answered === true
}

/** One RPC, or a failover RPC walking the configured list (`retries` extra rounds after the first full pass). */
export function createTonRpc(config: TonConfig): TonRpc | undefined {
  const target = config.tonClient ?? config.provider
  if (target === undefined) return undefined
  const list = (Array.isArray(target) ? target : [target]).map((p) =>
    isRpc(p) ? p : tonCenterEndpoint(p, { ...(config.fetch ? { fetch: config.fetch } : {}), ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) }),
  )
  if (list.length === 0) throw new Error("The 'tonClient' option cannot be set to an empty list.")
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  return {
    async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
      let lastError: unknown
      let answered = true
      for (let i = 0; i < attempts; i++) {
        try { return await list[i % list.length]!.call<T>(method, params) } catch (e) { lastError = e; answered &&= isAnsweredRefusal(e) }
      }
      // Refused everywhere is a refusal; one endpoint that never answered may have taken it.
      const err = new NetworkError(`All TON endpoints failed for ${method}`, { cause: lastError })
      throw answered ? Object.assign(err, { answered: true }) : err
    },
  }
}

// ── Stack (de)serialization, toncenter v2 wire format ───────────────────────

function serializeStackItem(item: TupleItem): [string, unknown] {
  switch (item.type) {
    case 'int': return ['num', item.value.toString()]
    case 'cell': return ['tvm.Cell', item.cell.toBoc().toString('base64')]
    case 'slice': return ['tvm.Slice', item.cell.toBoc().toString('base64')]
    case 'builder': return ['tvm.Builder', item.cell.toBoc().toString('base64')]
    default: throw new Error(`Unsupported stack item type: ${item.type}`)
  }
}

const hexBigInt = (s: string): bigint => (s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s))
const cellFromBase64 = (b64: string): Cell => Cell.fromBoc(Buffer.from(b64, 'base64'))[0]!

function parseStackEntry(x: unknown): TupleItem {
  const o = x as Record<string, unknown>
  switch (o['@type']) {
    case 'tvm.list':
    case 'tvm.tuple': return { type: 'tuple', items: (o.elements as unknown[]).map(parseStackEntry) }
    case 'tvm.cell': return { type: 'cell', cell: cellFromBase64(o.bytes as string) }
    case 'tvm.stackEntryCell': return parseStackEntry(o.cell)
    case 'tvm.stackEntryTuple': return parseStackEntry(o.tuple)
    case 'tvm.stackEntryNumber': return parseStackEntry(o.number)
    case 'tvm.numberDecimal': return { type: 'int', value: BigInt(o.number as string) }
    default: throw new NetworkError(`Malformed stack entry: ${JSON.stringify(x)}`)
  }
}

function parseStackItem(s: unknown): TupleItem {
  if (!Array.isArray(s) || s.length < 2) throw new NetworkError(`Malformed stack item: ${JSON.stringify(s)}`)
  const [kind, value] = s as [string, unknown]
  switch (kind) {
    case 'num': return { type: 'int', value: hexBigInt(value as string) }
    case 'null': return { type: 'null' }
    case 'cell': return { type: 'cell', cell: cellFromBase64((value as { bytes: string }).bytes) }
    case 'slice': return { type: 'slice', cell: cellFromBase64((value as { bytes: string }).bytes) }
    case 'builder': return { type: 'builder', cell: cellFromBase64((value as { bytes: string }).bytes) }
    case 'tuple':
    case 'list': return { type: 'tuple', items: ((value as { elements: unknown[] }).elements ?? []).map(parseStackEntry) }
    default: throw new NetworkError(`Malformed stack item kind: ${kind}`)
  }
}

// ── Typed API ───────────────────────────────────────────────────────────────

/** State of a TON account on chain. */
export type TonAccountStatus = 'active' | 'uninitialized' | 'frozen' | 'nonexist'

/** Balance, status, code and data of an account. */
export interface TonAccountState {
  balance: bigint
  state: TonAccountStatus
  code: Cell | null
  data: Cell | null
  lastTransaction: { lt: string; hash: string } | null
}

/** Result of a contract get-method call. */
export interface GetMethodResult { exitCode: number; gasUsed: number; stack: TupleReader }

const need = <T>(cond: unknown, what: string, value: T): T => {
  if (!cond) throw new NetworkError(`Malformed toncenter response: ${what}`)
  return value
}

/** The toncenter calls a wallet uses, with parsed results. */
export class TonCenter {
  constructor(readonly rpc: TonRpc) {}

  /** Balance, status, code and data of an account. */
  async getAddressInformation(address: Address): Promise<TonAccountState> {
    const r = await this.rpc.call<Record<string, unknown>>('getAddressInformation', { address: address.toString() })
    need(r && typeof r === 'object' && typeof r.balance === 'string', 'getAddressInformation', r)
    const state = r.state as string
    const last = r.last_transaction_id as { lt?: string; hash?: string } | undefined
    return {
      balance: BigInt(r.balance as string),
      state: (['active', 'uninitialized', 'frozen', 'nonexist'] as const).includes(state as TonAccountStatus) ? (state as TonAccountStatus) : 'nonexist',
      code: typeof r.code === 'string' && r.code !== '' ? cellFromBase64(r.code) : null,
      data: typeof r.data === 'string' && r.data !== '' ? cellFromBase64(r.data) : null,
      lastTransaction: last && last.lt && last.lt !== '0' ? { lt: last.lt, hash: last.hash ?? '' } : null,
    }
  }

  /** Call a contract get-method; the result carries the exit code. */
  async runGetMethod(address: Address, method: string, stack: TupleItem[] = []): Promise<GetMethodResult> {
    const r = await this.rpc.call<Record<string, unknown>>('runGetMethod', {
      address: address.toString(), method, stack: stack.map(serializeStackItem),
    })
    need(r && typeof r === 'object' && typeof r.exit_code === 'number' && Array.isArray(r.stack), 'runGetMethod', r)
    return { exitCode: r.exit_code as number, gasUsed: Number(r.gas_used ?? 0), stack: new TupleReader((r.stack as unknown[]).map(parseStackItem)) }
  }

  /** Like runGetMethod but throws on a non-zero exit code. */
  async runGetMethodOk(address: Address, method: string, stack: TupleItem[] = []): Promise<GetMethodResult> {
    const r = await this.runGetMethod(address, method, stack)
    if (r.exitCode !== 0) throw new NetworkError(`Get method ${method} failed with exit_code: ${r.exitCode}`)
    return r
  }

  /** Broadcast a signed external message. */
  async sendBoc(message: Cell): Promise<void> {
    await this.rpc.call('sendBoc', { boc: message.toBoc().toString('base64') })
  }

  /** Broadcast and return the external-message hash (base64) toncenter reports. */
  async sendBocReturnHash(message: Cell): Promise<string> {
    const r = await this.rpc.call<{ hash?: string }>('sendBocReturnHash', { boc: message.toBoc().toString('base64') })
    return need(r && typeof r.hash === 'string', 'sendBocReturnHash', r.hash as string)
  }

  async getTransactions(address: Address, opts: { limit: number; lt?: string; hash?: string; archival?: boolean }): Promise<Transaction[]> {
    const params: Record<string, unknown> = { address: address.toString(), limit: opts.limit }
    if (opts.lt) params.lt = opts.lt
    if (opts.hash) params.hash = Buffer.from(opts.hash, 'base64').toString('hex')
    if (opts.archival) params.archival = true
    const r = await this.rpc.call<unknown>('getTransactions', params)
    need(Array.isArray(r), 'getTransactions', r)
    return (r as Array<{ data?: string }>).map((t) => {
      need(typeof t.data === 'string', 'getTransactions[].data', t)
      return loadTransaction(cellFromBase64(t.data as string).beginParse())
    })
  }

  async estimateFee(address: Address, args: { body: Cell; init?: StateInit; ignoreSignature?: boolean }): Promise<TonFees> {
    const r = await this.rpc.call<{ source_fees?: Record<string, unknown> }>('estimateFee', {
      address: address.toString(),
      body: args.body.toBoc().toString('base64'),
      init_code: args.init ? args.init.code!.toBoc().toString('base64') : '',
      init_data: args.init ? args.init.data!.toBoc().toString('base64') : '',
      ignore_chksig: args.ignoreSignature ?? true,
    })
    const f = r?.source_fees
    need(f && ['in_fwd_fee', 'storage_fee', 'gas_fee', 'fwd_fee'].every((k) => typeof f[k] === 'number' || typeof f[k] === 'string'), 'estimateFee', r)
    const fees = {
      inFwdFee: BigInt(f!.in_fwd_fee as number), storageFee: BigInt(f!.storage_fee as number),
      gasFee: BigInt(f!.gas_fee as number), fwdFee: BigInt(f!.fwd_fee as number),
    }
    return { ...fees, total: fees.inFwdFee + fees.storageFee + fees.gasFee + fees.fwdFee }
  }
}

// ── Emulation (toncenter v3 emulateTrace) ───────────────────────────────────

/**
 * Whether an emulated wallet transaction succeeded: compute exit code, abort flag, action phase.
 */
export interface EmulationVerdict {
  ok: boolean
  exitCode?: number
  aborted?: boolean
  actionSuccess?: boolean
  reason?: string
}

/**
 * Reduce an `emulateTrace` response to a verdict for the ROOT transaction (the
 * wallet's own): compute-phase exit code, aborted flag, action-phase success.
 * Tolerant of the field spellings the v3 API has used (`description.compute_ph`
 * / `compute`, `action.success`); anything unrecognisable is a NetworkError, not
 * a silent pass.
 */
export function parseEmulation(json: unknown): EmulationVerdict {
  const j = json as Record<string, unknown> | null
  if (!j || typeof j !== 'object') throw new NetworkError('Malformed emulation response')
  if (typeof j.error === 'string') return { ok: false, reason: j.error }
  const txs = j.transactions as Record<string, Record<string, unknown>> | Array<Record<string, unknown>> | undefined
  const rootHash = (j.trace as { tx_hash?: string } | undefined)?.tx_hash
  let tx: Record<string, unknown> | undefined
  if (Array.isArray(txs)) tx = txs[0]
  else if (txs && typeof txs === 'object') tx = (rootHash && txs[rootHash]) || Object.values(txs)[0]
  if (!tx) {
    if (typeof j.exit_code === 'number') return verdict(j.exit_code, j.aborted === true, undefined)
    throw new NetworkError('Malformed emulation response: no transactions')
  }
  const d = (tx.description as Record<string, unknown> | undefined) ?? tx
  const compute = (d.compute_ph ?? d.compute) as Record<string, unknown> | undefined
  const action = d.action as Record<string, unknown> | undefined
  const exitCode = typeof compute?.exit_code === 'number' ? compute.exit_code : compute?.success === true ? 0 : undefined
  const actionSuccess = typeof action?.success === 'boolean' ? action.success : undefined
  if (exitCode === undefined && d.aborted === undefined && actionSuccess === undefined) throw new NetworkError('Malformed emulation response: no phases')
  return verdict(exitCode, d.aborted === true, actionSuccess)
}

function verdict(exitCode: number | undefined, aborted: boolean, actionSuccess: boolean | undefined): EmulationVerdict {
  const ok = !aborted && (exitCode === undefined || exitCode === 0) && actionSuccess !== false
  const reason = aborted ? 'transaction aborted' : exitCode !== undefined && exitCode !== 0 ? `compute phase exit_code ${exitCode}` : actionSuccess === false ? 'action phase failed' : undefined
  return { ok, ...(exitCode !== undefined ? { exitCode } : {}), aborted, ...(actionSuccess !== undefined ? { actionSuccess } : {}), ...(reason ? { reason } : {}) }
}

/** POST the external message to a toncenter v3 emulation endpoint and reduce the trace. */
export async function emulateExternal(url: string, message: Cell, opts: { fetch?: typeof fetch; timeoutMs?: number; apiKey?: string } = {}): Promise<EmulationVerdict> {
  const doFetch = opts.fetch ?? globalThis.fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts.apiKey ? { 'X-API-Key': opts.apiKey } : {}) },
      body: JSON.stringify({ boc: message.toBoc().toString('base64'), ignore_chksig: true, include_code_data: false, with_actions: false }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (e) {
    throw new NetworkError(`emulate: ${e instanceof Error ? e.message : String(e)}`, { provider: url, cause: e })
  }
  let json: unknown
  try { json = await res.json() } catch (e) { throw new NetworkError(`emulate: HTTP ${res.status}, non-JSON body`, { provider: url, cause: e }) }
  if (!res.ok) {
    const err = (json as { error?: unknown; detail?: unknown })
    return { ok: false, reason: `HTTP ${res.status}: ${typeof err.error === 'string' ? err.error : JSON.stringify(err.detail ?? err.error ?? json)}` }
  }
  return parseEmulation(json)
}
