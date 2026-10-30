import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { BroadcastUnknownError, WalletManagerTon } from '../src/index.js'
import { isAnsweredRefusal, tonCenterEndpoint } from '../src/toncenter.js'
import { fakeRpc } from './fake-rpc.js'

// Reaudit 2026-10-30, #2: any JSON error from an endpoint counted as the node's refusal, so a gateway's JSON 502 / 504
// after the node had taken a sendBoc surfaced as "not sent", and a retry paid twice. Only toncenter's refusal
// envelope (ok:false + a reason, not a timeout) is a refusal now; the rest is "maybe sent".

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
async function err(fetch: typeof globalThis.fetch) {
  try { await tonCenterEndpoint({ url: 'https://ton.example/api/v2/jsonRPC' }, { fetch }).call('sendBoc', { boc: 'x' }) } catch (e) { return e }
  throw new Error('no error')
}

describe('reaudit 2026-10-30 #2: only a node refusal is a refusal', () => {
  it('gateway JSON 502 / 503 / 504 / 408, an empty {} and a lite-server timeout are not refusals', async () => {
    expect(isAnsweredRefusal(await err(reply(502, { error: 'bad gateway' })))).toBe(false)
    expect(isAnsweredRefusal(await err(reply(503, { ok: false, error: 'unavailable' })))).toBe(false)
    expect(isAnsweredRefusal(await err(reply(504, { message: 'upstream timeout' })))).toBe(false)
    expect(isAnsweredRefusal(await err(reply(408, {})))).toBe(false)
    expect(isAnsweredRefusal(await err(reply(200, {})))).toBe(false)
    expect(isAnsweredRefusal(await err(reply(500, { ok: false, error: 'LITE_SERVER_UNKNOWN: timeout for adnl query', code: 500 })))).toBe(false)
  })

  it("toncenter's refusals (as read live) stay refusals, and so does a rate limit", async () => {
    expect(isAnsweredRefusal(await err(reply(500, { ok: false, error: 'INVALID_BAG_OF_CELLS: bodycannot deserialize bag-of-cells: invalid header, error 0', code: 500 })))).toBe(true)
    expect(isAnsweredRefusal(await err(reply(500, { ok: false, error: 'LITE_SERVER_UNKNOWN: cannot apply external message to current state : external message was not accepted', code: 500 })))).toBe(true)
    expect(isAnsweredRefusal(await err(reply(429, { ok: false, error: 'Ratelimit exceed', code: 429 })))).toBe(true)
  })

  it('a transfer answered by a JSON 502 is a BroadcastUnknownError carrying the hash', async () => {
    const base = fakeRpc()
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { method?: string } : {}
      if (body.method === 'sendBoc') return new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502, headers: { 'content-type': 'application/json' } })
      return base.fetch(input, init)
    }) as typeof globalThis.fetch
    const a = await new WalletManagerTon(SEED, { tonClient: [{ url: 'http://fake/api/v2/jsonRPC' }], fetch: f, simulate: false }).getAccount(0)
    const e = await a.transfer({ recipient: RECIPIENT, amount: 1n }).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(BroadcastUnknownError)
    expect(e).toMatchObject({ maybeSent: true })
    expect((e as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
