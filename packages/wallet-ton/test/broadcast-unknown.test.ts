import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { Cell, loadMessage } from '@ton/core'
import { NetworkError } from '@anywalletkit/core'
import { BroadcastUnknownError, WalletManagerTon } from '../src/index.js'
import { fakeRpc } from './fake-rpc.js'

// Audit 2026-10-25 round 3, M12 (TON part): a broadcast whose answer was lost (a timeout, a dropped
// connection, a proxy's HTML 502) surfaced as a plain NetworkError, so an app read it as "not sent"
// and signed again — with the next seqno, paying twice. Only a node's explicit refusal ({ok:false})
// stays a NetworkError; anything else is a BroadcastUnknownError carrying the body hash to watch.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'

type SendFail = 'throw' | 'html' | 'refuse'
/** The fake node, except that sendBoc fails as asked; records the BoC that was handed over. */
function node(fail: SendFail | undefined) {
  const base = fakeRpc()
  const handed: Cell[] = []
  const f: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { method?: string; params?: { boc?: string } } : {}
    if (body.method === 'sendBoc' && fail !== undefined) {
      handed.push(Cell.fromBase64(body.params!.boc!))
      if (fail === 'throw') throw new TypeError('fetch failed')
      if (fail === 'html') return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
      return new Response(JSON.stringify({ ok: false, error: 'LITE_SERVER_UNKNOWN: cannot apply external message', code: 500 }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    return base.fetch(input, init)
  }) as typeof globalThis.fetch
  return { fetch: f, handed }
}
const bodyHash = (external: Cell) => loadMessage(external.beginParse()).body.hash().toString('hex')
async function account(fetch: typeof globalThis.fetch, endpoints: Array<{ url: string }> = [{ url: 'http://fake/api/v2/jsonRPC' }]) {
  return new WalletManagerTon(SEED, { tonClient: endpoints, fetch, simulate: false }).getAccount(0)
}

describe('TON: a lost broadcast answer is "maybe sent", a refusal is not', () => {
  for (const fail of ['throw', 'html'] as const) {
    it(`${fail === 'throw' ? 'fetch throws' : 'a non-JSON 502'}: BroadcastUnknownError with the body hash (transfer and sendTransaction)`, async () => {
      const n = node(fail)
      const a = await account(n.fetch)
      const e1 = await a.transfer({ recipient: RECIPIENT, amount: 1n }).then(() => null, (e: unknown) => e)
      expect(e1).toBeInstanceOf(BroadcastUnknownError)
      expect(e1).toMatchObject({ maybeSent: true, hash: bodyHash(n.handed.at(-1)!) })
      const e2 = await a.sendTransaction({ to: RECIPIENT, value: 1n }).then(() => null, (e: unknown) => e)
      expect(e2).toMatchObject({ name: 'BroadcastUnknownError', hash: bodyHash(n.handed.at(-1)!) })
    })
  }

  it('the node refusing ({ok:false}) stays a NetworkError', async () => {
    const a = await account(node('refuse').fetch)
    const e = await a.transfer({ recipient: RECIPIENT, amount: 1n }).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(NetworkError)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  })

  it('failover: refused by one endpoint, no answer from the other → maybe sent; refused by all → refused', async () => {
    const refuse = node('refuse')
    const silent = node('throw')
    const route = (async (i: string | URL | Request, init?: RequestInit) => (String(i).includes('first') ? refuse.fetch(i, init) : silent.fetch(i, init))) as typeof fetch
    const mixed = await account(route, [{ url: 'http://first/api/v2/jsonRPC' }, { url: 'http://second/api/v2/jsonRPC' }])
    await expect(mixed.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toBeInstanceOf(BroadcastUnknownError)
    const both = (async (i: string | URL | Request, init?: RequestInit) => refuse.fetch(i, init)) as typeof fetch
    const refused = await account(both, [{ url: 'http://first/api/v2/jsonRPC' }, { url: 'http://first2/api/v2/jsonRPC' }])
    const e = await refused.transfer({ recipient: RECIPIENT, amount: 1n }).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(NetworkError)
    expect(e).not.toBeInstanceOf(BroadcastUnknownError)
  })
})
