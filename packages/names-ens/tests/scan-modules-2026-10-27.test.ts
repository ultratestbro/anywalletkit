// Scan 2026-10-27 (modules), F37: the ENS client used viem's default CCIP-Read, so a name's offchain resolver chose
// URLs the user's device fetched (http, LAN, cloud metadata), and getEnsAvatar fetched whatever an avatar record or an
// NFT's metadata named. Now gateways are https on a public host only, redirects are refused, and the avatar is the
// record itself, filtered. A fetch double stands in for the network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, custom, encodeErrorResult, parseAbi, type Hex } from 'viem'
import { mainnet } from 'viem/chains'
import { EnsNameError, avatarUrl, ensCcipRead, ensCcipRequest, ensResolver } from '../src/index.js'

afterEach(() => vi.unstubAllGlobals())

const SENDER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63' as const
const CALLDATA = '0x9061b923' as Hex
const OFFCHAIN_LOOKUP = parseAbi(['error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)'])
const PRIVATE_GATEWAYS = [
  'http://192.168.1.1/{sender}/{data}.json', 'http://gateway.example/{sender}/{data}.json', 'https://127.1/{data}', 'https://2130706433/{data}',
  'https://[::ffff:127.0.0.1]/{data}', 'https://169.254.169.254/latest/meta-data/{data}', 'https://100.64.0.1/{data}', 'https://router.local/{data}',
  'https://{data}.example/x', 'https://user:pw@gateway.example/{data}',
]

/** Records every URL fetched; answers a gateway with `answer` (and optionally as a redirect to `redirectedTo`). */
function network(answer: { status?: number; body?: unknown; redirectedTo?: string } = {}) {
  const fetched: Array<{ url: string; method: string; redirect?: string; body?: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    fetched.push({ url: String(url), method: init.method ?? 'GET', ...(init.redirect ? { redirect: init.redirect } : {}), ...(typeof init.body === 'string' ? { body: init.body } : {}) })
    const res = new Response(JSON.stringify(answer.body ?? { data: '0xabcdef' }), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    if (answer.redirectedTo) Object.defineProperty(res, 'url', { value: answer.redirectedTo })
    return res
  }))
  return fetched
}

describe('ENS CCIP-Read asks only https gateways on public hosts (scan 2026-10-27 modules, F37)', () => {
  it('http://192.168.1.1/… and every other private or plain-http gateway is refused without a request', async () => {
    const fetched = network()
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: PRIVATE_GATEWAYS })).rejects.toThrow(EnsNameError)
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: PRIVATE_GATEWAYS })).rejects.toThrow(/not https on a public host; it was not asked/)
    expect(fetched).toEqual([])
  })

  it('a public https gateway is asked the way EIP-3668 says (GET with {data}, POST otherwise), redirects refused', async () => {
    const fetched = network()
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['http://192.168.1.1/{data}', 'https://gw.example/{sender}/{data}.json'] })).toBe('0xabcdef')
    expect(await ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/lookup'] })).toBe('0xabcdef')
    expect(fetched).toEqual([
      { url: `https://gw.example/${SENDER.toLowerCase()}/${CALLDATA}.json`, method: 'GET', redirect: 'error' },
      { url: 'https://gw.example/lookup', method: 'POST', redirect: 'error', body: JSON.stringify({ data: CALLDATA, sender: SENDER }) },
    ])
    network({ redirectedTo: 'http://192.168.1.1/admin' }) // a runtime that followed the redirect anyway (React Native)
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] })).rejects.toThrow(/redirected; the answer was not used/)
    network({ body: { data: 'not hex' } })
    await expect(ensCcipRequest({ data: CALLDATA, sender: SENDER, urls: ['https://gw.example/{data}'] })).rejects.toThrow(/not hex data/)
  })

  it("end to end: viem's default fetches the LAN gateway a resolver names; ensCcipRead and the resolver built from rpcUrl do not", async () => {
    const LAN = 'http://192.168.1.1/{sender}/{data}.json'
    const lookupFrom = (to: string) => encodeErrorResult({ abi: OFFCHAIN_LOOKUP, errorName: 'OffchainLookup', args: [to as Hex, [LAN], CALLDATA, '0x12345678', '0x'] })
    /** eth_call: the callback (0x12345678…) succeeds, anything else reverts with an OffchainLookup whose sender is the callee. */
    const answer = (method: string, params: unknown): unknown => {
      if (method === 'eth_chainId') return { result: '0x1' }
      const call = (params as Array<{ to: string; data: string }>)[0]!
      if (call.data.startsWith('0x12345678')) return { result: '0x' + '00'.repeat(32) }
      return { error: { code: 3, message: 'execution reverted', data: lookupFrom(call.to) } }
    }
    const transport = custom({ async request ({ method, params }) { const a = answer(method, params) as { result?: unknown; error?: object }; if (a.error) throw Object.assign(new Error('execution reverted'), a.error); return a.result } }, { retryCount: 0 })
    for (const [ccip, lanFetched] of [[undefined, true], [ensCcipRead, false]] as const) {
      const fetched = network()
      const client = createPublicClient({ chain: mainnet, transport, ...(ccip ? { ccipRead: ccip } : {}) })
      const err = await client.call({ to: SENDER, data: CALLDATA }).then(() => null, (e: Error) => e)
      expect(fetched.some((f) => f.url.startsWith('http://192.168.1.1/'))).toBe(lanFetched)
      if (ccip) expect(err?.name).toBe('OffchainLookupError') // the lookup reached ensCcipRequest, which asked nobody
    }
    // The resolver's own client (rpcUrl): JSON-RPC to the RPC URL only, and the refusal is the filter's.
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.push(String(url))
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown } | Array<{ id: number; method: string; params: unknown }>
      const one = (r: { id: number; method: string; params: unknown }) => ({ jsonrpc: '2.0', id: r.id, ...(answer(r.method, r.params) as object) })
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } })
    }))
    const failure = await ensResolver({ rpcUrl: 'https://rpc.example/v2/key' }).resolve('vitalik.eth', 'eip155:1').then(() => null, (e: Error) => e)
    expect(failure).toBeInstanceOf(Error)
    const chain: string[] = []
    for (let e: unknown = failure, i = 0; e && i < 10; e = (e as { cause?: unknown }).cause, i++) chain.push(String((e as Error).message))
    expect(chain.join(' | ')).toMatch(/not https on a public host; it was not asked/)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((u) => u === 'https://rpc.example/v2/key')).toBe(true)
  })
})

describe('avatars are the record, filtered — nothing is fetched to decide (scan 2026-10-27 modules, F37)', () => {
  it('https on a public host as written, ipfs through the gateway, anything else null', () => {
    expect(avatarUrl('https://example.org/v.png')).toBe('https://example.org/v.png')
    expect(avatarUrl(' ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a.png ', 'https://gw.example/ipfs/')).toBe('https://gw.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a.png')
    for (const r of ['http://example.org/v.png', 'https://192.168.1.1/v.png', 'https://169.254.169.254/latest', 'https://[::1]/a', 'data:image/svg+xml;base64,PHN2Zz4=',
      'eip155:1/erc721:0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB/1', 'ipfs://../../etc', null, '', 'https://' + 'a'.repeat(3000) + '.example/']) {
      expect(avatarUrl(r as string | null), String(r).slice(0, 60)).toBeNull()
    }
  })

  it('the resolver reads the avatar text record and filters it; viem\'s getEnsAvatar is not called', async () => {
    const getEnsAvatar = vi.fn()
    const getEnsText = vi.fn(async ({ name }: { name: string }) => ({ 'a.eth': 'https://192.168.1.1/x.png', 'b.eth': 'https://example.org/b.png' } as Record<string, string>)[name] ?? null)
    const r = ensResolver({ client: { getEnsText, getEnsAvatar } as never })
    expect(await r.avatar!('a.eth')).toBeNull()
    expect(await r.avatar!('b.eth')).toBe('https://example.org/b.png')
    expect(getEnsAvatar).not.toHaveBeenCalled()
  })
})
