/**
 * Blockchair REST transport (`https://api.blockchair.com/zcash`): public, CORS
 * open, no key needed at wallet volumes (one request every couple of seconds;
 * a `key` lifts the quota). Mainnet only — Blockchair indexes no Zcash
 * testnet. Address dashboards carry the UTXO set (mempool included, block_id
 * -1), `raw/transaction` the hex, `push/transaction` broadcasts.
 */
import { NetworkError } from '@anywalletkit/core'
import { hexToBytes } from './encoding.js'
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, isInt, isRecord, refusal, refusedStatus } from './http.js'
import type { SpentOutput, Utxo, ZcashClient, ZcashTxInfo } from './types.js'

/** Default Blockchair API root for Zcash. */
export const BLOCKCHAIR_URL = 'https://api.blockchair.com/zcash'
/** Blockchair caps the `utxo` list of an address dashboard at this many rows. */
const UTXO_LIMIT = 1000

interface BlockchairUtxo { block_id: number; transaction_hash: string; index: number; value: number }
interface BlockchairAddress { balance: number; unspent_output_count?: number; transaction_count?: number }
export interface BlockchairTxRow { block_id: number; hash: string; time?: string; fee?: number; input_count?: number; output_count?: number }
export interface BlockchairOutput { index: number; value: number; script_hex: string; recipient?: string }
export interface BlockchairInput extends BlockchairOutput { transaction_hash: string; spending_index?: number; spending_sequence?: number }
export interface BlockchairTxDashboard { transaction: BlockchairTxRow; inputs: BlockchairInput[]; outputs: BlockchairOutput[] }
interface Envelope<T> { data: T; context: { code: number; state?: number; error?: string } }

const isUtxo = (v: unknown): v is BlockchairUtxo => isRecord(v) && isInt(v.block_id) && typeof v.transaction_hash === 'string' && isInt(v.index) && typeof v.value === 'number'
const isOutput = (v: unknown): v is BlockchairOutput => isRecord(v) && isInt(v.index) && typeof v.value === 'number' && typeof v.script_hex === 'string'
const isDashboard = (v: unknown): v is BlockchairTxDashboard =>
  isRecord(v) && isRecord(v.transaction) && isInt(v.transaction.block_id) && typeof v.transaction.hash === 'string' && Array.isArray(v.inputs) && v.inputs.every(isOutput) && Array.isArray(v.outputs) && v.outputs.every(isOutput)

/** "2026-10-18 10:05:14" (UTC) → unix seconds. */
export function blockchairTime(s: string | undefined): number | undefined {
  if (!s) return undefined
  const t = Date.parse(`${s.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

export class BlockchairClient implements ZcashClient {
  private readonly base: string
  private readonly key: string | undefined
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number

  constructor(config: { url?: string; key?: string } = {}, fetchFn: typeof fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.base = (config.url ?? BLOCKCHAIR_URL).replace(/\/+$/, '')
    this.key = config.key
    this.fetchFn = fetchFn
    this.timeoutMs = timeoutMs
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  private url(path: string, query: Record<string, string> = {}): string {
    const q = new URLSearchParams(query)
    if (this.key) q.set('key', this.key)
    const s = q.toString()
    return `${this.base}/${path}${s ? `?${s}` : ''}`
  }

  private async request<T>(path: string, query: Record<string, string>, init: RequestInit | undefined, check: (v: unknown) => v is T): Promise<{ data: T; state: number | undefined }> {
    const url = this.url(path, query)
    const res = await fetchWithTimeout(this.fetchFn, url, init, this.timeoutMs, this.base)
    let body: unknown
    try { body = await res.json() } catch (e) {
      if (res.status === 402 || res.status === 429 || res.status === 430) throw new NetworkError(`Blockchair rate limit (${res.status})`, { provider: this.base })
      throw new NetworkError(`Blockchair returned non-JSON (${res.status}) for ${url}`, { provider: this.base, cause: e })
    }
    const env = body as Partial<Envelope<unknown>>
    const code = env.context?.code ?? res.status
    if (code === 402 || code === 429 || code === 430) throw new NetworkError(`Blockchair rate limit (${code})`, { provider: this.base })
    if (code === 404) throw new NotFound()
    if (code !== 200 || !res.ok) throw new NetworkError(`Blockchair request failed: ${code} ${env.context?.error ?? res.statusText} (${url})`, { provider: this.base })
    if (!check(env.data)) throw new NetworkError(`Blockchair returned an unexpected shape for ${url}`, { provider: this.base })
    return { data: env.data, state: env.context?.state }
  }

  private async dashboard(address: string): Promise<{ address: BlockchairAddress; utxo: BlockchairUtxo[]; transactions: string[]; state: number | undefined }> {
    const { data, state } = await this.request(`dashboards/address/${address}`, { limit: `0,${UTXO_LIMIT}` }, undefined, (v): v is Record<string, { address: BlockchairAddress; utxo: BlockchairUtxo[]; transactions?: string[] }> =>
      isRecord(v) && Object.values(v).every((a) => isRecord(a) && isRecord(a.address) && typeof a.address.balance === 'number' && Array.isArray(a.utxo) && a.utxo.every(isUtxo)))
    const entry = data[address] ?? Object.values(data)[0]
    if (!entry) throw new NetworkError(`Blockchair knows no address ${address}`, { provider: this.base })
    return { address: entry.address, utxo: entry.utxo, transactions: entry.transactions ?? [], state }
  }

  /** Transaction hashes of an address, newest first, paged by offset (what the activity history walks). */
  async listTransactions(address: string, limit: number, offset: number): Promise<{ hashes: string[]; total: number | undefined }> {
    const { data } = await this.request(`dashboards/address/${address}`, { limit: `${limit},0`, offset: `${offset},0` }, undefined, (v): v is Record<string, { address: BlockchairAddress; transactions?: string[] }> =>
      isRecord(v) && Object.values(v).every((a) => isRecord(a) && isRecord(a.address) && (a.transactions === undefined || Array.isArray(a.transactions))))
    const entry = data[address] ?? Object.values(data)[0]
    if (!entry) throw new NetworkError(`Blockchair knows no address ${address}`, { provider: this.base })
    return { hashes: (entry.transactions ?? []).filter((h): h is string => typeof h === 'string'), total: entry.address.transaction_count }
  }

  /** Confirmed = the UTXOs mined so far; unconfirmed = incoming mempool outputs. (Beyond 1000 UTXOs the dashboard balance is used.) */
  async getBalance(address: string): Promise<{ confirmed: bigint; unconfirmed: bigint }> {
    const d = await this.dashboard(address)
    let confirmed = 0n, unconfirmed = 0n
    for (const u of d.utxo) { if (u.block_id > 0) confirmed += BigInt(u.value); else unconfirmed += BigInt(u.value) }
    if ((d.address.unspent_output_count ?? d.utxo.length) > d.utxo.length) confirmed = BigInt(d.address.balance) - unconfirmed
    return { confirmed, unconfirmed }
  }

  async listUnspent(address: string): Promise<Utxo[]> {
    const d = await this.dashboard(address)
    return d.utxo.map((u) => ({ txid: u.transaction_hash, vout: u.index, value: BigInt(u.value), height: u.block_id > 0 ? u.block_id : -1 }))
  }

  async getTransaction(txid: string): Promise<string> {
    const { data } = await this.request(`raw/transaction/${txid}`, {}, undefined, (v): v is Record<string, { raw_transaction: string }> =>
      isRecord(v) && Object.values(v).every((t) => isRecord(t) && typeof t.raw_transaction === 'string'))
    const hex = (data[txid] ?? Object.values(data)[0])?.raw_transaction
    if (!hex) throw new NetworkError(`Transaction ${txid} has no raw data`, { provider: this.base })
    return hex
  }

  /** Inputs / outputs with addresses, values and scripts — what the activity history and prevout lookups read. */
  async getTransactionDashboard(txid: string): Promise<BlockchairTxDashboard | undefined> {
    try {
      const { data, state } = await this.request(`dashboards/transaction/${txid}`, {}, undefined, (v): v is Record<string, BlockchairTxDashboard | null> =>
        isRecord(v) && Object.values(v).every((t) => t === null || isDashboard(t)))
      const t = data[txid] ?? Object.values(data)[0]
      if (!t) return undefined
      return { ...t, transaction: { ...t.transaction, ...(state !== undefined ? { confirmations: t.transaction.block_id > 0 ? state - t.transaction.block_id + 1 : 0 } : {}) } } as BlockchairTxDashboard
    } catch (e) {
      if (e instanceof NotFound) return undefined
      throw e
    }
  }

  /** Several transactions in one call (Blockchair takes up to 10 comma-separated hashes). */
  async getTransactionDashboards(txids: string[]): Promise<Map<string, BlockchairTxDashboard>> {
    const out = new Map<string, BlockchairTxDashboard>()
    for (let i = 0; i < txids.length; i += 10) {
      const slice = txids.slice(i, i + 10)
      const { data, state } = await this.request(`dashboards/transactions/${slice.join(',')}`, {}, undefined, (v): v is Record<string, BlockchairTxDashboard | null> =>
        isRecord(v) && Object.values(v).every((t) => t === null || isDashboard(t)))
      for (const [hash, t] of Object.entries(data)) {
        if (!t) continue
        const confirmations = state !== undefined && t.transaction.block_id > 0 ? state - t.transaction.block_id + 1 : 0
        out.set(hash, { ...t, transaction: { ...t.transaction, confirmations } } as BlockchairTxDashboard)
      }
    }
    return out
  }

  async getOutput(txid: string, vout: number): Promise<SpentOutput | undefined> {
    const d = await this.getTransactionDashboard(txid)
    const o = d?.outputs.find((x) => x.index === vout)
    return o ? { value: BigInt(o.value), script: hexToBytes(o.script_hex) } : undefined
  }

  async getTransactionInfo(txid: string): Promise<ZcashTxInfo | undefined> {
    const d = await this.getTransactionDashboard(txid)
    if (!d) return undefined
    const t = d.transaction as BlockchairTxRow & { confirmations?: number }
    const info: ZcashTxInfo = { txid: t.hash, blockHeight: t.block_id > 0 ? t.block_id : -1, confirmations: t.confirmations ?? 0 }
    if (typeof t.fee === 'number') info.fee = BigInt(t.fee)
    const time = blockchairTime(t.time)
    if (time !== undefined) info.blockTime = time
    return info
  }

  async broadcast(rawTx: string): Promise<string> {
    const body = `data=${encodeURIComponent(rawTx)}`
    const url = this.url('push/transaction')
    const res = await fetchWithTimeout(this.fetchFn, url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, this.timeoutMs, this.base)
    let env: Partial<Envelope<{ transaction_hash?: string } | null>> = {}
    let parsed = false
    try { env = (await res.json()) as typeof env; parsed = true } catch { /* handled below */ }
    const hash = env.data?.transaction_hash
    if (hash) return hash
    const reason = env.context?.error
    // The node's verdict — an error it gave, with a 4xx (not 408) or a 200 — is a refusal: nothing was
    // taken. A proxy's HTML 502, a 5xx, a timeout or an unreadable body may have been (round 3, M12).
    if (parsed && reason && (res.ok || refusedStatus(res.status))) throw refusal(new Error(`Broadcast rejected: ${reason}`))
    throw new NetworkError(`Blockchair broadcast: no answer to rely on (${res.status} ${res.statusText})`, { provider: this.base })
  }

  async getBlockHeight(): Promise<number> {
    const { data } = await this.request('stats', {}, undefined, (v): v is { best_block_height: number } => isRecord(v) && isInt(v.best_block_height))
    if (data.best_block_height <= 0) throw new NetworkError('Blockchair reported no block height', { provider: this.base })
    return data.best_block_height
  }
}

class NotFound extends Error { constructor() { super('not found'); this.name = 'NotFound' } }
