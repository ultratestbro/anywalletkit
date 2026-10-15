import { getAddress } from 'viem'

import { ApprovalsError, type SpenderLabel, type SpenderLabelResolver } from '../approvals-protocol.js'
import { ETHERSCAN_V2_URL } from '../sources/etherscan.js'
import type { FetchLike } from '../sources/indexer-logs.js'

/** Persistent label cache; keys are `label:<chainId>:<address>`. */
export interface LabelCache {
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

export interface EtherscanLabelsOptions {
  chainId?: number
  apiKey?: string
  /** Endpoint or your own proxy (default {@link ETHERSCAN_V2_URL}). */
  baseUrl?: string
  /** Explorer origin for `url` (e.g. `https://etherscan.io`). */
  explorerUrl?: string
  fetch?: FetchLike
  headers?: Record<string, string>
  cache?: LabelCache
  /** Parallel requests (default 2; the free tier allows 3–5/s). */
  concurrency?: number
}

/**
 * Spender labels from Etherscan V2 `module=contract&action=getsourcecode`:
 * the verified contract's name, one request per unique spender, remembered
 * for the life of the instance (pass `cache` to persist). Unverified
 * contracts and EOAs resolve to nothing. Same key / proxy rules as
 * {@link EtherscanSource}.
 */
export default class EtherscanLabels implements SpenderLabelResolver {
  private readonly _chainId: number
  private readonly _apiKey: string | null
  private readonly _baseUrl: string
  private readonly _explorerUrl: string | null
  private readonly _fetch: FetchLike
  private readonly _headers: Record<string, string>
  private readonly _cache: LabelCache | null
  private readonly _memo = new Map<string, SpenderLabel>()
  private readonly _concurrency: number

  constructor ({ chainId, apiKey, baseUrl = ETHERSCAN_V2_URL, explorerUrl, fetch: fetchImpl, headers, cache, concurrency = 2 }: EtherscanLabelsOptions = {}) {
    if (chainId === undefined || chainId === null) throw new ApprovalsError('EtherscanLabels needs a chainId.', 'source-failed')
    this._chainId = Number(chainId)
    this._apiKey = apiKey ?? null
    this._baseUrl = baseUrl
    this._explorerUrl = explorerUrl ? explorerUrl.replace(/\/+$/, '') : null
    this._fetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    if (typeof this._fetch !== 'function') throw new ApprovalsError('EtherscanLabels needs a fetch implementation.', 'source-failed')
    this._headers = { accept: 'application/json', ...(headers ?? {}) }
    this._cache = cache ?? null
    this._concurrency = Math.max(1, concurrency)
  }

  /** Lowercase address → label; unknown addresses are absent. */
  async resolve (addresses: string[]): Promise<Record<string, SpenderLabel>> {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))]
    const out: Record<string, SpenderLabel> = {}
    const todo: string[] = []
    for (const a of unique) {
      const key = `label:${this._chainId}:${a}`
      let hit: SpenderLabel | null | undefined = this._memo.get(a)
      if (hit === undefined && this._cache) {
        try { hit = (await this._cache.get(key)) as SpenderLabel | null | undefined } catch { hit = undefined }
        if (hit !== undefined && hit !== null) this._memo.set(a, hit)
      }
      if (hit !== undefined && hit !== null) {
        if (hit.name) out[a] = hit
      } else {
        todo.push(a)
      }
    }
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const a = todo[next++]!
        const name = await this._lookup(a)
        const label: SpenderLabel = name ? { name, ...(this._explorerUrl ? { url: `${this._explorerUrl}/address/${getAddress(a)}` } : {}) } : { name: '' }
        this._memo.set(a, label)
        if (this._cache) { try { await this._cache.set(`label:${this._chainId}:${a}`, label) } catch {} }
        if (label.name) out[a] = label
      }
    }
    await Promise.all(Array.from({ length: this._concurrency }, worker))
    return out
  }

  /**
   * The verified name; for a proxy (`Proxy: "1"`) the implementation's name,
   * which is what the user recognises ("USDT0 adapter", not
   * "TransparentUpgradeableProxy").
   */
  private async _lookup (address: string, depth = 0): Promise<string | null> {
    const sep = this._baseUrl.includes('?') ? '&' : '?'
    const url = `${this._baseUrl}${sep}chainid=${this._chainId}&module=contract&action=getsourcecode&address=${address}${this._apiKey ? `&apikey=${this._apiKey}` : ''}`
    try {
      const res = await this._fetch(url, { headers: this._headers })
      if (!res.ok) return null
      const body = (await res.json()) as { result?: unknown }
      const row = Array.isArray(body.result) ? (body.result[0] as { ContractName?: unknown; Implementation?: unknown; Proxy?: unknown } | undefined) : null
      const name = typeof row?.ContractName === 'string' ? row.ContractName.trim() : ''
      const impl = typeof row?.Implementation === 'string' ? row.Implementation.trim() : ''
      if (row?.Proxy === '1' && /^0x[0-9a-fA-F]{40}$/.test(impl) && depth === 0) {
        const implName = await this._lookup(impl.toLowerCase(), 1)
        if (implName) return implName
      }
      return name || null
    } catch {
      return null // a label is decoration; never fail the scan for it
    }
  }
}
