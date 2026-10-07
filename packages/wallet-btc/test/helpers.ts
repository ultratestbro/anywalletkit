import { Transaction } from '@scure/btc-signer'
import { WalletManagerBtc, parseRawTransaction } from '../src/index.js'

export const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
export const ADDR0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' // BIP-84 test vector, account 0
export const ADDR1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' // account 1
export const TXID_A = '1'.repeat(64)
export const TXID_B = '2'.repeat(64)
export const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/** An unsigned "previous" transaction paying `outputs`, so raw-hex paths can look prevouts up. */
export function prevTx(outputs: Array<[string, bigint]>): Transaction {
  const tx = new Transaction()
  tx.addInput({ txid: '00'.repeat(32), index: 0 })
  for (const [addr, amount] of outputs) tx.addOutputAddress(addr, amount)
  return tx
}

export interface FakeBlockbookOptions {
  utxos?: Array<{ txid: string; vout: number; value: string; height: number }>
  feeBtcPerKb?: string
  txInfo?: Record<string, unknown> | null
  fail?: boolean
  prevTxs?: Transaction[]
  /** Return a JSON body to override any path (undefined → default routing). */
  override?: (path: string) => unknown
}

/** Fake Blockbook: routes by URL path, records broadcasts. Fee estimate = 10 sat/vB, tip = 850000. */
export function fakeBlockbook(opts: FakeBlockbookOptions = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const utxos = opts.utxos ?? [
    { txid: TXID_A, vout: 0, value: '100000', height: 800000 },
    { txid: TXID_B, vout: 1, value: '50000', height: 800001 },
  ]
  const prev = new Map((opts.prevTxs ?? []).map((t) => [t.id, t]))
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    calls.push(path)
    if (opts.fail) throw new Error('connection refused')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const o = opts.override?.(path)
    if (o !== undefined) return json(o)
    if (path.startsWith('/api/v2/utxo/')) return json(utxos)
    if (path.startsWith('/api/v1/estimatefee/')) return json({ result: opts.feeBtcPerKb ?? '0.00010000' }) // 10 sat/vB
    if (path.startsWith('/api/v2/address/')) return json({ balance: '150000', unconfirmedBalance: '0', transactions: [] })
    if (path.startsWith('/api/v2/sendtx/')) { sent.push(path.slice('/api/v2/sendtx/'.length)); return json({ result: parseRawTransaction(sent.at(-1)!).id }) }
    if (path.startsWith('/api/v2/tx/')) {
      const id = path.slice('/api/v2/tx/'.length)
      const p = prev.get(id)
      if (p) return json({ txid: id, blockHeight: 1, confirmations: 9, hex: p.hex })
      return opts.txInfo === null ? json({ error: 'not found' }, 404) : json(opts.txInfo ?? { txid: id, blockHeight: 800010, confirmations: 3, fees: '1410', hex: '00' })
    }
    if (path === '/api/v2') return json({ blockbook: { bestHeight: 850000 } })
    return json({ error: `unmocked ${path}` }, 500)
  }) as typeof fetch
  return { fetchFn, sent, calls, utxos }
}

export const mk = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
  new WalletManagerBtc(SEED, { network: 'bitcoin', client: { type: 'blockbook-http', clientConfig: { url: 'https://bb.example' } }, fetch: fetchFn, ...extra })
