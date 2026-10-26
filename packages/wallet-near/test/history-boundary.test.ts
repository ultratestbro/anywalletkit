import { describe, expect, it } from 'vitest'
import { createNearHistory, type HistoryFetch, type NearblocksReceiptRow } from '../src/index.js'

// Audit 2026-10-25 round 3, M13: a transaction has several receipt rows (the call and its refund).
// When a page ended between them, the transaction was emitted with its first rows and again on the
// next page with the rest — a duplicate in the feed. Rows of a transaction the page boundary cuts
// now move to the next page whole, and the cursor stays after the last fully emitted one.

const WALLET = 'fc647e203e0e099212485017b78a0e77dc330019d4b532a4d44408adc0bfd9a1'

/** Transactions with 1–3 receipt rows each, newest first; rows of a transaction are contiguous. */
function dataset(): NearblocksReceiptRow[] {
  const counts = [2, 1, 3, 2, 1, 3, 1, 7, 2, 2, 1, 3, 1] // tx7 has more rows than several pages
  const rows: NearblocksReceiptRow[] = []
  let id = 10_000
  counts.forEach((n, t) => {
    for (let k = 0; k < n; k++) {
      rows.push({
        id: String(id--), transaction_hash: `tx${t}`, receipt_kind: 'ACTION',
        predecessor_account_id: k === 0 ? WALLET : 'system', receiver_account_id: k === 0 ? 'bob.near' : WALLET,
        block_timestamp: String(1_800_000_000_000_000_000n - BigInt(t) * 1_000_000_000n),
        actions: [{ action: 'TRANSFER', method: null, deposit: 1_000_000, fee: 0, args: null }] as never, outcomes: { status: true },
      })
    }
  })
  return rows
}

function source(rows: NearblocksReceiptRow[]) {
  const text = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  const fetch: HistoryFetch = async (url) => {
    const u = new URL(url)
    const per = Number(u.searchParams.get('per_page'))
    const cursor = u.searchParams.get('cursor')
    if (u.pathname.endsWith('/ft-txns')) return text({ txns: [] })
    const after = cursor ? rows.filter((r) => BigInt(r.id) < BigInt(cursor)) : rows
    return text({ txns: after.slice(0, per) })
  }
  return createNearHistory({ fetch, rateLimit: 10_000 })
}

describe('NEAR history: a transaction cut by a page boundary is emitted once', () => {
  for (const limit of [1, 2, 3, 4, 5]) {
    it(`limit ${limit}: walking every page gives each transaction once, none lost`, async () => {
      const rows = dataset()
      const s = source(rows)
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const p = await s.listActivity(WALLET, { limit, ...(cursor ? { cursor } : {}) })
        seen.push(...p.items.map((t) => t.hash))
        if (!p.cursor) break
        cursor = p.cursor
      }
      expect(seen.filter((h, i) => seen.indexOf(h) !== i)).toEqual([])
      expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.transaction_hash)))
    })
  }
})
