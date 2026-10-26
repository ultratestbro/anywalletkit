import { describe, expect, it } from 'vitest'
import { NetworkError } from '@anywalletkit/core'
import { BroadcastUnknownError, EsploraClient, WalletManagerBtc, isAnsweredRefusal, parseRawTransaction } from '../src/index.js'
import { ADDR1, SEED, fakeBlockbook } from './helpers.js'

// Audit 2026-10-25 round 3, M12 (BTC part): a broadcast whose answer was lost (fetch threw, a
// timeout, a proxy's 502) surfaced as a plain NetworkError, so the app read it as "not sent" and
// built a new spend (other inputs, or RBF). Only a node's refusal (HTTP 4xx other than 408 with an
// error, or an error body) stays an error; anything else is a BroadcastUnknownError carrying the
// txid, computed locally before sending. "Already in the mempool / block chain" means it is out.

type Mode = 'throw' | 'html' | 'refuse' | 'refuse-200' | 'known'
function node(mode: Mode | undefined, base = fakeBlockbook()) {
  const raws: string[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    if (mode !== undefined && path.startsWith('/api/v2/sendtx/')) {
      raws.push(path.slice('/api/v2/sendtx/'.length))
      const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
      if (mode === 'throw') throw new TypeError('fetch failed')
      if (mode === 'html') return new Response('<html>502 Bad Gateway</html>', { status: 502 })
      if (mode === 'refuse') return json({ error: 'sendrawtransaction: bad-txns-inputs-missingorspent' }, 400)
      if (mode === 'refuse-200') return json({ error: { message: 'sendrawtransaction: min relay fee not met' } }, 200)
      return json({ error: 'sendrawtransaction: txn-already-in-mempool' }, 400)
    }
    return base.fetchFn(input, init)
  }) as typeof fetch
  return { fetchFn, raws }
}
const account = (fetchFn: typeof fetch, urls = ['https://bb.example']) =>
  new WalletManagerBtc(SEED, { network: 'bitcoin', client: urls.map((url) => ({ type: 'blockbook-http' as const, clientConfig: { url } })), fetch: fetchFn }).getAccount(0)
const txid = (raw: string) => parseRawTransaction(raw).id

describe('BTC: a lost broadcast answer is "maybe sent", a refusal is not', () => {
  for (const mode of ['throw', 'html'] as const) {
    it(`${mode === 'throw' ? 'fetch throws' : 'a 502'}: BroadcastUnknownError with the locally computed txid (transfer and sendTransaction)`, async () => {
      const n = node(mode)
      const a = await account(n.fetchFn)
      const e1 = await a.transfer({ recipient: ADDR1, amount: 10_000n }).then(() => null, (e: unknown) => e)
      expect(e1).toBeInstanceOf(BroadcastUnknownError)
      expect(e1).toMatchObject({ maybeSent: true, hash: txid(n.raws.at(-1)!) })
      const e2 = await a.sendTransaction({ to: ADDR1, value: 10_000n }).then(() => null, (e: unknown) => e)
      expect(e2).toMatchObject({ name: 'BroadcastUnknownError', hash: txid(n.raws.at(-1)!) })
    })
  }

  for (const mode of ['refuse', 'refuse-200'] as const) {
    it(`the node refusing (${mode === 'refuse' ? 'HTTP 400' : 'an error body'}) is not "maybe sent"`, async () => {
      const e = await (await account(node(mode).fetchFn)).transfer({ recipient: ADDR1, amount: 10_000n }).then(() => null, (x: unknown) => x)
      expect(e).toBeInstanceOf(Error)
      expect(e).not.toBeInstanceOf(BroadcastUnknownError)
      expect(isAnsweredRefusal(e)).toBe(true)
    })
  }

  it('"already in the mempool" means the transaction is out: its txid is returned', async () => {
    const n = node('known')
    const r = await (await account(n.fetchFn)).transfer({ recipient: ADDR1, amount: 10_000n })
    expect(r.hash).toBe(txid(n.raws.at(-1)!))
  })

  it('failover: refused by one endpoint and silent on another → maybe sent; refused by all → refused', async () => {
    const refuse = node('refuse')
    const silent = node('throw')
    const route = (async (i: string | URL | Request, init?: RequestInit) => (String(i).includes('first') ? refuse.fetchFn(i, init) : silent.fetchFn(i, init))) as typeof fetch
    await expect((await account(route, ['https://first.example', 'https://second.example'])).transfer({ recipient: ADDR1, amount: 10_000n })).rejects.toBeInstanceOf(BroadcastUnknownError)
    const both = await (await account(refuse.fetchFn, ['https://first.example', 'https://first2.example'])).transfer({ recipient: ADDR1, amount: 10_000n }).then(() => null, (x: unknown) => x)
    expect(both).not.toBeInstanceOf(BroadcastUnknownError)
    expect(isAnsweredRefusal(both)).toBe(true)
  })
})

describe('Esplora marks a refusal as answered and a lost answer as not', () => {
  const client = (res: () => Response | Promise<Response>) => new EsploraClient({ url: 'https://x.example/api' }, (async () => res()) as typeof fetch)
  it('400 with a reason: answered; 502, 408 and a thrown fetch: not', async () => {
    const e400 = await client(() => new Response('sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}', { status: 400 })).broadcast('00').catch((e: unknown) => e)
    expect(e400).toBeInstanceOf(NetworkError)
    expect(isAnsweredRefusal(e400)).toBe(true)
    for (const res of [() => new Response('bad gateway', { status: 502 }), () => new Response('', { status: 408 }), () => { throw new TypeError('fetch failed') }]) {
      expect(isAnsweredRefusal(await client(res).broadcast('00').catch((e: unknown) => e))).toBe(false)
    }
  })
})
