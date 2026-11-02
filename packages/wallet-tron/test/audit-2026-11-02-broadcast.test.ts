import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastUnknownError, WalletManagerTron } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// A broadcast answer that does not prove the transaction stayed off the network is
// BroadcastUnknownError; only java-tron's pre-push refusal codes are a plain Error.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const A = 'https://a.example'
const BROADCAST = '/wallet/broadcasttransaction'
const HANGS = Symbol('hangs')
type Out = typeof HANGS | { status: number; body: string } | Error

function stub(onBroadcast: () => Out) {
  const node = fakeNode()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = url.slice(A.length)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (path !== BROADCAST) return new Response(JSON.stringify(await node.fetch(path, body)), { status: 200 })
    const out = onBroadcast()
    if (out === HANGS) return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))))
    if (out instanceof Error) throw out
    return new Response(out.body, { status: out.status })
  })
}
const withNow = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
}
afterEach(() => { vi.unstubAllGlobals() })

async function outcome(onBroadcast: () => Out) {
  stub(onBroadcast)
  const a = await new WalletManagerTron(SEED, { provider: A, timeoutMs: 60 }).getAccount(0)
  return withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1_000_000n })).catch((e: unknown) => e)
}

const unknown = (e: unknown) => {
  expect(e).toBeInstanceOf(BroadcastUnknownError)
  expect(e).toMatchObject({ maybeSent: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
}

describe('Tron broadcast: transport-level ambiguity is BroadcastUnknownError', () => {
  const cases: Array<[string, () => Out]> = [
    ['timeout (no answer)', () => HANGS],
    ['HTTP 500', () => ({ status: 500, body: 'Internal Server Error' })],
    ['HTTP 502', () => ({ status: 502, body: '<html>bad gateway</html>' })],
    ['fetch TypeError (connection reset)', () => new TypeError('fetch failed')],
    ['malformed JSON on 200', () => ({ status: 200, body: '{"result":tr' })],
  ]
  for (const [name, b] of cases) it(name, async () => unknown(await outcome(b)))
})

describe('Tron broadcast: an unrecognised 200 answer is BroadcastUnknownError', () => {
  const cases: Array<[string, unknown]> = [
    ['empty object', {}],
    ['result:false, no code', { result: false }],
    ['OTHER_ERROR', { result: false, code: 'OTHER_ERROR', message: '' }],
    ['unknown code', { code: 'SOMETHING_NEW', txid: 'ab' }],
    ['gateway JSON error', { Error: 'upstream timeout' }],
    ['null', null],
  ]
  for (const [name, body] of cases) it(name, async () => unknown(await outcome(() => ({ status: 200, body: JSON.stringify(body) }))))
})

describe('Tron broadcast: java-tron pre-push refusals stay a plain Error', () => {
  const codes = ['SIGERROR', 'CONTRACT_VALIDATE_ERROR', 'CONTRACT_EXE_ERROR', 'BANDWITH_ERROR', 'TAPOS_ERROR', 'TOO_BIG_TRANSACTION_ERROR',
    'TRANSACTION_EXPIRATION_ERROR', 'SERVER_BUSY', 'NO_CONNECTION', 'NOT_ENOUGH_EFFECTIVE_CONNECTION', 'BLOCK_UNSOLIDIFIED']
  for (const code of codes) {
    it(code, async () => {
      // java-tron hex-encodes the message.
      const message = Array.from(new TextEncoder().encode('refused here'), (b) => b.toString(16).padStart(2, '0')).join('')
      const e = await outcome(() => ({ status: 200, body: JSON.stringify({ code, txid: 'ab', message }) }))
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(BroadcastUnknownError)
      expect((e as Error).message).toBe(`Broadcast failed: ${code} refused here`)
    })
  }
})

describe('Tron broadcast: accepted answers', () => {
  it('result:true returns the txid', async () => {
    const e = await outcome(() => ({ status: 200, body: JSON.stringify({ result: true, txid: 'f'.repeat(64) }) }))
    expect(e).toMatchObject({ hash: 'f'.repeat(64) })
  })
  it('DUP_TRANSACTION_ERROR reads as accepted', async () => {
    const r = await outcome(() => ({ status: 200, body: JSON.stringify({ code: 'DUP_TRANSACTION_ERROR', txid: 'ab' }) }))
    expect(r).not.toBeInstanceOf(Error)
    expect(r).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})
