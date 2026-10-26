import { describe, expect, it } from 'vitest'
import type { ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { buildFeed } from '../src/index.js'

// Audit 2026-10-25 round 3, M7: the merged history sorted equal timestamps by chain + hash, not by
// each source's own page order, and counted a page as consumed up to the furthest row emitted. With
// equal timestamps (a block's worth of transactions, explorers with second-level times) a row the
// sort put later than a sibling was skipped for good (a hole) or emitted twice. Ties now keep each
// source's order, only a contiguous prefix of a page counts as consumed, and the cursor remembers
// the last row it handed out.

const OWN = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const OTHER = '0x000000000000000000000000000000000000bEEF'
const ETH = 'eip155:1', BASE = 'eip155:8453'

/** Explorer stand-in: rows in ITS order (newest first, ties in the explorer's own order), offset cursors. */
class Source implements HistorySource {
  constructor(readonly chain: string, public rows: ChainTx[], private readonly pageSize: number) {}
  async listActivity(_address: string, q?: HistoryQuery): Promise<HistoryPage> {
    const start = q?.cursor ? Number(q.cursor) : 0
    const items = this.rows.slice(start, start + this.pageSize)
    const next = start + this.pageSize < this.rows.length ? String(start + this.pageSize) : undefined
    return next === undefined ? { items } : { items, cursor: next }
  }
  async getTransaction(hash: string) { return this.rows.find((t) => t.hash === hash) }
  explorerTxUrl(hash: string) { return `https://scan/${hash}` }
}

/** A row whose hash does NOT follow the explorer's order (so a hash tie-break reorders the page). */
const row = (chain: string, time: number, hash: string): ChainTx => ({ chain, hash, time, status: 'confirmed', address: OWN, from: OWN, to: OTHER, nativeValue: 1n, transfers: [] })
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

async function walk(sources: Map<string, HistorySource>, limit: number, chains: string[]): Promise<string[]> {
  const seen: string[] = []
  let cursor: string | undefined
  for (let pages = 0; ; pages++) {
    if (pages > 200) throw new Error('cursor never ended')
    const page = await buildFeed({ sources, addresses: chains.map((chain) => ({ chain, address: OWN })), recognizers: [], query: { limit, ...(cursor ? { cursor } : {}) }, opts: {} })
    seen.push(...page.items.map((i) => `${i.chain}:${i.hash}`))
    cursor = page.cursor
    if (!cursor) return seen
  }
}

describe('history pagination with equal timestamps', () => {
  it('one source, every row at the same second, hashes against the page order: no hole, no duplicate', async () => {
    const rows = [9, 3, 7, 1, 8, 2, 6, 4, 5, 0].map((n) => row(ETH, 1000, h(n)))
    for (const limit of [1, 2, 3, 4]) {
      for (const pageSize of [2, 3, 5]) {
        const seen = await walk(new Map([[ETH, new Source(ETH, rows, pageSize)]]), limit, [ETH])
        expect(new Set(seen).size, `limit ${limit} page ${pageSize}: duplicates`).toBe(seen.length)
        expect([...seen].sort(), `limit ${limit} page ${pageSize}: holes`).toEqual(rows.map((r) => `${ETH}:${r.hash}`).sort())
      }
    }
  })

  it('two sources interleaving equal timestamps: every row exactly once', async () => {
    const a = [5, 1, 4, 2, 3].flatMap((n) => [row(ETH, 1000 - Math.floor(n / 3), h(100 + n))])
    const b = [7, 3, 9, 1].map((n) => row(BASE, 1000 - Math.floor(n / 4), h(200 + n)))
    a.sort((x, y) => y.time - x.time)
    b.sort((x, y) => y.time - x.time)
    for (const limit of [1, 2, 3]) {
      const seen = await walk(new Map<string, HistorySource>([[ETH, new Source(ETH, a, 2)], [BASE, new Source(BASE, b, 3)]]), limit, [ETH, BASE])
      expect(new Set(seen).size, `limit ${limit}: duplicates`).toBe(seen.length)
      expect([...seen].sort(), `limit ${limit}: holes`).toEqual([...a, ...b].map((r) => `${r.chain}:${r.hash}`).sort())
    }
  })

  it('a new transaction arriving at the head between pages does not repeat an already shown row', async () => {
    const rows = [5, 4, 3, 2, 1].map((n) => row(ETH, 1000 - n, h(n)))
    rows.reverse() // newest first: 995..999 → times 999, 998, …
    rows.sort((x, y) => y.time - x.time)
    const src = new Source(ETH, rows, 10)
    const sources = new Map<string, HistorySource>([[ETH, src]])
    const p1 = await buildFeed({ sources, addresses: [{ chain: ETH, address: OWN }], recognizers: [], query: { limit: 2 }, opts: {} })
    src.rows = [row(ETH, 2000, h(99)), ...rows] // a fresh tx lands at the head
    const p2 = await buildFeed({ sources, addresses: [{ chain: ETH, address: OWN }], recognizers: [], query: { limit: 2, cursor: p1.cursor! }, opts: {} })
    const ids1 = p1.items.map((i) => i.hash)
    const ids2 = p2.items.map((i) => i.hash)
    expect(ids2.filter((x) => ids1.includes(x))).toEqual([])
    expect(ids2).toEqual([rows[2]!.hash, rows[3]!.hash])
  })

  it('a transaction two own addresses both list (a transfer between them) is shown once, at any page size', async () => {
    const SECOND = '0x00000000000000000000000000000000000000A2'
    const shared = row(ETH, 1000, h(500))
    const a = [row(ETH, 1000, h(501)), shared, row(ETH, 1000, h(502)), row(ETH, 990, h(503))]
    const fromSecond = (t: ChainTx): ChainTx => ({ ...t, address: SECOND, from: SECOND })
    const b = [fromSecond(row(ETH, 1000, h(504))), fromSecond(row(ETH, 1000, h(505))), { ...shared, address: SECOND, to: SECOND }, fromSecond(row(ETH, 980, h(506)))]
    class PerAddress implements HistorySource {
      constructor(readonly chain: string, private readonly by: Record<string, ChainTx[]>, private readonly pageSize: number) {}
      async listActivity(address: string, q?: HistoryQuery): Promise<HistoryPage> {
        const rows = this.by[address]!
        const start = q?.cursor ? Number(q.cursor) : 0
        const items = rows.slice(start, start + this.pageSize)
        return start + this.pageSize < rows.length ? { items, cursor: String(start + this.pageSize) } : { items }
      }
      async getTransaction(hash: string) { return [...a, ...b].find((t) => t.hash === hash) }
      explorerTxUrl(hash: string) { return hash }
    }
    for (const limit of [1, 2, 3]) {
      for (const pageSize of [1, 2, 4]) {
        const sources = new Map<string, HistorySource>([[ETH, new PerAddress(ETH, { [OWN]: a, [SECOND]: b }, pageSize)]])
        const seen: string[] = []
        let cursor: string | undefined
        for (let pages = 0; ; pages++) {
          if (pages > 100) throw new Error('cursor never ended')
          const page = await buildFeed({ sources, addresses: [{ chain: ETH, address: OWN }, { chain: ETH, address: SECOND }], recognizers: [], query: { limit, ...(cursor ? { cursor } : {}) }, opts: {} })
          seen.push(...page.items.map((i) => i.hash))
          cursor = page.cursor
          if (!cursor) break
        }
        expect(new Set(seen).size, `limit ${limit} page ${pageSize}: duplicates`).toBe(seen.length)
        expect([...seen].sort(), `limit ${limit} page ${pageSize}: holes`).toEqual([...new Set([...a, ...b].map((r) => r.hash))].sort())
      }
    }
  })
})
