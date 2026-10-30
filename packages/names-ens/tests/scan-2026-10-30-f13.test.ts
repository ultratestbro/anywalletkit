// Scan 2026-10-30 F13: the direct CCIP-Read path (ensCcipRequest) buffered a gateway's whole answer
// (res.text() / res.json()) with no byte cap and no body deadline, even for an HTTP error status. A gateway is
// chosen by the name's owner. Now: status and declared size first, the body read to at most maxResponseBytes
// (1 MiB), and timeoutMs (10 s) covering the request and the whole answer, next to the caller's signal.
// The server handler (createEnsCcipHandler) shares the reader and keeps its own cap and deadline.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { ensCcipRequest } from '../src/index.js'
import { createEnsCcipHandler } from '../src/server.js'

afterEach(() => vi.unstubAllGlobals())

const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as const
const CALLDATA = '0x9061b923' as Hex
const GW = 'https://gw.example/{sender}/{data}.json'
const MiB = 1024 * 1024

/** A body of `total` bytes in 64 KiB chunks; `pulled()` says how many the reader took. */
function hugeBody(total: number, status = 200, contentType = 'text/plain') {
  let pulled = 0
  const chunk = new Uint8Array(64 * 1024).fill(0x61)
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= total) return c.close()
      pulled += chunk.byteLength
      c.enqueue(chunk)
    },
  })
  return { res: new Response(body, { status, headers: { 'content-type': contentType } }), pulled: () => pulled }
}

/** A body that sends one byte every 20 ms and never ends. */
function endlessDrip() {
  let timer: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(c) { timer = setInterval(() => { try { c.enqueue(new Uint8Array([0x30])) } catch { clearInterval(timer) } }, 20) },
    cancel() { clearInterval(timer) },
  })
  return { res: new Response(body, { headers: { 'content-type': 'text/plain' } }), stop: () => clearInterval(timer) }
}

describe('F13 direct path: a gateway answer is not buffered without bound', () => {
  it('a 64 MiB answer (HTTP 500) is not read past a few MiB', async () => {
    const b = hugeBody(64 * MiB, 500)
    const fetch = vi.fn(async () => b.res)
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch })).rejects.toThrow(/answered HTTP 500/)
    // Before: all 64 MiB were pulled into memory before the status was looked at.
    expect(b.pulled()).toBeLessThanOrEqual(2 * MiB)
  }, 30_000)

  it('an endless body does not stall resolution forever (no caller signal)', async () => {
    const d = endlessDrip()
    const settled = await Promise.race([
      ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => d.res }).then(() => 'resolved', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('still-pending'), 12_000)),
    ])
    d.stop()
    // Before: still pending — there was no body deadline when viem passes no signal.
    expect(settled).not.toBe('still-pending')
  }, 20_000)
})

/**
 * A real-size offchain answer: cb.id / Basenames gateways answer `{"data":"0x…"}` with the ABI-encoded
 * (result, expires, signature) — a few hundred bytes to a few KB. 4 KB of hex here, streamed in small chunks.
 */
const REAL_DATA = `0x${'00'.repeat(31)}20${'00'.repeat(31)}a0${'ab'.repeat(2000)}`
const realAnswer = (opts: { chunk?: number; declare?: boolean; stream?: boolean } = {}) => {
  const json = JSON.stringify({ data: REAL_DATA })
  const bytes = new TextEncoder().encode(json)
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }
  if (opts.declare) headers['content-length'] = String(bytes.byteLength)
  if (opts.stream === false) {
    // React Native's fetch: no stream, text() only.
    return { ok: true, status: 200, redirected: false, url: '', headers: new Headers(headers), body: null, text: async () => json } as unknown as Response
  }
  const step = opts.chunk ?? 512
  let at = 0
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (at >= bytes.byteLength) return c.close(); c.enqueue(bytes.subarray(at, at + step)); at += step } })
  return new Response(body, { status: 200, headers })
}

describe('F13: honest gateways still resolve', () => {
  it('a few-KB JSON answer resolves, streamed, declared or as plain text()', async () => {
    expect(JSON.stringify({ data: REAL_DATA }).length).toBeGreaterThan(4000)
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => realAnswer() })).toBe(REAL_DATA)
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => realAnswer({ declare: true, chunk: 7 }) })).toBe(REAL_DATA)
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => realAnswer({ stream: false }) })).toBe(REAL_DATA)
    // A POST gateway (template without {data}) too.
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://api.example.cb.id/r'] }, { fetch: async () => realAnswer() })).toBe(REAL_DATA)
  })

  it('a plain-text hex answer resolves', async () => {
    const fetch = async () => new Response('0xabcdef', { headers: { 'content-type': 'text/plain' } })
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch })).toBe('0xabcdef')
  })

  it('an answer exactly at the cap resolves, one byte over is refused, and the next gateway is asked', async () => {
    const json = JSON.stringify({ data: REAL_DATA })
    const size = new TextEncoder().encode(json).byteLength
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => realAnswer(), maxResponseBytes: size })).toBe(REAL_DATA)
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => realAnswer(), maxResponseBytes: size - 1 })).rejects.toThrow(/larger than \d+ bytes/)
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => realAnswer({ stream: false }), maxResponseBytes: size - 1 })).rejects.toThrow(/larger than/)
    let n = 0
    const fetch = async () => (n++ === 0 ? hugeBody(8 * MiB).res : realAnswer())
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW, 'https://gw2.example/{data}'] }, { fetch })).toBe(REAL_DATA)
  })
})

describe('F13: size and status before reading', () => {
  it('a declared content-length above the cap is refused without reading', async () => {
    let read = false
    const res = { ok: true, status: 200, redirected: false, url: '', headers: new Headers({ 'content-type': 'application/json', 'content-length': String(2 * MiB) }), body: null, text: async () => { read = true; return '{}' } } as unknown as Response
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => res })).rejects.toThrow(/larger than 1048576 bytes/)
    expect(read).toBe(false)
  })

  it('a non-2xx answer is not read and its body is cancelled', async () => {
    let cancelled = false
    let read = false
    const res = { ok: false, status: 503, redirected: false, url: '', headers: new Headers(), body: { cancel: async () => { cancelled = true } }, text: async () => { read = true; return '' } } as unknown as Response
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async () => res })).rejects.toThrow(/answered HTTP 503/)
    expect(cancelled).toBe(true)
    expect(read).toBe(false)
  })
})

describe('F13: the deadline and the caller signal', () => {
  it('timeoutMs covers the body and aborts the request signal', async () => {
    const d = endlessDrip()
    let seen: AbortSignal | undefined
    const err = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: async (_u, init) => { seen = init.signal ?? undefined; return d.res }, timeoutMs: 200 }).catch((e: unknown) => e)
    d.stop()
    expect(String(err)).toMatch(/did not answer within 0\.2 s/)
    expect(seen?.aborted).toBe(true)
  })

  it('timeoutMs covers a fetch that never answers', async () => {
    const err = await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW] }, { fetch: () => new Promise<Response>(() => {}), timeoutMs: 150 }).catch((e: unknown) => e)
    expect(String(err)).toMatch(/did not answer within/)
  })

  it("the caller's abort ends the lookup at once, with the caller's reason", async () => {
    const d = endlessDrip()
    const ac = new AbortController()
    const p = ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: [GW, 'https://gw2.example/{data}'], requestOptions: { signal: ac.signal } } as never, { fetch: async () => d.res })
    setTimeout(() => ac.abort(new Error('caller gave up')), 50)
    await expect(p).rejects.toThrow('caller gave up')
    d.stop()
  })
})

describe('F13 control: createEnsCcipHandler caps and times out the gateway answer', () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  it('a 64 MiB answer is refused at maxResponseBytes', async () => {
    const b = hugeBody(64 * MiB)
    const handle = createEnsCcipHandler({ lookup, fetch: async () => b.res })
    const r = await handle({ url: 'https://gw.example/x.json', method: 'GET' })
    expect(r).toEqual({ status: 502, body: { error: 'gateway answer too large' } })
    expect(b.pulled()).toBeLessThanOrEqual(1 * MiB + 256 * 1024)
  })
  it('an endless body ends at timeoutMs', async () => {
    const d = endlessDrip()
    const handle = createEnsCcipHandler({ lookup, timeoutMs: 300, fetch: async () => d.res })
    const r = await handle({ url: 'https://gw.example/x.json', method: 'GET' })
    d.stop()
    expect(r.status).toBe(504)
  })
})
