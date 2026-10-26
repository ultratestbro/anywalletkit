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
  /**
   * Id (`chain:hash`) of the last row of that page already emitted. When the page comes back
   * shifted (new transactions landed at the head), the feed skips through this row instead of
   * counting `n`, so nothing is shown twice.
   */
  l?: string
}

/** Source key → state; a key that is absent is exhausted. */
export type FeedCursorState = Record<string, SourceState>

const PREFIX = 'fw1:'

/** @internal Key of one (chain, address) source inside a feed cursor. */
export const sourceKey = (chain: string, address: string): string => `${chain}|${address}`

/** @internal Serialize cursor state into the opaque `fw1:` string the feed returns. */
export function packCursor(state: FeedCursorState): string | undefined {
  const keys = Object.keys(state)
  if (keys.length === 0) return undefined
  const sorted: FeedCursorState = {}
  for (const k of keys.sort()) sorted[k] = state[k]!
  return PREFIX + JSON.stringify(sorted)
}

/**
 * Thrown by `history()` when the `cursor` passed back is not one the feed produced (edited,
 * truncated or from another wallet build).
 */
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
    const s = v as { c?: unknown; n?: unknown; l?: unknown }
    if (typeof s.n !== 'number' || !Number.isInteger(s.n) || s.n < 0) throw new InvalidCursorError()
    if (s.c !== undefined && typeof s.c !== 'string') throw new InvalidCursorError()
    if (s.l !== undefined && (typeof s.l !== 'string' || s.l.length > 256)) throw new InvalidCursorError()
    out[k] = { ...(s.c === undefined ? {} : { c: s.c }), n: s.n, ...(s.l === undefined ? {} : { l: s.l }) }
  }
  return out
}
