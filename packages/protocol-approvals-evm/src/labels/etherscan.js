'use strict'

import { getAddress } from 'ethers'

import { ApprovalsError } from '../approvals-protocol.js'
import { ETHERSCAN_V2_URL } from '../sources/etherscan.js'

/**
 * @typedef {Object} SpenderLabel
 * @property {string} name - Verified contract name (Etherscan `ContractName`), e.g. `THORChain_Router`, `LiFiDiamond`.
 * @property {string} [url] - Explorer page of the spender.
 */

/**
 * Spender labels from Etherscan V2 `module=contract&action=getsourcecode`:
 * the verified contract's name, one request per unique spender, remembered
 * for the life of the instance (pass `cache` to persist). Unverified
 * contracts and EOAs resolve to nothing. Same key / proxy rules as
 * {@link EtherscanSource}.
 */
export default class EtherscanLabels {
  /**
   * @param {Object} options
   * @param {number} options.chainId
   * @param {string} [options.apiKey]
   * @param {string} [options.baseUrl] - Endpoint or your own proxy (default {@link ETHERSCAN_V2_URL}).
   * @param {string} [options.explorerUrl] - Explorer origin for `url` (e.g. `https://etherscan.io`).
   * @param {typeof fetch} [options.fetch]
   * @param {Record<string, string>} [options.headers]
   * @param {{ get: (key: string) => any, set: (key: string, value: any) => any }} [options.cache] - Persistent cache; keys are `label:<chainId>:<address>`.
   * @param {number} [options.concurrency] - Parallel requests (default 2; the free tier allows 3–5/s).
   */
  constructor ({ chainId, apiKey, baseUrl = ETHERSCAN_V2_URL, explorerUrl, fetch: fetchImpl, headers, cache, concurrency = 2 } = {}) {
    if (chainId === undefined || chainId === null) throw new ApprovalsError('EtherscanLabels needs a chainId.', 'source-failed')
    /** @private */
    this._chainId = Number(chainId)
    /** @private */
    this._apiKey = apiKey ?? null
    /** @private */
    this._baseUrl = baseUrl
    /** @private */
    this._explorerUrl = explorerUrl ? explorerUrl.replace(/\/+$/, '') : null
    /** @private */
    this._fetch = fetchImpl ?? globalThis.fetch
    if (typeof this._fetch !== 'function') throw new ApprovalsError('EtherscanLabels needs a fetch implementation.', 'source-failed')
    /** @private */
    this._headers = { accept: 'application/json', ...(headers ?? {}) }
    /** @private */
    this._cache = cache ?? null
    /** @private */
    this._memo = new Map()
    /** @private */
    this._concurrency = Math.max(1, concurrency)
  }

  /**
   * @param {string[]} addresses
   * @returns {Promise<Record<string, SpenderLabel>>} Lowercase address → label; unknown addresses are absent.
   */
  async resolve (addresses) {
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))]
    /** @type {Record<string, SpenderLabel>} */
    const out = {}
    const todo = []
    for (const a of unique) {
      const key = `label:${this._chainId}:${a}`
      let hit = this._memo.get(a)
      if (hit === undefined && this._cache) {
        try { hit = await this._cache.get(key) } catch { hit = undefined }
        if (hit !== undefined && hit !== null) this._memo.set(a, hit)
      }
      if (hit !== undefined && hit !== null) {
        if (hit.name) out[a] = hit
      } else {
        todo.push(a)
      }
    }
    let next = 0
    const worker = async () => {
      while (next < todo.length) {
        const a = todo[next++]
        const name = await this._lookup(a)
        const label = name ? { name, ...(this._explorerUrl ? { url: `${this._explorerUrl}/address/${getAddress(a)}` } : {}) } : { name: '' }
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
   *
   * @private
   */
  async _lookup (address, depth = 0) {
    const sep = this._baseUrl.includes('?') ? '&' : '?'
    const url = `${this._baseUrl}${sep}chainid=${this._chainId}&module=contract&action=getsourcecode&address=${address}${this._apiKey ? `&apikey=${this._apiKey}` : ''}`
    try {
      const res = await this._fetch(url, { headers: this._headers })
      if (!res.ok) return null
      const body = await res.json()
      const row = Array.isArray(body.result) ? body.result[0] : null
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
