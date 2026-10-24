/**
 * Zcash Blockbook REST transport — the same `/api/v2` surface as Bitcoin's
 * (NOWNodes `https://zec-blockbook.nownodes.io` with an `api-key` header, any
 * self-hosted Blockbook built for Zcash). Serves testnet too.
 */
import { NetworkError } from '@anywalletkit/core'
import { hexToBytes } from './encoding.js'
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, isInt, isIntString, isRecord } from './http.js'
import type { SpentOutput, Utxo, ZcashClient, ZcashTxInfo } from './types.js'

export interface BlockbookVin { txid?: string; vout?: number; n?: number; isAddress?: boolean; addresses?: string[]; value?: string }
export interface BlockbookVout { n: number; isAddress?: boolean; addresses?: string[]; value?: string; hex?: string }
export interface BlockbookTxDetails {
  txid: string
  blockHeight: number
  confirmations: number
  blockTime?: number
  fees?: string
  hex?: string
  vin?: BlockbookVin[]
  vout?: BlockbookVout[]
}

export class ZcashBlockbookClient implements ZcashClient {
  private readonly base: string
  private readonly headers: Record<string, string>
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(config: { url: string; headers?: Record<string, string> }, fetchFn: typeof fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.base = config.url.replace(/\/+$/, '').replace(/\/api$/, '')
    this.headers = { accept: 'application/json', ...(config.headers ?? {}) }
    this.fetchFn = fetchFn
    this.timeoutMs = timeoutMs
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  private async get<T>(path: string, check: (v: unknown) => v is T): Promise<T> {
    const url = `${this.base}/api${path}`
    const res = await fetchWithTimeout(this.fetchFn, url, { headers: this.headers }, this.timeoutMs, this.base)
    if (!res.ok) throw new NetworkError(`Blockbook request failed: ${res.status} ${res.statusText} (${url})`, { provider: this.base })
    let body: unknown
    try { body = await res.json() } catch (e) { throw new NetworkError(`Blockbook returned non-JSON for ${url}`, { provider: this.base, cause: e }) }
    if (!check(body)) throw new NetworkError(`Blockbook returned an unexpected shape for ${url}`, { provider: this.base })
    return body
  }

  async getBalance(address: string) {
    const data = await this.get(`/v2/address/${address}?details=basic`, (v): v is { balance: string; unconfirmedBalance: string } => isRecord(v) && isIntString(v.balance) && isIntString(v.unconfirmedBalance))
    return { confirmed: BigInt(data.balance), unconfirmed: BigInt(data.unconfirmedBalance) }
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    const data = await this.get(`/v2/utxo/${address}`, (v): v is Array<{ txid: string; vout: number; value: string; height?: number }> =>
      Array.isArray(v) && v.every((u) => isRecord(u) && typeof u.txid === 'string' && isInt(u.vout) && isIntString(u.value)))
    return data.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), height: u.height && u.height > 0 ? u.height : -1 }))
  }

  private static isTx(v: unknown): v is BlockbookTxDetails {
    return isRecord(v) && typeof v.txid === 'string' && isInt(v.blockHeight) && isInt(v.confirmations)
  }

  async getTransactionDetails(txid: string): Promise<BlockbookTxDetails | undefined> {
    try { return await this.get(`/v2/tx/${txid}`, ZcashBlockbookClient.isTx) } catch (e) {
      if (e instanceof NetworkError && /\b(400|404)\b/.test(e.message)) return undefined
      throw e
    }
  }

  async getTransaction(txid: string): Promise<string> {
    const tx = await this.get(`/v2/tx/${txid}`, ZcashBlockbookClient.isTx)
    if (typeof tx.hex !== 'string' || !tx.hex) throw new NetworkError(`Transaction ${txid} has no hex data`, { provider: this.base })
    return tx.hex
  }

  async getOutput(txid: string, vout: number): Promise<SpentOutput | undefined> {
    const tx = await this.getTransactionDetails(txid)
    const o = tx?.vout?.find((x) => x.n === vout)
    if (!o || !isIntString(o.value) || typeof o.hex !== 'string') return undefined
    return { value: BigInt(o.value), script: hexToBytes(o.hex) }
  }

  async getTransactionInfo(txid: string): Promise<ZcashTxInfo | undefined> {
    const tx = await this.getTransactionDetails(txid)
    if (!tx) return undefined
    const info: ZcashTxInfo = { txid: tx.txid, blockHeight: tx.blockHeight > 0 ? tx.blockHeight : -1, confirmations: tx.confirmations }
    if (isIntString(tx.fees)) info.fee = BigInt(tx.fees)
    if (typeof tx.blockTime === 'number') info.blockTime = tx.blockTime
    return info
  }

  async broadcast(rawTx: string): Promise<string> {
    const data = await this.get(`/v2/sendtx/${rawTx}`, (v): v is { result?: string; error?: { message?: string } | string } => isRecord(v))
    if (data.error) throw new Error(`Broadcast rejected: ${typeof data.error === 'string' ? data.error : data.error.message ?? 'broadcast failed'}`)
    if (!data.result) throw new NetworkError('Blockbook returned no txid', { provider: this.base })
    return data.result
  }

  async getBlockHeight(): Promise<number> {
    const data = await this.get('/v2', (v): v is { blockbook?: { bestHeight?: number } } => isRecord(v))
    const h = data.blockbook?.bestHeight
    if (typeof h !== 'number' || h <= 0) throw new NetworkError('Blockbook did not report a block height', { provider: this.base })
    return h
  }
}
