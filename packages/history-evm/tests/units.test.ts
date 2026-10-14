import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCKSCOUT_URLS,
  ETHERSCAN_COMPAT_URLS,
  ETHERSCAN_V2_CHAIN_IDS_FALLBACK,
  EXPLORER_TX_BASE,
  NO_EXPLORER_CHAIN_IDS,
  SUPPORTED_CHAIN_IDS,
  TokenBucket,
  createEvmHistory,
  decodeCursor,
  encodeCursor,
  explorerTxUrl,
  resetSharedBuckets,
  sharedBucket,
  windowPage,
  type ListSpec,
} from '../src/index.js'
import { base64Decode, base64Encode } from '../src/cursor.js'

describe('cursor', () => {
  it('round-trips, including unicode and nested Blockscout params', () => {
    const c = { v: 1 as const, b: 'blockscout' as const, w: 26159725, lists: { tx: { block_number: 1, index: 2, inserted_at: '2026-10-09T17:50:52.666729Z' }, tokens: null, internal: { s: 'ünï — 🚀' } } }
    const s = encodeCursor(c)
    expect(s).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(decodeCursor(s)).toEqual(c)
    const noW = encodeCursor({ v: 1, b: 'etherscan', lists: {} })
    expect(decodeCursor(noW)).toEqual({ v: 1, b: 'etherscan', lists: {} })
    expect('w' in decodeCursor(noW)).toBe(false)
  })

  it('rejects garbage and foreign versions', () => {
    expect(() => decodeCursor('%%%')).toThrow(/malformed/)
    expect(() => decodeCursor(base64Encode(JSON.stringify({ v: 2, b: 'etherscan', lists: {} })))).toThrow(/malformed/)
    expect(() => decodeCursor(base64Encode('[]'))).toThrow(/malformed/)
  })

  it('base64 matches the platform encoder for ASCII and UTF-8', () => {
    for (const s of ['', 'a', 'ab', 'abc', '{"w":1}', 'héllo wörld', '日本語', '🚀x']) {
      expect(base64Encode(s)).toBe(Buffer.from(s, 'utf8').toString('base64'))
      expect(base64Decode(base64Encode(s))).toBe(s)
    }
  })
})

describe('rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSharedBuckets()
  })
  afterEach(() => vi.useRealTimers())

  it('spaces requests at 1 rps without a key', async () => {
    const b = new TokenBucket(1)
    const done: number[] = []
    const t0 = Date.now()
    const all = Promise.all([0, 1, 2].map(() => b.acquire().then(() => done.push(Date.now() - t0))))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toEqual([0])
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toEqual([0, 1000])
    await vi.advanceTimersByTimeAsync(1000)
    await all
    expect(done).toEqual([0, 1000, 2000])
  })

  it('allows a burst of 5 then 200 ms spacing at 5 rps', async () => {
    const b = new TokenBucket(5)
    const done: number[] = []
    const t0 = Date.now()
    const all = Promise.all(Array.from({ length: 7 }, () => b.acquire().then(() => done.push(Date.now() - t0))))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(200)
    expect(done).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(200)
    await all
    expect(done).toHaveLength(7)
    expect(done[6]).toBe(400)
  })

  it('refills while idle', async () => {
    const b = new TokenBucket(2)
    await b.acquire()
    await b.acquire()
    await vi.advanceTimersByTimeAsync(1000)
    const t = Date.now()
    await b.acquire()
    expect(Date.now() - t).toBe(0)
  })

  it('sources with the same Etherscan key share one bucket', () => {
    expect(sharedBucket('etherscan:k', 5)).toBe(sharedBucket('etherscan:k', 5))
    expect(sharedBucket('etherscan:k', 5)).not.toBe(sharedBucket('etherscan:other', 5))
  })
})

describe('chain tables', () => {
  it('has an explorer tx URL for all 25 chains', () => {
    expect(SUPPORTED_CHAIN_IDS).toHaveLength(25)
    for (const id of SUPPORTED_CHAIN_IDS) {
      const url = explorerTxUrl(id, '0xdeadbeef')
      expect(url).toMatch(/^https:\/\/[^/]+(\/[^/]+)*\/tx\/0xdeadbeef$/)
      expect(EXPLORER_TX_BASE[id]).toBeDefined()
      const src = createEvmHistory({ chainId: id, fetch: (async () => { throw new Error('no network in tests') }) as never })
      expect(src.chain).toBe(`eip155:${id}`)
      expect(src.explorerTxUrl('0x1')).toBe(`${EXPLORER_TX_BASE[id]}/tx/0x1`)
    }
    expect(() => explorerTxUrl(999999, '0x1')).toThrow(/no explorer/)
  })

  it('every chain is covered by Etherscan v2, Blockscout, Routescan or the no-explorer list', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      const covered = ETHERSCAN_V2_CHAIN_IDS_FALLBACK.includes(id) || id in BLOCKSCOUT_URLS || id in ETHERSCAN_COMPAT_URLS || NO_EXPLORER_CHAIN_IDS.includes(id)
      expect(covered, `chain ${id}`).toBe(true)
    }
    for (const id of NO_EXPLORER_CHAIN_IDS) {
      expect(ETHERSCAN_V2_CHAIN_IDS_FALLBACK).not.toContain(id)
      expect(BLOCKSCOUT_URLS[id]).toBeUndefined()
    }
    // every URL is https and has no trailing slash
    for (const u of [...Object.values(BLOCKSCOUT_URLS), ...Object.values(ETHERSCAN_COMPAT_URLS), ...Object.values(EXPLORER_TX_BASE)]) expect(u).toMatch(/^https:\/\/.*[^/]$/)
  })

  it('verified-on-2026-10-14 facts: Etherscan v2 lacks Scroll, zkSync, Ink, Plume, X Layer; Blockscout covers the first four', () => {
    for (const id of [534352, 324, 57073, 98866, 196]) expect(ETHERSCAN_V2_CHAIN_IDS_FALLBACK).not.toContain(id)
    for (const id of [534352, 324, 57073, 98866]) expect(BLOCKSCOUT_URLS[id]).toBeDefined()
    expect(NO_EXPLORER_CHAIN_IDS).toEqual([196])
  })
})

describe('window pagination engine', () => {
  type R = { block: number; id: string }
  /** A list sorted desc that pages like Etherscan (endblock) when `byBlock`, else like Blockscout (opaque offset cursor). */
  const list = (key: string, rows: R[], pageSize: number, byBlock: boolean): ListSpec<R> => ({
    key,
    fetch: async (cursor, limit, below) => {
      const size = byBlock ? limit : pageSize
      if (byBlock) {
        const slice = rows.filter((r) => below === undefined || r.block < below).slice(0, size)
        return { rows: slice, next: slice.length >= size ? 'more' : null }
      }
      const off = typeof cursor === 'number' ? cursor : 0
      const slice = rows.slice(off, off + size)
      return { rows: slice, next: off + size < rows.length ? off + size : null }
    },
  })
  const gen = (prefix: string, blocks: number[]) => blocks.map((b, i) => ({ block: b, id: `${prefix}${i}@${b}` })).sort((a, b) => b.block - a.block)

  async function drain(specs: ListSpec<R>[], limit: number) {
    const out: R[] = []
    let cursor: Awaited<ReturnType<typeof windowPage>>['next'] | undefined
    let pages = 0
    do {
      const res = await windowPage(specs as ListSpec<{ block: number }>[], cursor, limit)
      pages++
      for (const rows of res.rows.values()) out.push(...(rows as R[]))
      cursor = res.next
    } while (cursor && pages < 1000)
    return { out, pages }
  }

  it('Etherscan-style lists of different density: complete, no duplicates, in order', async () => {
    const tx = gen('t', Array.from({ length: 57 }, (_, i) => 1000 - i * 3))
    const tok = gen('k', Array.from({ length: 140 }, (_, i) => 1000 - i))
    const int = gen('i', [999, 950, 950, 901, 10])
    const { out, pages } = await drain([list('tx', tx, 0, true), list('tokens', tok, 0, true), list('internal', int, 0, true)], 10)
    expect(pages).toBeGreaterThan(10)
    expect(out.map((r) => r.id).sort()).toEqual([...tx, ...tok, ...int].map((r) => r.id).sort())
    expect(new Set(out.map((r) => r.id)).size).toBe(out.length)
  })

  it('Blockscout-style lists with opaque cursors re-fetch instead of losing rows', async () => {
    const tx = gen('t', Array.from({ length: 33 }, (_, i) => 500 - i * 5))
    const tok = gen('k', Array.from({ length: 90 }, (_, i) => 500 - i))
    const { out } = await drain([list('tx', tx, 7, false), list('tokens', tok, 7, false)], 7)
    expect(out.map((r) => r.id).sort()).toEqual([...tx, ...tok].map((r) => r.id).sort())
    expect(new Set(out.map((r) => r.id)).size).toBe(out.length)
  })

  it('a single block with more rows than the page is emitted once and skipped (documented lossy edge)', async () => {
    const tok = gen('k', [...Array.from({ length: 25 }, () => 700), 600, 500])
    const tx = gen('t', [700, 650, 500])
    const { out, pages } = await drain([list('tx', tx, 0, true), list('tokens', tok, 0, true)], 10)
    expect(pages).toBeLessThan(10)
    expect(new Set(out.map((r) => r.id)).size).toBe(out.length)
    expect(out.filter((r) => r.block === 700).length).toBeLessThanOrEqual(11) // 10 token rows + the tx row, rest skipped
    expect(out.some((r) => r.block === 600)).toBe(true)
    expect(out.filter((r) => r.block === 500)).toHaveLength(2)
  })
})
