import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletManagerTron } from '../src/index.js'
import { NOW, RECIPIENT, fakeNode } from './fake-node.js'

// A successful broadcast returns the txID of the bytes this account signed, whatever id the node echoes.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BROADCAST = '/wallet/broadcasttransaction'
afterEach(() => { vi.unstubAllGlobals() })

async function send(answer: (txID: string) => unknown) {
  const node = fakeNode()
  const sent: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (u.pathname !== BROADCAST) return new Response(JSON.stringify(await node.fetch(u.pathname, body)), { status: 200 })
    sent.push(String(body.txID))
    return new Response(JSON.stringify(answer(String(body.txID))), { status: 200 })
  })
  const a = await new WalletManagerTron(SEED, { provider: 'https://a.example', timeoutMs: 60 }).getAccount(0)
  const real = Date.now
  Date.now = () => NOW
  try { return { r: await a.transfer({ recipient: RECIPIENT, amount: 1_000_000n }), sent } } finally { Date.now = real }
}

describe('Tron broadcast: the returned hash is the signed txID', () => {
  it('a node echoing a foreign txid', async () => {
    const { r, sent } = await send(() => ({ result: true, txid: 'f'.repeat(64) }))
    expect(r.hash).toBe(sent[0])
    expect(r.hash).not.toBe('f'.repeat(64))
  })
  it('control: a node echoing the same txid', async () => {
    const { r, sent } = await send((txID) => ({ result: true, txid: txID }))
    expect(r.hash).toBe(sent[0])
  })
  it('control: a node answering result:true with no txid', async () => {
    const { r, sent } = await send(() => ({ result: true }))
    expect(r.hash).toBe(sent[0])
  })
})
