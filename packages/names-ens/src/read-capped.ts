/**
 * Reading a CCIP-Read gateway's answer without letting it decide how much memory the reader spends
 * (scan 2026-10-30 F13). Shared by the device path (`ensCcipRequest`) and the server handler.
 *
 * Runs on React Native / Hermes: no Buffer, no Node API. A response with a stream (`res.body.getReader`)
 * is read chunk by chunk and dropped once it passes the cap; one without (React Native's fetch, hand-built
 * responses) is read with `res.text()`, which the runtime buffers: there the caller's deadline is what
 * bounds it, and the cap is checked on the text.
 */

/** The part of a fetch Response the reader uses. */
export interface CappedResponse {
  headers: { get(name: string): string | null }
  body?: unknown
  text(): Promise<string>
}

interface Reader { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<unknown> }

/** Let go of a body that will not be read; a transport without one has nothing to release. */
export function cancelBody(res: { body?: unknown }): void {
  try {
    const b = res.body as { cancel?: () => unknown } | null | undefined
    Promise.resolve(b?.cancel?.()).catch(() => {})
  } catch { /* nothing to release */ }
}

/** A declared `content-length` above `cap`. */
export function declaresMoreThan(res: Pick<CappedResponse, 'headers'>, cap: number): boolean {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  return Number.isFinite(declared) && declared > cap
}

/** The body as text, or null when it is larger than `cap` bytes (declared or read). */
export async function readCapped(res: CappedResponse, cap: number): Promise<string | null> {
  if (declaresMoreThan(res, cap)) { cancelBody(res); return null }
  const body = res.body as { getReader?: () => Reader } | null | undefined
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text()
    return utf8Length(text) > cap ? null : text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > cap) { reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return decodeUtf8(all)
}

/** UTF-8 byte length of a string, without encoding it. */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

/**
 * TextDecoder where the runtime has one. Hermes may not: there the bytes are taken one per character, which is
 * exact for the ASCII a gateway answer that is used can contain (JSON around hex `data`, or the hex itself).
 */
function decodeUtf8(bytes: Uint8Array): string {
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder
  if (typeof TD === 'function') return new TD().decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x2000) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x2000)))
  return out
}
