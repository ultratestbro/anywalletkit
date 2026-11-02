import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastUnknownError, WalletManagerTron } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// java-tron answers NOT_ENOUGH_EFFECTIVE_CONNECTION in two places: the peer-count check before the
// push (a refusal) and "P2P broadcast failed." after the transaction is in its pending pool (maybe sent).

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BROADCAST = '/wallet/broadcasttransaction'
const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')

async function send(message: string) {
  const node = fakeNode()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (u.pathname !== BROADCAST) return new Response(JSON.stringify(await node.fetch(u.pathname, body)), { status: 200 })
    return new Response(JSON.stringify({ result: false, code: 'NOT_ENOUGH_EFFECTIVE_CONNECTION', message }), { status: 200 })
  })
  const a = await new WalletManagerTron(SEED, { provider: 'https://a.example', timeoutMs: 60 }).getAccount(0)
  const real = Date.now
  Date.now = () => NOW
  try { return await a.transfer({ recipient: RECIPIENT, amount: 1_000_000n }).catch((x: unknown) => x) } finally { Date.now = real }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('Tron broadcast: NOT_ENOUGH_EFFECTIVE_CONNECTION', () => {
  it('"P2P broadcast failed." (after the push) is BroadcastUnknownError', async () => {
    const e = await send(hex('P2P broadcast failed.'))
    expect(e).toBeInstanceOf(BroadcastUnknownError)
    expect(e).toMatchObject({ maybeSent: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
  it('the same message not hex-encoded is BroadcastUnknownError too', async () => {
    expect(await send('P2P broadcast failed.')).toBeInstanceOf(BroadcastUnknownError)
  })
  it('the peer-count check before the push stays a plain refusal', async () => {
    const e = await send(hex('Effective connection:0 lt minEffectiveConnection:1'))
    expect(e).toBeInstanceOf(Error)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
    expect((e as Error).message).toBe('Broadcast failed: NOT_ENOUGH_EFFECTIVE_CONNECTION Effective connection:0 lt minEffectiveConnection:1')
  })
})
