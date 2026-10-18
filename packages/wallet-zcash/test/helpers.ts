import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WalletManagerZcash, parseTx, txid } from '../src/index.js'

export const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const TXID_A = '1'.repeat(64)
export const TXID_B = '2'.repeat(64)
export const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

const here = dirname(fileURLToPath(import.meta.url))

/** A mined mainnet v5 transparent transaction (Blockchair raw + dashboard), captured 2026-10-18. */
export interface Fixture {
  hash: string
  hex: string
  inputs: Array<{ value: number; recipient: string; script_hex: string; transaction_hash: string; index: number }>
  outputs: Array<{ value: number; recipient: string; script_hex: string }>
  fee: number
  block_id: number
}

export function fixture(hash: string): Fixture {
  const raw = JSON.parse(readFileSync(join(here, 'fixtures', `raw-${hash}.json`), 'utf8')) as { data: Record<string, { raw_transaction: string }> }
  const dash = JSON.parse(readFileSync(join(here, 'fixtures', `tx-${hash}.json`), 'utf8')) as { data: Record<string, Fixture & { transaction: { fee: number; block_id: number } }> }
  const d = dash.data[hash]!
  return { hash, hex: raw.data[hash]!.raw_transaction, inputs: d.inputs, outputs: d.outputs, fee: d.transaction.fee, block_id: d.transaction.block_id }
}

export const FIXTURES = ['7376c5f1aac539eb420587007c83d864d3668a3cef7f180f21960aaaa48c37cb', 'e14270e291acd8301ff627f655e751508cacf19c95892d1a2410809cd0b33900']

export interface FakeBlockchairOptions {
  utxos?: Array<{ block_id: number; transaction_hash: string; index: number; value: number }>
  tip?: number
  /** Known transactions for raw / dashboard lookups (txid → {hex, outputs}). */
  txs?: Record<string, { hex?: string; outputs: Array<{ value: number; script_hex: string; recipient?: string }>; block_id?: number; fee?: number }>
  fail?: boolean
  /** Reject broadcasts with this error text. */
  rejectPush?: string
  override?: (path: string, init?: RequestInit) => unknown
}

/** Fake Blockchair: routes by URL path, records broadcasts. */
export function fakeBlockchair(opts: FakeBlockchairOptions = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const tip = opts.tip ?? 3_521_980
  const utxos = opts.utxos ?? [
    { block_id: 3_500_000, transaction_hash: TXID_A, index: 0, value: 100_000_000 },
    { block_id: 3_500_001, transaction_hash: TXID_B, index: 1, value: 50_000_000 },
  ]
  const txs = opts.txs ?? {}
  const env = (data: unknown, extra: Record<string, unknown> = {}, code = 200) =>
    new Response(JSON.stringify({ data, context: { code, state: tip, ...extra } }), { status: code === 200 ? 200 : code, headers: { 'content-type': 'application/json' } })
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+\/zcash\//, '')
    calls.push(path)
    if (opts.fail) throw new Error('connection refused')
    const o = opts.override?.(path, init)
    if (o !== undefined) return env(o)
    if (path.startsWith('stats')) return env({ best_block_height: tip })
    if (path.startsWith('dashboards/address/')) {
      const addr = path.slice('dashboards/address/'.length).split('?')[0]!
      const confirmed = utxos.filter((u) => u.block_id > 0).reduce((s, u) => s + u.value, 0)
      return env({ [addr]: { address: { balance: confirmed, unspent_output_count: utxos.length, transaction_count: Object.keys(txs).length }, utxo: utxos, transactions: Object.keys(txs) } })
    }
    if (path.startsWith('raw/transaction/')) {
      const id = path.slice('raw/transaction/'.length)
      const t = txs[id]
      return t?.hex ? env({ [id]: { raw_transaction: t.hex } }) : env(null, { error: 'not found' }, 404)
    }
    if (path.startsWith('dashboards/transaction/') || path.startsWith('dashboards/transactions/')) {
      const ids = path.replace(/^dashboards\/transactions?\//, '').split('?')[0]!.split(',')
      const data: Record<string, unknown> = {}
      for (const id of ids) {
        const t = txs[id]
        data[id] = t ? { transaction: { block_id: t.block_id ?? tip - 2, hash: id, time: '2026-10-18 10:00:00', fee: t.fee ?? 10_000 }, inputs: [], outputs: t.outputs.map((x, i) => ({ index: i, ...x })) } : null
      }
      if (ids.length === 1 && data[ids[0]!] === null) return env(null, { error: 'not found' }, 404)
      return env(data)
    }
    if (path.startsWith('push/transaction')) {
      const body = String(init?.body ?? '')
      const hexTx = decodeURIComponent(body.replace(/^data=/, ''))
      if (opts.rejectPush) return env(null, { error: opts.rejectPush }, 400)
      sent.push(hexTx)
      return env({ transaction_hash: txid(parseTx(hexTx)) })
    }
    return env(null, { error: `unmocked ${path}` }, 500)
  }) as typeof fetch
  return { fetchFn, sent, calls, utxos, tip }
}

export const mk = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
  new WalletManagerZcash(SEED, { network: 'mainnet', client: { type: 'blockchair' }, fetch: fetchFn, ...extra })
