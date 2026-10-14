/**
 * One opaque cursor for a feed that merges several chains. Per (chain, address)
 * source it keeps the source's own cursor for the page to fetch next and how many
 * rows at the head of that page the previous call already emitted (a page is
 * refetched and skipped when the merge consumed only part of it).
 */
export interface SourceState {
  /** Source cursor for the page to fetch (undefined = the newest page). */
  c?: string
  /** Rows at the head of that page already emitted. */
  n: number
}

/** Source key → state; a key that is absent is exhausted. */
export type FeedCursorState = Record<string, SourceState>

const PREFIX = 'fw1:'

export const sourceKey = (chain: string, address: string): string => `${chain}|${address}`

export function packCursor(state: FeedCursorState): string | undefined {
  const keys = Object.keys(state)
  if (keys.length === 0) return undefined
  const sorted: FeedCursorState = {}
  for (const k of keys.sort()) sorted[k] = state[k]!
  return PREFIX + JSON.stringify(sorted)
}

export class InvalidCursorError extends Error {
  constructor(message = 'The cursor is not one this feed produced.') { super(message); this.name = 'InvalidCursorError' }
}

/** Parse a cursor; `undefined` (first page) gives `undefined` so callers start every source at its newest page. */
export function unpackCursor(cursor: string | undefined): FeedCursorState | undefined {
  if (cursor === undefined) return undefined
  if (!cursor.startsWith(PREFIX)) throw new InvalidCursorError()
  let parsed: unknown
  try { parsed = JSON.parse(cursor.slice(PREFIX.length)) } catch { throw new InvalidCursorError() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvalidCursorError()
  const out: FeedCursorState = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') throw new InvalidCursorError()
    const s = v as { c?: unknown; n?: unknown }
    if (typeof s.n !== 'number' || !Number.isInteger(s.n) || s.n < 0) throw new InvalidCursorError()
    if (s.c !== undefined && typeof s.c !== 'string') throw new InvalidCursorError()
    out[k] = s.c === undefined ? { n: s.n } : { c: s.c, n: s.n }
  }
  return out
}
