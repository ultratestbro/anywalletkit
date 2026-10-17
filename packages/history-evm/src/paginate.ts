import type { WindowCursor } from './cursor.js'

/**
 * Block-window pagination over several independently paginated explorer
 * lists (transactions, token transfers, internal transfers).
 *
 * Each page fetches one explorer page of every list that is not exhausted,
 * then only emits rows above the highest "cut" block `L` among the lists that
 * still have more rows (everything above `L` is complete in every list, so the
 * merge by hash is exact). The next cursor is `w = L + 1` (exclusive upper
 * bound): Etherscan lists re-query with `endblock = w - 1`; Blockscout lists
 * keep their own `next_page_params` and only advance when all their fetched
 * rows were emitted (otherwise the same page is re-fetched and filtered by
 * `w`). Degenerate case: when one list has more than `limit` rows in a single
 * block, the page emits that block and skips what is left of it (`w = L`).
 */
export interface ListPage<R> {
  rows: R[]
  /** Explorer cursor for the next page of this list; `null` when exhausted. */
  next: unknown
}

export interface ListSpec<R extends { block: number }> {
  key: string
  /** `cursor` = this list's previous `next` (undefined on the first page); `below` = exclusive block upper bound, when set. */
  fetch(cursor: unknown, limit: number, below: number | undefined): Promise<ListPage<R>>
}

export interface WindowResult {
  rows: Map<string, { block: number }[]>
  next?: WindowCursor
}

/** How many explorer pages a list may skip while catching up to a window set by another backend. */
const MAX_SKIP_PAGES = 10

export async function windowPage(specs: ListSpec<{ block: number }>[], cursor: WindowCursor | undefined, limit: number): Promise<WindowResult> {
  const w = cursor?.w
  const fetched: { spec: ListSpec<{ block: number }>; all: { block: number }[]; rows: { block: number }[]; next: unknown; listCursor: unknown }[] = []

  for (const spec of specs) {
    const listCursor = cursor?.lists[spec.key]
    if (listCursor === null) continue // exhausted earlier
    let cur = listCursor
    let page = await spec.fetch(cur, limit, w)
    let all = page.rows
    let rows = w === undefined ? all : all.filter((r) => r.block < w)
    // Catching up: the cursor came from another backend (block only), skip pages entirely above `w`.
    for (let i = 0; i < MAX_SKIP_PAGES && w !== undefined && rows.length === 0 && all.length > 0 && page.next !== null; i++) {
      cur = page.next
      page = await spec.fetch(cur, limit, w)
      all = page.rows
      rows = all.filter((r) => r.block < w)
    }
    fetched.push({ spec, all, rows, next: page.next, listCursor: cur })
  }

  // L = highest cut block among lists that have more rows beyond this page.
  let L: number | undefined
  for (const f of fetched) {
    if (f.next === null || f.all.length === 0) continue
    const min = Math.min(...f.all.map((r) => r.block))
    L = L === undefined ? min : Math.max(L, min)
  }

  const out = new Map<string, { block: number }[]>()
  if (L === undefined) {
    for (const f of fetched) out.set(f.spec.key, f.rows)
    return { rows: out }
  }

  const bound = L
  let emitted = fetched.map((f) => f.rows.filter((r) => r.block > bound))
  let wNew = bound + 1
  if (emitted.every((rows) => rows.length === 0) && fetched.some((f) => f.rows.length > 0)) {
    // One block holds more than `limit` rows of a list: emit it and move past it (lossy, documented).
    emitted = fetched.map((f) => f.rows.filter((r) => r.block >= bound))
    wNew = bound
  }

  const lists: Record<string, unknown> = { ...(cursor?.lists ?? {}) }
  let anyActive = false
  fetched.forEach((f, i) => {
    out.set(f.spec.key, emitted[i]!)
    const leftover = f.rows.some((r) => r.block < wNew)
    if (leftover) {
      lists[f.spec.key] = f.listCursor ?? undefined // re-fetch the same explorer page next time
      anyActive = true
    } else if (f.next === null) {
      lists[f.spec.key] = null
    } else {
      lists[f.spec.key] = f.next
      anyActive = true
    }
  })
  for (const k of Object.keys(lists)) if (lists[k] === undefined) delete lists[k]

  return anyActive ? { rows: out, next: { w: wNew, lists } } : { rows: out }
}
