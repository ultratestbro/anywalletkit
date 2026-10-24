import type { HistoryBackend } from './types.js'

/**
 * Page cursor: the block window the next page continues below, plus the
 * per-list explorer cursors (Blockscout `next_page_params`; unused by
 * Etherscan, which pages with `endblock`). Base64 of JSON, opaque to callers.
 * `w` is exclusive: the next page returns rows with `block < w`.
 */
export interface WindowCursor {
  w?: number
  /** list key → explorer cursor; `null` = that list is exhausted. */
  lists: Record<string, unknown>
}

export interface PageCursor extends WindowCursor {
  v: 1
  b: HistoryBackend
}

/** @internal Encode a history cursor. */
export function encodeCursor(c: PageCursor): string {
  return base64Encode(JSON.stringify(c))
}

/** @internal Decode a history cursor; throws on a malformed one. */
export function decodeCursor(s: string): PageCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(base64Decode(s))
  } catch {
    throw new Error('@anywalletkit/history-evm: malformed cursor')
  }
  const c = parsed as Partial<PageCursor> | null
  if (!c || c.v !== 1 || typeof c.b !== 'string' || typeof c.lists !== 'object' || c.lists === null) {
    throw new Error('@anywalletkit/history-evm: malformed cursor')
  }
  const out: PageCursor = { v: 1, b: c.b, lists: c.lists }
  if (typeof c.w === 'number') out.w = c.w
  return out
}

// --- base64 over UTF-8, no Buffer / btoa (Hermes-safe) ---

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function utf8Encode(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return out
}

function utf8Decode(bytes: number[]): string {
  let s = ''
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++]!
    let cp: number
    if (b0 < 0x80) cp = b0
    else if (b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f)
    else if (b0 < 0xf0) cp = ((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    else cp = ((b0 & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    if (cp >= 0x10000) {
      cp -= 0x10000
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else s += String.fromCharCode(cp)
  }
  return s
}

export function base64Encode(s: string): string {
  const bytes = utf8Encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2]
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    out += b1 === undefined ? '=' : ALPHABET[(n >> 6) & 63]!
    out += b2 === undefined ? '=' : ALPHABET[n & 63]!
  }
  return out
}

export function base64Decode(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < clean.length ? ALPHABET.indexOf(clean[i + k]!) : -1))
    if (c[0]! < 0 || c[1]! < 0) throw new Error('bad base64')
    const n = (c[0]! << 18) | (c[1]! << 12) | ((c[2]! < 0 ? 0 : c[2]!) << 6) | (c[3]! < 0 ? 0 : c[3]!)
    bytes.push((n >> 16) & 0xff)
    if (c[2]! >= 0) bytes.push((n >> 8) & 0xff)
    if (c[3]! >= 0) bytes.push(n & 0xff)
  }
  return utf8Decode(bytes)
}
