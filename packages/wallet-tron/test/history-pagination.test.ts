import { describe, expect, it } from 'vitest'
import { createTronHistory, type HistoryFetch, type TronGridTrc20, type TronGridTx } from '../src/index.js'

// Audit 2026-10-25, #1.5: pages were time windows (`max_timestamp`) plus the txIDs already
// emitted at the window edge. More rows at one timestamp than `limit` made the next request
// return the same rows again — all skipped — and the listing ended early: rows were lost.
const ME = 'TVSz6xJL2M53HDZyFTeDcGCmEDdwmU4zbv'
const PEER = 'TCanhfMgr9RsFRoxkJ8YkJD8Faha85a14p'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const id = (s: string) => s.padEnd(64, '0')

const txRow = (txID: string, ts: number): TronGridTx => ({
  txID: id(txID), block_timestamp: ts, blockNumber: ts, ret: [{ contractRet: 'SUCCESS', fee: 0 }],
  raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: ME, to_address: PEER, amount: 1 } } }] },
})
const trcRow = (txID: string, ts: number, value = '1'): TronGridTrc20 => ({
  transaction_id: id(txID), block_timestamp: ts, from: PEER, to: ME, type: 'Transfer', value, token_info: { address: USDT, symbol: 'USDT', decimals: 6 },
})

/**
 * TronGrid's two account lists: newest first, `limit` per page, `meta.fingerprint` to continue
 * (opaque: here the offset), `min_timestamp` / `max_timestamp` inclusive. Within one timestamp
 * the two lists order rows differently, as two indexes may.
 */
function api(tx: TronGridTx[], trc20: TronGridTrc20[]) {
  let requests = 0
  const page = <T>(rows: T[], ts: (r: T) => number, u: URL) => {
    const limit = Number(u.searchParams.get('limit') ?? 20)
    const max = u.searchParams.get('max_timestamp'), min = u.searchParams.get('min_timestamp')
    const fp = u.searchParams.get('fingerprint')
    const all = rows.filter((r) => (max === null || ts(r) <= Number(max)) && (min === null || ts(r) >= Number(min)))
    const from = fp ? Number(Buffer.from(fp, 'base64').toString()) : 0
    const data = all.slice(from, from + limit)
    const next = from + limit < all.length ? Buffer.from(String(from + limit)).toString('base64') : undefined
    return { data, success: true, meta: { at: 1, page_size: data.length, ...(next ? { fingerprint: next } : {}) } }
  }
  const fetch: HistoryFetch = async (url) => {
    requests++
    const u = new URL(url)
    const body = u.pathname.endsWith('/trc20') ? page(trc20, (r) => r.block_timestamp, u) : page(tx, (r) => r.block_timestamp ?? 0, u)
    return { ok: true, status: 200, json: async () => body }
  }
  return { fetch, requests: () => requests }
}

async function walk(tx: TronGridTx[], trc20: TronGridTrc20[], limit: number) {
  const a = api(tx, trc20)
  const source = createTronHistory({ fetch: a.fetch, rateLimit: 1e6 })
  const items = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await source.listActivity(ME, { limit, ...(cursor ? { cursor } : {}) })
    expect(page.items.length).toBeLessThanOrEqual(limit)
    items.push(...page.items)
    cursor = page.cursor
  } while (cursor && ++pages < 500)
  expect(cursor, 'the listing ends').toBeUndefined()
  return items
}

const byTsDesc = <T>(rows: T[], ts: (r: T) => number) => [...rows].sort((a, b) => ts(b) - ts(a))

describe('Tron history pages: nothing lost or repeated', () => {
  // 7 transactions in one block (ts 3000), two of them also on the TRC-20 list, two TRC-20-only rows
  // in that block (one with two Transfer legs), then older rows on both lists.
  const tx = byTsDesc([
    ...['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((t) => txRow(t, 3000)),
    txRow('b1', 2000), txRow('b2', 2000), txRow('c1', 1000),
  ], (r) => r.block_timestamp!)
  const trc20 = byTsDesc([
    trcRow('u2', 3000, '5'), trcRow('a6', 3000), trcRow('u1', 3000), trcRow('u2', 3000, '6'), trcRow('a2', 3000),
    trcRow('d1', 2500), trcRow('e1', 500), trcRow('e2', 500),
  ], (r) => r.block_timestamp)
  const expected = new Set([...tx.map((r) => r.txID), ...trc20.map((r) => r.transaction_id)])

  for (const limit of [1, 2, 3, 4, 7, 50]) {
    it(`limit ${limit}: every transaction exactly once, newest first, legs merged`, async () => {
      const items = await walk(tx, trc20, limit)
      expect(items.map((i) => i.hash).filter((h, i, all) => all.indexOf(h) !== i), 'duplicates').toEqual([])
      expect(new Set(items.map((i) => i.hash))).toEqual(expected)
      for (let i = 1; i < items.length; i++) expect(items[i - 1]!.time).toBeGreaterThanOrEqual(items[i]!.time)
      // a transaction on both lists is one item with its TRC-20 leg; one with two legs keeps both
      expect(items.find((i) => i.hash === id('a2'))!.transfers.filter((t) => t.token === USDT)).toHaveLength(1)
      expect(items.find((i) => i.hash === id('u2'))!.transfers.map((t) => t.amount).sort()).toEqual([5n, 6n])
    })
  }

  it('more rows at one timestamp than the API page holds', async () => {
    const many = Array.from({ length: 450 }, (_, i) => txRow(`m${String(i).padStart(3, '0')}`, 9000))
    const items = await walk([...many, txRow('z', 10)], [], 200)
    expect(items).toHaveLength(451)
    expect(new Set(items.map((i) => i.hash)).size).toBe(451)
  })

  it('a page size change between calls (limit 50 then 20, 100 then 25) neither repeats nor skips', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => i)
    const tx2 = rows.filter((i) => i % 2 === 0).map((i) => txRow(`p${String(i).padStart(3, '0')}`, 100_000 - i))
    const trc2 = rows.filter((i) => i % 2 === 1).map((i) => trcRow(`p${String(i).padStart(3, '0')}`, 100_000 - i))
    for (const [first, rest] of [[50, 20], [100, 25], [20, 50]] as const) {
      const a = api(tx2, trc2)
      const source = createTronHistory({ fetch: a.fetch, rateLimit: 1e6 })
      const seen: string[] = []
      let page = await source.listActivity(ME, { limit: first })
      seen.push(...page.items.map((i) => i.hash))
      while (page.cursor) {
        page = await source.listActivity(ME, { limit: rest, cursor: page.cursor })
        seen.push(...page.items.map((i) => i.hash))
      }
      expect(seen.length, `${first} then ${rest}`).toBe(200)
      expect(new Set(seen).size, `${first} then ${rest}: duplicates`).toBe(200)
    }
  })

  it('an API that repeats its fingerprint (a proxy dropping the parameter) ends the list, never loops', async () => {
    let requests = 0
    const stuck = Array.from({ length: 30 }, (_, i) => txRow(`s${String(i).padStart(2, '0')}`, 5000))
    const fetch: HistoryFetch = async (url) => {
      if (++requests > 100) throw new Error('runaway pagination')
      const trc = new URL(url).pathname.endsWith('/trc20')
      // the same first page and the same fingerprint, whatever is asked
      const body = trc ? { data: [], success: true, meta: {} } : { data: stuck.slice(0, 20), success: true, meta: { fingerprint: 'c2FtZQ==' } }
      return { ok: true, status: 200, json: async () => body }
    }
    const page = await createTronHistory({ fetch, rateLimit: 1e6 }).listActivity(ME, { limit: 50 })
    expect(page.items).toHaveLength(20)
    expect(requests).toBeLessThan(10)
  })
})
