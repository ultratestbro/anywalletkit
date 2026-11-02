import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastUnknownError, WalletManagerTron } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// With a list of providers, a refusal from a later provider does not prove the transaction stayed off
// the network when an earlier provider got the same bytes and gave no answer: that is BroadcastUnknownError.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BROADCAST = '/wallet/broadcasttransaction'
const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')
type Out = 'hang' | { status: number; body: string }

function stub(onBroadcast: (host: string) => Out) {
  const node = fakeNode()
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (u.pathname !== BROADCAST) return new Response(JSON.stringify(await node.fetch(u.pathname, body)), { status: 200 })
    sent.push(`${u.host}:${String(body.txID)}`)
    const out = onBroadcast(u.host)
    if (out === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted'))))
    return new Response(out.body, { status: out.status })
  })
  return sent
}
const withNow = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = Date.now
  Date.now = () => NOW
  try { return await fn() } finally { Date.now = real }
}
afterEach(() => { vi.unstubAllGlobals() })

async function send(onBroadcast: (host: string) => Out) {
  const sent = stub(onBroadcast)
  const a = await new WalletManagerTron(SEED, { provider: ['https://a.example', 'https://b.example'], timeoutMs: 60, retries: 0 }).getAccount(0)
  const r = await withNow(() => a.transfer({ recipient: RECIPIENT, amount: 1_000_000n })).catch((x: unknown) => x)
  return { r, sent }
}
const refusal = (code: string) => ({ status: 200, body: JSON.stringify({ result: false, code, message: hex('refused here') }) })

describe('Tron failover broadcast', () => {
  for (const code of ['SERVER_BUSY', 'TAPOS_ERROR', 'BLOCK_UNSOLIDIFIED', 'NO_CONNECTION', 'NOT_ENOUGH_EFFECTIVE_CONNECTION', 'CONTRACT_VALIDATE_ERROR']) {
    it(`A times out, B answers ${code}: BroadcastUnknownError with the signed txID`, async () => {
      const { r, sent } = await send((host) => (host === 'a.example' ? 'hang' : refusal(code)))
      expect(sent.map((s) => s.split(':')[0])).toEqual(['a.example', 'b.example'])
      expect(r).toBeInstanceOf(BroadcastUnknownError)
      expect(r).toMatchObject({ maybeSent: true, hash: sent[0]!.split(':')[1] })
    })
  }

  it('A answers HTTP 502, B answers SERVER_BUSY: BroadcastUnknownError', async () => {
    const { r } = await send((host) => (host === 'a.example' ? { status: 502, body: 'bad gateway' } : refusal('SERVER_BUSY')))
    expect(r).toBeInstanceOf(BroadcastUnknownError)
  })

  it('control: A answers SERVER_BUSY itself: a plain refusal, B is not tried', async () => {
    const { r, sent } = await send(() => refusal('SERVER_BUSY'))
    expect(sent.length).toBe(1)
    expect(r).toBeInstanceOf(Error)
    expect(r).not.toBeInstanceOf(BroadcastUnknownError)
    expect((r as Error).message).toBe('Broadcast failed: SERVER_BUSY refused here')
  })

  it('control: A times out, B accepts: sent', async () => {
    const { r } = await send((host) => (host === 'a.example' ? 'hang' : { status: 200, body: JSON.stringify({ result: true }) }))
    expect(r).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('control: A times out, B answers DUP_TRANSACTION_ERROR: sent', async () => {
    const { r } = await send((host) => (host === 'a.example' ? 'hang' : { status: 200, body: JSON.stringify({ code: 'DUP_TRANSACTION_ERROR' }) }))
    expect(r).not.toBeInstanceOf(Error)
    expect(r).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})
