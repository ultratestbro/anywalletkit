/**
 * Preflight emulation of a zero-signed external through tonapi
 * (`POST /v2/wallet/emulate`, fallback `POST /v2/traces/emulate`) or a
 * toncenter v3 `emulateTrace` endpoint. The verdict decides whether the
 * account signs at all; `risk` (tonapi only) summarises what would leave the
 * wallet so a foreign body cannot quietly drain it.
 *
 * tonapi shapes used (OpenAPI v2):
 *   MessageConsequences = { trace: Trace, event: AccountEvent, risk: Risk }
 *   Trace   = { transaction: Transaction, interfaces: string[], children?: Trace[], emulated?: boolean }
 *   Transaction.compute_phase = { skipped, skip_reason?, success?, exit_code?, exit_code_description? }
 *   Transaction.action_phase  = { success, result_code, … }
 *   Transaction.{ success, aborted, bounce_phase? }
 *   Risk = { transfer_all_remaining_balance, ton, jettons: [{ quantity, wallet_address: { address }, jetton: { address, symbol, decimals } }], nfts }
 */
import type { Cell } from '@ton/core'
import { NetworkError } from '@anywalletkit/core'
import { emulateExternal as emulateToncenter, type EmulationVerdict } from './toncenter.js'
import type { TonEmulateConfig, TonRisk } from './types.js'

const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_TONAPI = 'https://tonapi.io/v2'

export type EmulationSource = 'tonapi' | 'toncenter-v3'

export interface EmulationOutcome extends EmulationVerdict {
  source: EmulationSource
  /** Failed/bounced transactions deeper than the first hop — informational. */
  warnings: string[]
  /** tonapi `risk`: what the message would move out of the wallet. */
  risk?: TonRisk
}

interface TonapiTx {
  hash?: string
  account?: { address?: string } | string
  success?: boolean
  aborted?: boolean
  compute_phase?: { skipped?: boolean; skip_reason?: string; success?: boolean; exit_code?: number; exit_code_description?: string }
  action_phase?: { success?: boolean; result_code?: number; result_code_description?: string }
  bounce_phase?: string
}
interface TonapiTrace { transaction?: TonapiTx; children?: TonapiTrace[] }

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * A plain value transfer to an account that does not exist yet: the chain
 * credits the coins and leaves the account `uninit`; tonapi reports the hop as
 * `success: true, aborted: true, compute skipped (cskip_no_state)` with no
 * bounce phase. That is the normal shape of funding a fresh deposit address
 * (NEAR Intents TON deposits, 2026-10-09) — not a failure. A BOUNCEABLE
 * message to the same account bounces instead (`bounce_phase` set) and stays
 * fatal, since the value comes back minus fees.
 */
function creditedUninit(tx: TonapiTx): boolean {
  const c = tx.compute_phase
  return tx.success === true && c?.skipped === true && c.skip_reason === 'cskip_no_state' && tx.bounce_phase === undefined && (tx.action_phase === undefined || tx.action_phase.success !== false)
}

function txFailure(tx: TonapiTx): string | undefined {
  const c = tx.compute_phase
  if (creditedUninit(tx)) return undefined
  if (tx.aborted === true) return 'aborted'
  if (c && c.skipped !== true && typeof c.exit_code === 'number' && c.exit_code !== 0) return `compute exit_code ${c.exit_code}${c.exit_code_description ? ` (${c.exit_code_description})` : ''}`
  if (c && c.skipped === true && tx.success === false) return `compute skipped${c.skip_reason ? ` (${c.skip_reason})` : ''}`
  if (tx.action_phase && tx.action_phase.success === false) return `action phase failed${typeof tx.action_phase.result_code === 'number' ? ` (code ${tx.action_phase.result_code})` : ''}`
  if (typeof tx.bounce_phase === 'string' && tx.bounce_phase !== 'TrPhaseBounceOk' && tx.success === false) return `bounced (${tx.bounce_phase})`
  if (tx.success === false) return 'failed'
  return undefined
}

function accountOf(tx: TonapiTx): string {
  return typeof tx.account === 'string' ? tx.account : tx.account?.address ?? '?'
}

/**
 * Reduce a tonapi `Trace` to a verdict. The root (the wallet's own transaction)
 * decides: compute exit ≠ 0, aborted or a failed action phase → not ok. A
 * failing FIRST-HOP child is also fatal: for every message this wallet builds
 * (TON to a contract, jetton transfer to its own jetton wallet) a bounced
 * first hop means the operation did not happen and the value comes back minus
 * fees. Deeper failures (e.g. a jetton notify the recipient's wallet rejects)
 * become warnings — the transfer itself already settled.
 */
export function parseTonapiTrace(trace: unknown): Omit<EmulationOutcome, 'source' | 'risk'> {
  if (!isObject(trace) || !isObject(trace.transaction)) throw new NetworkError('Malformed tonapi emulation: no root transaction')
  const root = trace.transaction as TonapiTx
  const compute = root.compute_phase
  const exitCode = compute && compute.skipped !== true && typeof compute.exit_code === 'number' ? compute.exit_code : compute?.success === true ? 0 : undefined
  const actionSuccess = typeof root.action_phase?.success === 'boolean' ? root.action_phase.success : undefined
  if (exitCode === undefined && actionSuccess === undefined && typeof root.success !== 'boolean' && typeof root.aborted !== 'boolean') {
    throw new NetworkError('Malformed tonapi emulation: root transaction has no phases')
  }
  const aborted = root.aborted === true
  const rootFailure = txFailure(root)
  const warnings: string[] = []
  let firstHopFailure: string | undefined
  const walk = (t: TonapiTrace, depth: number) => {
    for (const child of t.children ?? []) {
      const tx = child.transaction
      if (tx) {
        const f = txFailure(tx)
        if (f) {
          const line = `${accountOf(tx)}: ${f}`
          if (depth === 1) firstHopFailure ??= line
          else warnings.push(line)
        }
      }
      walk(child, depth + 1)
    }
  }
  walk(trace as TonapiTrace, 1)
  const reason = rootFailure ? (aborted ? 'transaction aborted' : rootFailure) : firstHopFailure ? `internal message failed — ${firstHopFailure}` : undefined
  return {
    ok: reason === undefined,
    ...(exitCode !== undefined ? { exitCode } : {}),
    aborted,
    ...(actionSuccess !== undefined ? { actionSuccess } : {}),
    ...(reason ? { reason } : {}),
    warnings,
  }
}

/** tonapi `Risk` → nanotons / jetton base units as bigints. Malformed → NetworkError. */
export function parseTonapiRisk(risk: unknown): TonRisk {
  if (!isObject(risk)) throw new NetworkError('Malformed tonapi emulation: no risk')
  const big = (v: unknown): bigint => {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
    throw new NetworkError('Malformed tonapi emulation: risk amount')
  }
  const jettons = Array.isArray(risk.jettons) ? risk.jettons : []
  return {
    ton: big(risk.ton ?? 0),
    transferAllRemainingBalance: risk.transfer_all_remaining_balance === true,
    jettons: jettons.map((j) => {
      if (!isObject(j)) throw new NetworkError('Malformed tonapi emulation: risk jetton')
      const jetton = isObject(j.jetton) ? j.jetton : {}
      const wallet = isObject(j.wallet_address) ? j.wallet_address : {}
      return {
        amount: big(j.quantity ?? 0),
        address: typeof jetton.address === 'string' ? jetton.address : '',
        walletAddress: typeof wallet.address === 'string' ? wallet.address : '',
        ...(typeof jetton.symbol === 'string' ? { symbol: jetton.symbol } : {}),
        ...(typeof jetton.decimals === 'number' ? { decimals: jetton.decimals } : {}),
      }
    }),
  }
}

/** tonapi `MessageConsequences` (wallet/emulate) → outcome with risk. */
export function parseTonapiConsequences(json: unknown): EmulationOutcome {
  if (!isObject(json)) throw new NetworkError('Malformed tonapi emulation response')
  if (typeof json.error === 'string') return { ok: false, reason: json.error, aborted: false, warnings: [], source: 'tonapi' }
  const verdict = parseTonapiTrace(json.trace)
  return { ...verdict, source: 'tonapi', risk: parseTonapiRisk(json.risk) }
}

export interface EmulateOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  /** tonapi bearer key / toncenter X-API-Key. */
  apiKey?: string
}

async function post(doFetch: typeof fetch, url: string, body: unknown, opts: EmulateOptions): Promise<{ status: number; ok: boolean; json: unknown }> {
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (e) {
    throw new NetworkError(`emulate: ${e instanceof Error ? e.message : String(e)}`, { provider: url, cause: e })
  }
  if (res.status === 404) return { status: 404, ok: false, json: undefined }
  let json: unknown
  try { json = await res.json() } catch (e) { throw new NetworkError(`emulate: HTTP ${res.status}, non-JSON body`, { provider: url, cause: e }) }
  return { status: res.status, ok: res.ok, json }
}

function httpFailure(status: number, json: unknown): EmulationOutcome {
  const err = isObject(json) ? json : {}
  const text = typeof err.error === 'string' ? err.error : JSON.stringify(err.detail ?? err.error ?? json)
  return { ok: false, reason: `HTTP ${status}: ${text}`, aborted: false, warnings: [], source: 'tonapi' }
}

/**
 * Emulate through tonapi: `/wallet/emulate` first (verdict + risk), then
 * `/traces/emulate` when the first is not served (404). The external carries a
 * zero signature; `ignore_signature_check=true` is sent on both calls.
 */
export async function emulateViaTonapi(baseUrl: string, message: Cell, opts: EmulateOptions = {}): Promise<EmulationOutcome> {
  const doFetch = opts.fetch ?? globalThis.fetch
  const base = baseUrl.replace(/\/+$/, '')
  const boc = message.toBoc().toString('base64')
  const first = await post(doFetch, `${base}/wallet/emulate?ignore_signature_check=true`, { boc }, opts)
  if (first.status !== 404) {
    if (!first.ok) return httpFailure(first.status, first.json)
    return parseTonapiConsequences(first.json)
  }
  const second = await post(doFetch, `${base}/traces/emulate?ignore_signature_check=true`, { boc }, opts)
  if (second.status === 404) throw new NetworkError('emulate: tonapi serves neither /wallet/emulate nor /traces/emulate', { provider: base })
  if (!second.ok) return httpFailure(second.status, second.json)
  if (isObject(second.json) && typeof second.json.error === 'string') return { ok: false, reason: second.json.error, aborted: false, warnings: [], source: 'tonapi' }
  return { ...parseTonapiTrace(second.json), source: 'tonapi' }
}

/** Resolve the effective emulation config: explicit `emulate`, legacy `emulateUrl`, else tonapi by default. */
export function resolveEmulate(config: { emulate?: TonEmulateConfig; emulateUrl?: string; tonApiUrl?: string }): Exclude<TonEmulateConfig, false> | false {
  if (config.emulate === false) return false
  if (config.emulate) return config.emulate
  if (config.emulateUrl) return { kind: 'toncenter-v3', url: config.emulateUrl }
  return { kind: 'tonapi' }
}

/** Run the configured emulation for an external message. */
export async function runEmulation(config: { emulate?: TonEmulateConfig; emulateUrl?: string; tonApiUrl?: string; tonApiKey?: string; fetch?: typeof fetch; timeoutMs?: number }, message: Cell): Promise<EmulationOutcome | undefined> {
  const target = resolveEmulate(config)
  if (!target) return undefined
  const opts: EmulateOptions = {
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.tonApiKey ? { apiKey: config.tonApiKey } : {}),
  }
  if (target.kind === 'tonapi') return emulateViaTonapi(target.url ?? config.tonApiUrl ?? DEFAULT_TONAPI, message, opts)
  const v = await emulateToncenter(target.url, message, opts)
  return { ...v, aborted: v.aborted ?? false, source: 'toncenter-v3', warnings: [] }
}
