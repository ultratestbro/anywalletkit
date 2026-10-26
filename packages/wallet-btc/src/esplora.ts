import { NetworkError } from '@anywalletkit/core'
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, isHex64, isRecord, refusal, refusedStatus } from './http.js'
import type { BlockbookTx, BtcClient, Utxo } from './types.js'

interface EsploraStats { funded_txo_sum: number; spent_txo_sum: number }
interface EsploraStatus { confirmed: boolean; block_height?: number }
const isStats = (v: unknown): v is EsploraStats => isRecord(v) && typeof v.funded_txo_sum === 'number' && typeof v.spent_txo_sum === 'number'
const isStatus = (v: unknown): v is EsploraStatus => isRecord(v) && typeof v.confirmed === 'boolean'

/**
 * Esplora REST transport — the API served by mempool.space (`https://mempool.space/api`)
 * and Blockstream (`https://blockstream.info/api`). Public instances exist, so it is
 * the natural fallback behind a self-hosted Blockbook.
 *
 * Balance semantics: `unconfirmedOutgoing` is the mempool net outflow
 * (spent − funded, clamped at 0), a conservative stand-in for Bitcoin Core's
 * trusted-change rule that Blockbook's richer address record allows.
 */
export class EsploraClient implements BtcClient {
  private readonly base: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(config: { url: string }, fetchFn: typeof fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const trimmed = config.url.replace(/\/+$/, '')
    this.base = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
    this.fetchFn = fetchFn
    this.timeoutMs = timeoutMs
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.base}${path}`
    const res = await fetchWithTimeout(this.fetchFn, url, init, this.timeoutMs, this.base)
    if (!res.ok) {
      // A 4xx (not 408) is the server refusing: nothing was taken. A 5xx may have been forwarded (round 3, M12).
      const reason = refusedStatus(res.status) ? (await res.text().catch(() => '')).slice(0, 200) : ''
      const err = new NetworkError(`Esplora request failed: ${res.status} ${res.statusText} (${url})${reason ? `: ${reason}` : ''}`, { provider: this.base })
      throw refusedStatus(res.status) ? refusal(err) : err
    }
    return res
  }

  private async json<T>(path: string, check: (v: unknown) => v is T): Promise<T> {
    const res = await this.request(path)
    let body: unknown
    try { body = await res.json() } catch (e) { throw new NetworkError(`Esplora returned non-JSON for ${path}`, { provider: this.base, cause: e }) }
    if (!check(body)) throw new NetworkError(`Esplora returned an unexpected shape for ${path}`, { provider: this.base })
    return body
  }

  private async text(path: string, init?: RequestInit): Promise<string> {
    return (await this.request(path, init)).text()
  }

  async getBalance(address: string) {
    const d = await this.json(`/address/${address}`, (v): v is { chain_stats: EsploraStats; mempool_stats: EsploraStats } =>
      isRecord(v) && isStats(v.chain_stats) && isStats(v.mempool_stats))
    const confirmed = BigInt(d.chain_stats.funded_txo_sum) - BigInt(d.chain_stats.spent_txo_sum)
    const unconfirmed = BigInt(d.mempool_stats.funded_txo_sum) - BigInt(d.mempool_stats.spent_txo_sum)
    const outgoing = BigInt(d.mempool_stats.spent_txo_sum) - BigInt(d.mempool_stats.funded_txo_sum)
    return { confirmed, unconfirmed, unconfirmedOutgoing: outgoing > 0n ? outgoing : 0n }
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    const d = await this.json(`/address/${address}/utxo`, (v): v is Array<{ txid: string; vout: number; value: number; status: EsploraStatus }> =>
      Array.isArray(v) && v.every((u) => isRecord(u) && isHex64(u.txid) && typeof u.vout === 'number' && typeof u.value === 'number' && isStatus(u.status)))
    return d.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), height: u.status.confirmed && u.status.block_height ? u.status.block_height : -1 }))
  }

  /** Esplora pages 25 (mempool.space: up to 50) txs per call; walk `/txs/chain/<last>` until a short page. */
  async getHistory(address: string) {
    const items: Array<{ txid: string; height: number }> = []
    const check = (v: unknown): v is Array<{ txid: string; status: EsploraStatus }> => Array.isArray(v) && v.every((t) => isRecord(t) && isHex64(t.txid) && isStatus(t.status))
    let page = await this.json(`/address/${address}/txs`, check)
    for (;;) {
      for (const t of page) items.push({ txid: t.txid, height: t.status.confirmed && t.status.block_height ? t.status.block_height : -1 })
      if (page.length < 25) break
      const confirmedTail = [...page].reverse().find((t) => t.status.confirmed)
      if (!confirmedTail) break
      page = await this.json(`/address/${address}/txs/chain/${confirmedTail.txid}`, check)
      if (page.length === 0) break
    }
    return items
  }

  async getTransactionInfo(txid: string): Promise<BlockbookTx | undefined> {
    let d: { txid: string; status: EsploraStatus; fee?: number }
    try {
      d = await this.json(`/tx/${txid}`, (v): v is { txid: string; status: EsploraStatus; fee?: number } => isRecord(v) && isHex64(v.txid) && isStatus(v.status))
    } catch (e) {
      if (e instanceof NetworkError && /\b(400|404)\b/.test(e.message)) return undefined
      throw e
    }
    const height = d.status.confirmed && d.status.block_height ? d.status.block_height : -1
    const confirmations = height > 0 ? Math.max((await this.getBlockHeight()) - height + 1, 1) : 0
    return { txid: d.txid, blockHeight: height, confirmations, ...(typeof d.fee === 'number' ? { fees: String(d.fee) } : {}) }
  }

  async getTransaction(txid: string): Promise<string> {
    const hex = (await this.text(`/tx/${txid}/hex`)).trim()
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 20) throw new NetworkError(`Esplora returned no hex for ${txid}`, { provider: this.base })
    return hex
  }

  async broadcast(rawTx: string): Promise<string> {
    const id = (await this.text('/tx', { method: 'POST', body: rawTx, headers: { 'content-type': 'text/plain' } })).trim()
    if (!/^[0-9a-fA-F]{64}$/.test(id)) throw new NetworkError(`Esplora broadcast returned an unexpected body: ${id.slice(0, 120)}`, { provider: this.base })
    return id
  }

  /** `/fee-estimates` → { "1": sat/vB, "2": …, "25": …, "144": … }; picks the nearest target ≥ `blocks`. */
  async estimateFee(blocks: number): Promise<number> {
    const d = await this.json('/fee-estimates', (v): v is Record<string, number> => isRecord(v) && Object.values(v).every((n) => typeof n === 'number'))
    const targets = Object.keys(d).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
    const target = targets.find((t) => t >= blocks) ?? targets.at(-1)
    const rate = target !== undefined ? d[String(target)] : undefined
    if (!rate || rate <= 0) throw new NetworkError('Esplora has no fee estimate', { provider: this.base })
    return rate
  }

  async getBlockHeight(): Promise<number> {
    const h = Number((await this.text('/blocks/tip/height')).trim())
    if (!Number.isInteger(h) || h <= 0) throw new NetworkError('Esplora did not report a block height', { provider: this.base })
    return h
  }
}
