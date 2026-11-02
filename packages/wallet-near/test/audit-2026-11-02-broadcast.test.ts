import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastUnknownError, NearRpcError, WalletManagerNear } from '../src/index.js'
import { fakeNode } from './fake-node.js'

// A send_tx that may have reached the network is BroadcastUnknownError (maybeSent + hash); only a
// known NEAR refusal is a plain NearRpcError.

const URL_A = 'https://near-a.example'
const HANGS = Symbol('hangs')
type Out = typeof HANGS | { status: number; body: string } | Error

function stub(onSend: () => Out) {
  const node = fakeNode()
  let sends = 0
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: string; method: string; params: unknown }
    if (req.method !== 'send_tx') {
      try { return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: await node.fetch(req.method, req.params) }), { status: 200 }) } catch (e) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: (e as { cause?: unknown }).cause }), { status: 200 })
      }
    }
    sends++
    const out = onSend()
    if (out === HANGS) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))))
    if (out instanceof Error) throw out
    return new Response(out.body, { status: out.status })
  })
  return () => sends
}
afterEach(() => { vi.unstubAllGlobals() })

async function outcome(onSend: () => Out) {
  const sends = stub(onSend)
  const a = await new WalletManagerNear('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { provider: URL_A, timeoutMs: 60 }).getAccount(0)
  const e = await a.transfer({ recipient: 'alice.near', amount: 1n }).catch((x: unknown) => x)
  return { e, sends: sends() }
}
const rpcErr = (error: unknown) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: '1', error }) })

describe('NEAR send_tx: an answer that may have landed is BroadcastUnknownError', () => {
  const cases: Array<[string, () => Out]> = [
    ['timeout (no answer)', () => HANGS],
    ['HTTP 500', () => ({ status: 500, body: 'Internal Server Error' })],
    ['HTTP 502', () => ({ status: 502, body: '<html>bad gateway</html>' })],
    ['fetch TypeError', () => new TypeError('fetch failed')],
    ['malformed JSON on 200', () => ({ status: 200, body: '{"result":' })],
    ['node TIMEOUT_ERROR', () => rpcErr({ name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, code: -32000, message: 'Server error' })],
    ['node INTERNAL_ERROR', () => rpcErr({ name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR' }, code: -32000, message: 'Server error' })],
    ['unnamed gateway error -32000', () => rpcErr({ code: -32000, message: 'upstream request timeout' })],
    ['unnamed -32603 internal', () => rpcErr({ code: -32603, message: 'Internal error' })],
    ['unknown error name', () => rpcErr({ name: 'HANDLER_ERROR', cause: { name: 'SOMETHING_NEW' }, code: -32000, message: 'Server error' })],
  ]
  for (const [name, b] of cases) {
    it(name, async () => {
      const { e, sends } = await outcome(b)
      expect(e).toBeInstanceOf(BroadcastUnknownError)
      expect(e).toMatchObject({ maybeSent: true, hash: expect.any(String) })
      expect(sends).toBe(1)
    })
  }
})

describe('NEAR send_tx: a known refusal stays a plain NearRpcError', () => {
  const cases: Array<[string, unknown]> = [
    ['INVALID_TRANSACTION', { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error' }],
    ['REQUEST_VALIDATION_ERROR / PARSE_ERROR', { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR' }, code: -32700, message: 'Parse error' }],
  ]
  for (const [name, err] of cases) {
    it(name, async () => {
      const { e } = await outcome(() => rpcErr(err))
      expect(e).toBeInstanceOf(NearRpcError)
      expect(e).not.toBeInstanceOf(BroadcastUnknownError)
    })
  }
})

describe('NEAR reads keep the definitive-answer rule', () => {
  it('an unnamed error on a read is not failed over to the next provider', async () => {
    let second = 0
    const first = async () => { throw new NearRpcError('query', { code: -32000, message: 'Server error' }) }
    const other = async () => { second++; return {} }
    const a = await new WalletManagerNear('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { provider: [first, other] }).getAccount(0)
    await expect(a.getBalance()).rejects.toBeInstanceOf(NearRpcError)
    expect(second).toBe(0)
  })
})
