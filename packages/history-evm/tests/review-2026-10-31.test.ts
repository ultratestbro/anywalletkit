import { describe, expect, it } from 'vitest'
import { windowPage, type ListSpec } from '../src/index.js'

// A cursor carried over from another backend keeps only `w`. A Blockscout list ignores `below` and
// pages from the newest row, so windowPage may need many calls to catch up. However deep the
// catch-up, the window must never move above `w` and no row the previous backend showed comes back.

type R = { block: number; id: string }
/** Blockscout-style list: fixed page size, opaque offset cursor, `below` ignored. */
function blockscoutList(key: string, rows: R[], pageSize: number): ListSpec<R> {
  return {
    key,
    fetch: async (cursor: unknown) => {
      const off = (cursor as number | undefined) ?? 0
      return { rows: rows.slice(off, off + pageSize), next: off + pageSize < rows.length ? off + pageSize : null }
    },
  }
}
const gen = (prefix: string, from: number, n: number): R[] => Array.from({ length: n }, (_, i) => ({ block: from - i, id: `${prefix}@${from - i}` }))

async function drain(specs: ListSpec<R>[], w: number, limit: number, maxPages = 500) {
  const pages: { emitted: R[]; nextW: number | undefined }[] = []
  let cursor: { w?: number; lists: Record<string, unknown> } | undefined = { w, lists: {} }
  while (cursor && pages.length < maxPages) {
    const res = await windowPage(specs as ListSpec<{ block: number }>[], cursor, limit)
    pages.push({ emitted: [...res.rows.values()].flat() as R[], nextW: res.next?.w })
    cursor = res.next
  }
  expect(cursor).toBeUndefined() // drained, not stuck
  return pages
}

const W = 1000 // the previous backend already showed every row with block >= 1000

function expectClean(pages: { emitted: R[]; nextW: number | undefined }[], expected: number) {
  const all = pages.flatMap((p) => p.emitted)
  expect(all.every((r) => r.block < W)).toBe(true)
  expect(new Set(all.map((r) => r.id)).size).toBe(all.length)
  expect(all.length).toBe(expected)
  for (const p of pages) if (p.nextW !== undefined) expect(p.nextW).toBeLessThanOrEqual(W)
}

describe('backend switch with a deep window', () => {
  it('control: 10 pages above w — catches up in one call', async () => {
    const rows = gen('tx', W + 10 * 50 - 1, 10 * 50 + 300)
    expectClean(await drain([blockscoutList('tx', rows, 50)], W, 25), 300)
  })

  it('15 pages above w: the window stays at w until the list catches up, nothing re-emitted', async () => {
    const rows = gen('tx', W + 15 * 50 - 1, 15 * 50 + 300)
    const pages = await drain([blockscoutList('tx', rows, 50)], W, 25)
    expect(pages[0]!.nextW).toBe(W)
    expectClean(pages, 300)
  })

  it('two lists, one caught up, one 20 pages behind: every row below w once, none above', async () => {
    const tx = gen('tx', W - 1, 40)
    const tokens = gen('tok', W + 20 * 50 - 1, 20 * 50 + 100)
    const pages = await drain([blockscoutList('tx', tx, 50), blockscoutList('tokens', tokens, 50)], W, 25)
    expectClean(pages, 140)
    expect(pages.flatMap((p) => p.emitted).filter((r) => r.id.startsWith('tx')).length).toBe(40)
  })
})
