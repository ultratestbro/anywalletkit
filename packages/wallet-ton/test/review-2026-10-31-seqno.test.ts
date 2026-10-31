import '../src/buffer-global.js'
import { describe, expect, it, vi } from 'vitest'
import { Cell, loadMessage } from '@ton/core'
import { BroadcastUnknownError, WalletManagerTon, parseV5R1Body } from '../src/index.js'
import { fakeRpc } from './fake-rpc.js'

// Two awaited transfers before the first was in a block both signed the chain seqno; the second
// external could never execute, yet both sends resolved. A send now waits (bounded) for this
// account's previous broadcast to move the seqno, and throws when it does not.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'

/** The fake node, but the seqno moves only once `landed()` says so (an external acknowledged, not in a block yet). */
function slowChain(opts: { sendFails?: boolean } = {}) {
  let seqno = 7
  let pending = 0
  let reads = 0
  const sent: Cell[] = []
  const base = fakeRpc({
    runGetMethod: (p) => {
      if (p.method !== 'seqno') throw new Error(`unmocked ${String(p.method)}`)
      reads++
      return { '@type': 'smc.runResult', gas_used: 1, exit_code: 0, stack: [['num', '0x' + seqno.toString(16)]] }
    },
    sendBoc: (p) => { sent.push(Cell.fromBase64(p.boc as string)); pending++; return {} },
  })
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { method?: string } : {}
    if (body.method === 'sendBoc' && opts.sendFails) {
      sent.push(Cell.fromBase64((JSON.parse(String(init!.body)) as { params: { boc: string } }).params.boc))
      throw new TypeError('fetch failed')
    }
    return base.fetch(input, init)
  }) as typeof fetch
  return {
    fetch: f, sent,
    seqnos: () => sent.map((ext) => parseV5R1Body(loadMessage(ext.beginParse()).body)!.seqno),
    landed: () => { seqno += pending; pending = 0 },
    reads: () => reads,
  }
}

const account = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  new WalletManagerTon(SEED, { tonClient: [{ url: 'http://fake/api/v2/jsonRPC' }], fetch, simulate: false, ...extra }).getAccount(0)

describe('TON: the next send waits for the previous one to move the seqno', () => {
  it('the second transfer signs seqno 8 once the first has landed', async () => {
    const net = slowChain()
    const a = await account(net.fetch)
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    const before = net.reads()
    // the first lands while the second polls
    const second = a.transfer({ recipient: RECIPIENT, amount: 2n })
    await vi.waitFor(() => expect(net.reads()).toBeGreaterThan(before))
    net.landed()
    await second
    expect(net.seqnos()).toEqual([7, 8])
  })

  it('throws "still pending" when the seqno does not move in time, without signing a second message', async () => {
    const net = slowChain()
    const a = await account(net.fetch, { pendingSeqnoTimeoutMs: 10 })
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    await expect(a.transfer({ recipient: RECIPIENT, amount: 2n })).rejects.toThrow(/still pending/)
    expect(net.seqnos()).toEqual([7])
    // once it lands the account sends again
    net.landed()
    await a.transfer({ recipient: RECIPIENT, amount: 2n })
    expect(net.seqnos()).toEqual([7, 8])
  })

  it('a maybe-sent broadcast also holds the seqno', async () => {
    const net = slowChain({ sendFails: true })
    const a = await account(net.fetch, { pendingSeqnoTimeoutMs: 10 })
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toBeInstanceOf(BroadcastUnknownError)
    await expect(a.transfer({ recipient: RECIPIENT, amount: 2n })).rejects.toThrow(/still pending/)
    expect(net.seqnos()).toEqual([7])
  })

  it('an expired external that never landed is forgotten: the chain seqno is used', async () => {
    const net = slowChain()
    const a = await account(net.fetch, { pendingSeqnoTimeoutMs: 10, validUntilSeconds: 1 })
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 5_000)
    try {
      await a.transfer({ recipient: RECIPIENT, amount: 2n })
    } finally { spy.mockRestore() }
    expect(net.seqnos()).toEqual([7, 7])
  })

  it('signTransaction does not hold the seqno', async () => {
    const net = slowChain()
    const a = await account(net.fetch, { pendingSeqnoTimeoutMs: 10 })
    await a.signTransaction({ to: RECIPIENT, value: 1n })
    await a.transfer({ recipient: RECIPIENT, amount: 1n })
    expect(net.seqnos()).toEqual([7])
  })

  it('concurrent sends are serialized: the second waits for the first', async () => {
    const net = slowChain()
    const a = await account(net.fetch, { pendingSeqnoTimeoutMs: 10 })
    const [r1, r2] = await Promise.allSettled([a.transfer({ recipient: RECIPIENT, amount: 1n }), a.transfer({ recipient: RECIPIENT, amount: 2n })])
    expect(r1.status).toBe('fulfilled')
    expect(r2.status).toBe('rejected')
    expect(net.seqnos()).toEqual([7])
  })
})
