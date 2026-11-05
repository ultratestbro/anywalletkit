// Curve's prices API — decoration only (the projected scrvUSD APY). Never on a money path:
// the vault, its asset and every amount are read on-chain, and the APY it reports is bounded
// by the on-chain profit-unlocking rate before it is shown (see `ScrvUsdProtocolEvm.getApyDetails`).
//
// The API has no auth and no signature, and curve.fi was hijacked at the registrar twice
// (2022-08, 2025-05) before Curve moved to curve.finance: only https and curve.finance or one
// of its subdomains are accepted as the endpoint. Response shape as of 2026-11-05:
// `/v1/crvusd/savings/statistics` → { last_updated, last_updated_block, proj_apy, supply }.
import { CURVE_PRICES_API } from './chains.js'
import { CurveLendingError } from './errors.js'

/** Default timeout for API reads: an API that never answers must not hang the caller. */
export const API_TIMEOUT_MS = 15_000

/** `fetch` with a timeout: `AbortSignal.timeout` where the runtime has it, else a timer (Hermes without runtime-hermes). */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  let signal: AbortSignal | undefined
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') signal = AbortSignal.timeout(ms)
  else if (typeof AbortController !== 'undefined') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms) as unknown as { unref?: () => void }
    timer.unref?.()
    signal = controller.signal
  }
  return fetch(url, signal ? { signal } : {})
}

/**
 * Throws unless `url` is https on curve.finance or a subdomain of it (no credentials, no port).
 * Returns the URL without a trailing slash. Parsed by pattern, not with `URL`: React Native's
 * built-in `URL` lacks a working `hostname`.
 */
export function assertCurveHost(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([/?#].*)?$/i.exec(typeof url === 'string' ? url.trim() : '')
  if (!m) throw new CurveLendingError(`'api' must be a URL, got ${String(url)}.`)
  const scheme = m[1]!.toLowerCase(), authority = m[2]!.toLowerCase()
  const host = authority.replace(/\.$/, '')
  const ok = scheme === 'https' && /^[a-z0-9.-]+$/.test(host) && (host === 'curve.finance' || host.endsWith('.curve.finance'))
  if (!ok) throw new CurveLendingError(`'api' must be an https URL on curve.finance (got ${scheme}://${authority}); curve.fi and other hosts are refused.`, 'ApiHostRefused')
  return `https://${host}${(m[3] ?? '').replace(/\/+$/, '')}`
}

export interface ScrvUsdApiStats {
  /** Projected APY, percent. */
  projApy: number
  /** scrvUSD supply, whole tokens (display). */
  supply: number | null
  /** Ethereum block the figure was computed at, when given. */
  lastUpdatedBlock: number | null
  lastUpdated: string | null
}

const finite = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

export class CurveApi {
  readonly endpoint: string
  constructor(endpoint: string = CURVE_PRICES_API, private readonly timeoutMs: number = API_TIMEOUT_MS) {
    this.endpoint = assertCurveHost(endpoint)
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetchWithTimeout(`${this.endpoint}${path}`, this.timeoutMs)
    if (!res.ok) throw new CurveLendingError(`Curve API ${res.status} for ${path}`)
    return res.json()
  }

  /** scrvUSD's projected APY and supply. Throws on a failed request or a malformed answer. */
  async savingsStatistics(): Promise<ScrvUsdApiStats> {
    const j = (await this.get('/v1/crvusd/savings/statistics')) as Record<string, unknown> | null
    const projApy = finite(j?.['proj_apy'])
    if (projApy === null) throw new CurveLendingError('Curve API: savings statistics carry no numeric proj_apy.')
    return {
      projApy,
      supply: finite(j?.['supply']),
      lastUpdatedBlock: finite(j?.['last_updated_block']),
      lastUpdated: typeof j?.['last_updated'] === 'string' ? (j['last_updated'] as string) : null,
    }
  }
}
