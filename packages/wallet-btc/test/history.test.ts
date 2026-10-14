import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HistoryUnavailableError, btcExplorerTxUrl, createBtcHistory, decodeHistoryCursor, encodeHistoryCursor, mapBlockbookTx,
  type BlockbookAddressPage, type BlockbookTxDetails,
} from '../src/index.js'

const ADDRESS = 'bc1q3x8yszvcvjjxqragsh0l6j8rxnhk7pay9hnj5h'
const fx = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/history/${name}.json`, import.meta.url), 'utf8')) as T
const PAGE = fx<BlockbookAddressPage & { transactions: BlockbookTxDetails[] }>('blockbook-address-page1')
const TX = fx<BlockbookTxDetails>('blockbook-tx')

interface FakeOptions {
  /** URL host → failure mode. */
  fail?: Record<string, number | 'network' | 'cloudflare'>
  /** Extra transactions prepended to the Blockbook list (e.g. a mempool one). */
  extra?: BlockbookTxDetails[]
}

function fakeBlockbook(opts: FakeOptions = {}) {
  const calls: string[] = []
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const u = new URL(url)
    const fail = opts.fail?.[u.host]
    if (fail === 'network') throw new TypeError('fetch failed')
    if (fail === 'cloudflare') return new Response('<!DOCTYPE html><title>Attention Required! | Cloudflare</title>', { status: 403, headers: { 'content-type': 'text/html' } })
    if (typeof fail === 'number') return new Response(JSON.stringify({ error: 'down' }), { status: fail, headers: { 'content-type': 'application/json' } })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const all = [...(opts.extra ?? []), ...PAGE.transactions]
    let m = /^\/api\/v2\/address\/([^/?]+)$/.exec(u.pathname)
    if (m) {
      if (m[1] !== ADDRESS) return json({ error: 'Address not found' }, 400)
      const pageSize = Number(u.searchParams.get('pageSize') ?? 1000)
      const totalPages = Math.max(1, Math.ceil(all.length / pageSize))
      const page = Math.min(Math.max(1, Number(u.searchParams.get('page') ?? 1)), totalPages) // Blockbook clamps out-of-range pages
      const slice = all.slice((page - 1) * pageSize, page * pageSize)
      return json({ ...PAGE, page, totalPages, itemsOnPage: pageSize, txs: all.length, transactions: u.searchParams.get('details') === 'txs' ? slice : undefined })
    }
    m = /^\/api\/v2\/tx\/([^/]+)$/.exec(u.pathname)
    if (m) {
      const tx = all.find((t) => t.txid === m![1])
      return tx ? json({ ...tx, hex: '00' }) : json({ error: 'Transaction not found' }, 404)
    }
    return json({ error: `unmocked ${u.pathname}` }, 500)
  }) as typeof fetch
  return { fetchFn, calls }
}

const src = (opts: FakeOptions = {}, extra: Record<string, unknown> = {}) => {
  const f = fakeBlockbook(opts)
  return { ...f, source: createBtcHistory({ blockbookUrl: 'https://bb1.example', fetch: f.fetchFn, ...extra }) }
}

describe('createBtcHistory: mapping', () => {
  it('a send: amount = what left to non-own outputs, change ignored, fee separate, `to` = first foreign output', async () => {
    const { source } = src()
    const page = await source.listActivity(ADDRESS, { limit: 10 })
    expect(source.chain).toBe('bip122:000000000019d6689c085ae165831e93')
    const send = page.items.find((i) => i.hash.startsWith('772b5d953e5d'))!
    expect(send.from).toBe(ADDRESS)
    expect(send.to).toBe('bc1q2tnjgexneytterwu56l9d8m4eu3p7wdth42p7d')
    expect(send.nativeValue).toBe(13_100n)
    expect(send.transfers).toEqual([{ token: null, from: ADDRESS, to: 'bc1q2tnjgexneytterwu56l9d8m4eu3p7wdth42p7d', amount: 13_100n }])
    expect(send.fee).toBe(418n)
    expect(send.status).toBe('confirmed')
    expect(send.block).toBe(970_675n)
    expect(send.time).toBe(1_791_576_861)
    expect(send.raw.ownIn).toBe(13_944n)
    expect(send.raw.ownOut).toBe(426n)
    expect((send.raw.tx as { hex?: string }).hex, 'raw hex is dropped').toBeUndefined()
    const send2 = page.items.find((i) => i.hash.startsWith('dbf0d04e552d'))!
    expect(send2.nativeValue).toBe(10_000n)
    expect(send2.to).toBe('bc1q9z4fvnlfakah5n5ekdlr3wr0culqaaskenqmw0')
    expect(send2.fee).toBe(141n)
  })

  it('a receive: from = first input address, amount = what landed on the address', async () => {
    const { source } = src()
    const page = await source.listActivity(ADDRESS, { limit: 10 })
    const recv = page.items.find((i) => i.hash.startsWith('b5ff221a244e'))!
    expect(recv.from).toBe('bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk')
    expect(recv.to).toBe(ADDRESS)
    expect(recv.nativeValue).toBe(9_921n)
    expect(recv.transfers).toEqual([{ token: null, from: 'bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk', to: ADDRESS, amount: 9_921n }])
    expect(recv.fee).toBe(909n)
    const recv2 = page.items.find((i) => i.hash.startsWith('d67a965da474'))!
    expect(recv2.nativeValue).toBe(14_164n)
    expect(recv2.from).toBe('bc1qw0t6ccur3jpqjr2rwwzt8lgunp3max40hrwm7m')
    // page order: newest block first
    expect(page.items.map((i) => Number(i.block))).toEqual([970_675, 970_672, 970_666, 970_378])
  })

  it('consolidation (every output ours) and coinbase / mempool edge cases', () => {
    const chain = 'bip122:000000000019d6689c085ae165831e93'
    const consolidation = mapBlockbookTx(chain, ADDRESS, {
      txid: 'c'.repeat(64), blockHeight: 1, confirmations: 2, blockTime: 1, fees: '100',
      vin: [{ addresses: [ADDRESS], isAddress: true, value: '5000' }, { addresses: [ADDRESS], isAddress: true, value: '5000' }],
      vout: [{ n: 0, addresses: [ADDRESS], isAddress: true, value: '9900' }],
    })
    expect(consolidation.from).toBe(ADDRESS)
    expect(consolidation.to).toBe(ADDRESS)
    expect(consolidation.nativeValue).toBe(9_900n)
    expect(consolidation.transfers).toEqual([{ token: null, from: ADDRESS, to: ADDRESS, amount: 9_900n }])
    const coinbase = mapBlockbookTx(chain, ADDRESS, { txid: 'd'.repeat(64), blockHeight: 2, confirmations: 1, vin: [{ isAddress: false, value: '0' }], vout: [{ n: 0, addresses: [ADDRESS], isAddress: true, value: '625000000' }] })
    expect(coinbase.from).toBe('coinbase')
    expect(coinbase.nativeValue).toBe(625_000_000n)
    const mempool = mapBlockbookTx(chain, ADDRESS, { ...TX, blockHeight: -1, confirmations: 0 })
    expect(mempool.status).toBe('pending')
    expect(mempool.block).toBeUndefined()
  })
})

describe('createBtcHistory: pages and cursor', () => {
  it('pages by Blockbook page number with a fixed page size and stops at totalPages', async () => {
    const { source, calls } = src()
    const p1 = await source.listActivity(ADDRESS, { limit: 2 })
    expect(calls[0]).toContain(`/api/v2/address/${ADDRESS}?details=txs&page=1&pageSize=2`)
    expect(p1.items).toHaveLength(2)
    expect(p1.page).toBe(1)
    expect(p1.totalPages).toBe(2)
    expect(decodeHistoryCursor(p1.cursor!)).toEqual({ v: 1, p: 2, s: 2 })
    const p2 = await source.listActivity(ADDRESS, { limit: 50, cursor: p1.cursor! })
    expect(calls[1]).toContain('page=2&pageSize=2') // the cursor's page size wins over a changed limit
    expect(p2.items).toHaveLength(2)
    expect(p2.cursor).toBeUndefined()
    expect(new Set([...p1.items, ...p2.items].map((i) => i.hash)).size).toBe(4)
  })

  it('`since` trims and ends pagination; pending transactions are kept regardless', async () => {
    const pending = { ...TX, txid: 'e'.repeat(64), blockHeight: -1, confirmations: 0, blockTime: 1_791_600_000 }
    const { source } = src({ extra: [pending] })
    const page = await source.listActivity(ADDRESS, { limit: 2, since: 1_791_576_900 })
    expect(page.items.map((i) => i.status)).toEqual(['pending'])
    expect(page.cursor, 'a confirmed row older than `since` was on this page: nothing newer is left below').toBeUndefined()
    const open = await source.listActivity(ADDRESS, { limit: 2, since: 1_791_570_000 })
    expect(open.items.map((i) => i.status)).toEqual(['pending', 'confirmed'])
    expect(open.cursor, 'every row on the page is newer than `since`: the next page may still hold more').toBeDefined()
  })

  it('cursor round-trips and rejects garbage', () => {
    expect(decodeHistoryCursor(encodeHistoryCursor({ v: 1, p: 3, s: 25 }))).toEqual({ v: 1, p: 3, s: 25 })
    expect(() => decodeHistoryCursor('nope')).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 1, p: 0, s: 1 }))).toThrow(/malformed history cursor/)
  })
})

describe('createBtcHistory: failover, getTransaction, explorer', () => {
  it('fails over across Blockbook instances (Cloudflare 403, 5xx, network) and names every attempt when all fail', async () => {
    const f = fakeBlockbook({ fail: { 'btc1.trezor.io': 'cloudflare', 'bb2.example': 'network' } })
    const ok = createBtcHistory({ blockbookUrls: ['https://btc1.trezor.io', 'https://bb2.example', 'https://bb3.example'], fetch: f.fetchFn })
    const page = await ok.listActivity(ADDRESS, { limit: 10 })
    expect(page.items).toHaveLength(4)
    expect(f.calls.filter((c) => c.includes('bb3.example'))).toHaveLength(1)

    const bad = createBtcHistory({ blockbookUrls: ['https://btc1.trezor.io', 'https://bb2.example'], fetch: f.fetchFn })
    const err = await bad.listActivity(ADDRESS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HistoryUnavailableError)
    const e = err as HistoryUnavailableError
    expect(e.chain).toBe('bip122:000000000019d6689c085ae165831e93')
    expect(e.attempts).toEqual([expect.stringMatching(/^https:\/\/btc1\.trezor\.io: .*403/), expect.stringMatching(/^https:\/\/bb2\.example: /)])
  })

  it('getTransaction maps /api/v2/tx and returns undefined for unknown ids', async () => {
    const { source } = src()
    const tx = (await source.getTransaction(TX.txid, ADDRESS))!
    expect(tx.hash).toBe(TX.txid)
    expect(tx.nativeValue).toBe(13_100n)
    expect(tx.fee).toBe(418n)
    expect(await source.getTransaction('f'.repeat(64), ADDRESS)).toBeUndefined()
  })

  it('needs a Blockbook URL; explorer URLs', () => {
    expect(() => createBtcHistory({ fetch: fakeBlockbook().fetchFn })).toThrow(/blockbookUrl/)
    expect(btcExplorerTxUrl('abc')).toBe('https://mempool.space/tx/abc')
    const t = createBtcHistory({ blockbookUrl: 'https://x', fetch: fakeBlockbook().fetchFn, network: 'testnet' })
    expect(t.chain).toBe('bip122:000000000933ea01ad0ee984209779ba')
    expect(t.explorerTxUrl('abc')).toBe('https://mempool.space/testnet/tx/abc')
  })
})
