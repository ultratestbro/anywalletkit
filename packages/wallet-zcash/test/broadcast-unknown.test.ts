import { describe, expect, it } from 'vitest'
import { BroadcastUnknownError, WalletManagerZcash, isAnsweredRefusal, parseTx, txid } from '../src/index.js'
import { SEED, fakeBlockchair } from './helpers.js'

// Audit 2026-10-25 round 3, M12 (Zcash part): a lost broadcast answer surfaced as a plain error — and
// Blockchair's transport even called a proxy's HTML 502 "Broadcast rejected", a final verdict the
// failover client did not retry — so the app read it as "not sent" and spent the coins again. Only a
// node's refusal stays an error; anything else is a BroadcastUnknownError with the txid computed
// before sending. In failover, a refusal after an endpoint that never answered is "maybe sent".

const RECIPIENT = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'
type Mode = 'throw' | 'html' | 'refuse' | 'known'
function node(mode: Mode | undefined) {
  const base = fakeBlockchair()
  const pushed: string[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (mode !== undefined && String(input).includes('push/transaction')) {
      pushed.push(decodeURIComponent(String(init?.body ?? '').replace(/^data=/, '')))
      const env = (error: string, status: number) => new Response(JSON.stringify({ data: null, context: { code: status, error } }), { status, headers: { 'content-type': 'application/json' } })
      if (mode === 'throw') throw new TypeError('fetch failed')
      if (mode === 'html') return new Response('<html>502 Bad Gateway</html>', { status: 502 })
      if (mode === 'refuse') return env('Invalid transaction. Error: bad-txns-inputs-spent', 400)
      return env('Invalid transaction. Error: txn-already-in-mempool', 400)
    }
    return base.fetchFn(input, init)
  }) as typeof fetch
  return { fetchFn, pushed }
}
const account = (fetchFn: typeof fetch, urls?: string[]) =>
  new WalletManagerZcash(SEED, { network: 'mainnet', client: urls ? urls.map((url) => ({ type: 'blockchair' as const, clientConfig: { url } })) : { type: 'blockchair' }, fetch: fetchFn }).getAccount(0)
const idOf = (raw: string) => txid(parseTx(raw))

describe('Zcash: a lost broadcast answer is "maybe sent", a refusal is not', () => {
  for (const mode of ['throw', 'html'] as const) {
    it(`${mode === 'throw' ? 'fetch throws' : 'an HTML 502'}: BroadcastUnknownError with the txid (transfer and sendTransaction)`, async () => {
      const n = node(mode)
      const a = await account(n.fetchFn)
      const e1 = await a.transfer({ recipient: RECIPIENT, amount: 60_000_000n }).then(() => null, (e: unknown) => e)
      expect(e1).toBeInstanceOf(BroadcastUnknownError)
      expect(e1).toMatchObject({ maybeSent: true, hash: idOf(n.pushed.at(-1)!) })
      const e2 = await a.sendTransaction({ to: RECIPIENT, value: 60_000_000n }).then(() => null, (e: unknown) => e)
      expect(e2).toMatchObject({ name: 'BroadcastUnknownError', hash: idOf(n.pushed.at(-1)!) })
    })
  }

  it('the node refusing stays a refusal', async () => {
    const e = await (await account(node('refuse').fetchFn)).transfer({ recipient: RECIPIENT, amount: 60_000_000n }).then(() => null, (x: unknown) => x)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
    expect(isAnsweredRefusal(e)).toBe(true)
  })

  it('"already in the mempool" means it is out: its txid is returned', async () => {
    const n = node('known')
    expect((await (await account(n.fetchFn)).transfer({ recipient: RECIPIENT, amount: 60_000_000n })).hash).toBe(idOf(n.pushed.at(-1)!))
  })

  it('failover: silent first, then refused → maybe sent; refused by all → refused', async () => {
    const silent = node('throw')
    const refuse = node('refuse')
    const route = (async (i: string | URL | Request, init?: RequestInit) => (String(i).includes('first') ? silent.fetchFn(i, init) : refuse.fetchFn(i, init))) as typeof fetch
    await expect((await account(route, ['https://first.example/zcash', 'https://second.example/zcash'])).transfer({ recipient: RECIPIENT, amount: 60_000_000n })).rejects.toBeInstanceOf(BroadcastUnknownError)
    const both = await (await account(refuse.fetchFn, ['https://a.example/zcash', 'https://b.example/zcash'])).transfer({ recipient: RECIPIENT, amount: 60_000_000n }).then(() => null, (x: unknown) => x)
    expect(both).not.toBeInstanceOf(BroadcastUnknownError)
    expect(isAnsweredRefusal(both)).toBe(true)
  })
})
