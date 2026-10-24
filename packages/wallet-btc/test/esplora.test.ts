import { describe, expect, it } from 'vitest'
import { NetworkError } from '@forgewallet/core'
import { EsploraClient, WalletManagerBtc, parseRawTransaction } from '../src/index.js'
import { ADDR0, ADDR1, PREV_A, PREV_B, SEED, TXID_A, TXID_B, fakeBlockbook, prevTx } from './helpers.js'

/** Fake Esplora (mempool.space / blockstream shapes). */
function fakeEsplora(opts: { fail?: boolean; tip?: number; utxos?: Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }> } = {}) {
  const sent: string[] = []
  const calls: string[] = []
  const tip = opts.tip ?? 850_000
  const prevA = prevTx([[ADDR0, 100_000n]])
  const utxos = opts.utxos ?? [
    { txid: TXID_A, vout: 0, value: 100_000, status: { confirmed: true, block_height: 800_000 } },
    { txid: TXID_B, vout: 1, value: 50_000, status: { confirmed: false } },
  ]
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (opts.fail) throw new Error('connection refused')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    const text = (body: string, status = 200) => new Response(body, { status })
    if (path === '/api/blocks/tip/height') return text(String(tip))
    if (path === '/api/fee-estimates') return json({ '1': 12.5, '2': 11, '3': 9.2, '6': 7, '25': 3, '144': 1.5 })
    if (path === `/api/address/${ADDR0}/utxo`) return json(utxos)
    if (path === `/api/address/${ADDR0}/txs`) return json([{ txid: TXID_A, status: { confirmed: true, block_height: 800_000 } }])
    if (path === `/api/address/${ADDR0}`) return json({ chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 20_000 }, mempool_stats: { funded_txo_sum: 5_000, spent_txo_sum: 30_000 } })
    if (path === `/api/tx/${prevA.id}/hex`) return text(prevA.hex)
    if (path === `/api/tx/${PREV_A.id}/hex`) return text(PREV_A.hex)
    if (path === `/api/tx/${PREV_B.id}/hex`) return text(PREV_B.hex)
    if (path === `/api/tx/${TXID_A}`) return json({ txid: TXID_A, status: { confirmed: true, block_height: 849_998 }, fee: 1410 })
    if (path === `/api/tx/${TXID_B}`) return json({ txid: TXID_B, status: { confirmed: false } })
    if (path.startsWith('/api/tx/') && path.endsWith('/hex')) return text('not found', 404)
    if (path.startsWith('/api/tx/')) return text('Transaction not found', 404)
    if (path === '/api/tx' && init?.method === 'POST') { sent.push(String(init.body)); return text(parseRawTransaction(String(init.body)).id) }
    return text(`unmocked ${path}`, 500)
  }) as typeof fetch
  return { fetchFn, sent, calls, prevA }
}

describe('EsploraClient', () => {
  it('maps balance, utxos, history, receipts, fees and the tip onto the BtcClient contract', async () => {
    const f = fakeEsplora()
    const c = new EsploraClient({ url: 'https://mempool.space/api' }, f.fetchFn)
    expect(await c.getBalance(ADDR0)).toEqual({ confirmed: 130_000n, unconfirmed: -25_000n, unconfirmedOutgoing: 25_000n })
    expect(await c.listUnspent(ADDR0)).toEqual([
      { txid: TXID_A, vout: 0, value: 100_000n, height: 800_000 },
      { txid: TXID_B, vout: 1, value: 50_000n, height: -1 },
    ])
    expect(await c.getHistory(ADDR0)).toEqual([{ txid: TXID_A, height: 800_000 }])
    expect(await c.getTransactionInfo(TXID_A)).toEqual({ txid: TXID_A, blockHeight: 849_998, confirmations: 3, fees: '1410' })
    expect(await c.getTransactionInfo(TXID_B)).toMatchObject({ blockHeight: -1, confirmations: 0 })
    expect(await c.getTransactionInfo('f'.repeat(64))).toBeUndefined()
    expect(await c.getTransaction(f.prevA.id)).toBe(f.prevA.hex)
    expect(await c.estimateFee(1)).toBe(12.5)
    expect(await c.estimateFee(4)).toBe(7) // nearest target ≥ 4
    expect(await c.estimateFee(1000)).toBe(1.5) // beyond the table → slowest
    expect(await c.getBlockHeight()).toBe(850_000)
  })

  it('accepts the host without /api and rejects malformed responses', async () => {
    const f = fakeEsplora()
    const c = new EsploraClient({ url: 'https://blockstream.info' }, f.fetchFn)
    expect(await c.getBlockHeight()).toBe(850_000)
    const bad = new EsploraClient({ url: 'https://x.example/api' }, (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as typeof fetch)
    await expect(bad.getBalance(ADDR0)).rejects.toBeInstanceOf(NetworkError)
    await expect(bad.getBalance(ADDR0)).rejects.toThrow(/unexpected shape/)
    const down = new EsploraClient({ url: 'https://x.example/api' }, fakeEsplora({ fail: true }).fetchFn)
    await expect(down.getBlockHeight()).rejects.toBeInstanceOf(NetworkError)
  })

  it('broadcasts a spend end-to-end through the esplora transport', async () => {
    const f = fakeEsplora({ utxos: [{ txid: TXID_A, vout: 0, value: 100_000, status: { confirmed: true, block_height: 800_000 } }] })
    const m = new WalletManagerBtc(SEED, { client: { type: 'esplora-http', clientConfig: { url: 'https://mempool.space/api' } }, fetch: f.fetchFn })
    const a = await m.getAccount(0)
    const res = await a.transfer({ recipient: ADDR1, amount: 60_000n })
    expect(f.sent).toHaveLength(1)
    const tx = parseRawTransaction(f.sent[0]!)
    expect(res.hash).toBe(tx.id)
    expect(tx.lockTime).toBe(850_000)
    expect(res.fee).toBe(BigInt(tx.vsize) * 13n) // 12.5 sat/vB rounded up
    expect(f.calls).toContain('POST /api/tx')
    m.dispose()
  })

  it('fails over from a dead Blockbook to a live Esplora, including optional methods', async () => {
    const dead = fakeBlockbook({ fail: true })
    const alive = fakeEsplora()
    const m = new WalletManagerBtc(SEED, { client: [
      { type: 'blockbook-http', clientConfig: { url: 'https://dead.example' } },
      { type: 'esplora-http', clientConfig: { url: 'https://mempool.space/api' } },
    ], fetch: (async (input: string | URL | Request, init?: RequestInit) => (String(input).includes('dead.example') ? dead.fetchFn(input, init) : alive.fetchFn(input, init))) as typeof fetch })
    const a = await m.getAccount(0)
    expect(await a.getBalance()).toBe(130_000n - 25_000n)
    expect(dead.calls).toHaveLength(1)
    const receipt = await a.getTransactionReceipt(TXID_A)
    expect(receipt?.blockNumber).toBe(849_998n)
    m.dispose()
  })
})
