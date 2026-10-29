import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { remoteProvider } from '@anywalletkit/protocol-swap2-core/remote'
import type { CrossChainProvider, Quote, QuoteParams } from '@anywalletkit/protocol-swap2-core'
import { createServer } from '../src/server.ts'
import { upstreamsFromEnv } from '../src/main.ts'
import { swapsOverServer, walletOverServer } from '../src/client.ts'

const TOKEN = 'test-app-token'
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PARAMS: QuoteParams = {
  sourceChain: 'eip155:1', sourceToken: 'USDC', destChain: 'eip155:8453', destToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amountIn: '100000000', destAddress: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
}
// A deposit-address provider standing in for NEAR Intents: the app's stub is opened with nearIntentsPins.
const QUOTE: Quote = {
  provider: 'near_intents', intentId: 'i-1', depositAddress: '0x2222222222222222222222222222222222222222', depositMemo: null,
  sourceAmount: '100000000', destAmount: '99900000', minDestAmount: '99800000', feeUsd: 0.1, etaSeconds: 30,
  reliability: 0.97, validUntilMs: Date.now() + 600_000,
}
const mock: CrossChainProvider = {
  name: 'near_intents', enabled: () => true, supportsRoute: () => true,
  getQuote: async () => ({ ...QUOTE }),
  buildDeposit: async () => ({ chain: 'eip155:1', to: QUOTE.depositAddress, value: '0', data: '0x' }),
  trackIntent: async () => ({ state: 'completed' }),
}

/** Upstream RPCs: the first Ethereum node is down, the second answers; calls are recorded. */
const upstreamCalls: string[] = []
const upstreamFetch = (async (url: string, init: RequestInit) => {
  upstreamCalls.push(String(url))
  if (String(url).includes('down')) throw new Error('connect ECONNREFUSED')
  const req = JSON.parse(String(init.body)) as { id: number; method: string }
  const result = req.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x1'
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

let server: Server
let base = ''
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

beforeAll(async () => {
  server = createServer({
    providers: [mock],
    upstreams: { 'eip155:1': ['https://down.example/key/SECRET', 'https://eth.example/key/SECRET'], 'eip155:8453': ['https://dead.down/key/SECRET'] },
    sealSecret: 'test-seal-secret-that-is-at-least-32-bytes-long',
    apiToken: TOKEN,
    allowedOrigin: 'https://wallet.example',
    limits: { live: 3, display: 100, status: 100, rpc: 100 },
    fetchImpl: upstreamFetch,
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('reference server (docs: Ship a wallet)', () => {
  it('health, auth and CORS', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true })
    expect((await post('/swap2/quote', { provider: 'near_intents', params: PARAMS }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await post('/rpc/eip155:1', { jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { 'content-type': 'application/json' })).status).toBe(401)
    expect((await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    const pre = await fetch(`${base}/swap2/quote`, { method: 'OPTIONS', headers: { origin: 'https://wallet.example' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://wallet.example')
  })

  it('swap2 over HTTP through the real remoteProvider: sealed quote → build → track; a tampered quote is refused', async () => {
    const client = remoteProvider({ name: 'near_intents', baseUrl: `${base}/swap2`, headers: { authorization: `Bearer ${TOKEN}` }, allowInsecureBaseUrl: true }) // the local test server
    const quote = await client.getQuote(PARAMS)
    expect(quote?.providerData?.__remoteSeal).toMatch(/^[0-9a-f]{64}$/)
    expect((await client.buildDeposit(quote!)).to).toBe(QUOTE.depositAddress)
    expect(quote!.intentId).toMatch(/^i-1~[0-9a-f]{32}$/) // the server's intent token rides on the id
    expect(await client.trackIntent({ intentId: quote!.intentId })).toEqual({ state: 'completed' })
    await expect(client.trackIntent({ intentId: 'i-1' })).rejects.toThrow(/403/)
    await expect(client.buildDeposit({ ...quote!, minDestAmount: '1' })).rejects.toThrow(/400 .*integrity/)
  })

  it('rate-limits live quotes per caller', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await post('/swap2/quote', { provider: 'near_intents', params: PARAMS })).status)
    expect(statuses).toContain(429) // the bucket is 3 per minute and the round-trip test used one
  })

  it('RPC proxy: allowlisted methods fail over between upstreams; signing and admin methods are refused; errors carry no URL', async () => {
    const ok = await post('/rpc/eip155:1', { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] })
    expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 7, result: '0x1' })
    expect(upstreamCalls.slice(-2)).toEqual(['https://down.example/key/SECRET', 'https://eth.example/key/SECRET'])
    for (const method of ['eth_sign', 'personal_sign', 'eth_sendTransaction', 'admin_peers', 'debug_traceTransaction']) {
      expect((await post('/rpc/eip155:1', { jsonrpc: '2.0', id: 1, method })).status).toBe(403)
    }
    expect((await post('/rpc/eip155:1', Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_chainId' })))).status).toBe(400)
    expect((await post('/rpc/eip155:10', { jsonrpc: '2.0', id: 1, method: 'eth_chainId' })).status).toBe(404)
    const dead = await post('/rpc/eip155:8453', { jsonrpc: '2.0', id: 1, method: 'eth_chainId' })
    expect(dead.status).toBe(502)
    expect(await dead.text()).not.toContain('SECRET')
  })

  it('the app side: a Wallet whose EVM accounts read through the proxy', async () => {
    const wallet = walletOverServer(PHRASE, base, TOKEN)
    const account = await wallet.getAccount('eip155:1')
    expect(await account.getAddress()).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    expect(await account.getBalance()).toBe(10n ** 18n)
    wallet.dispose()
  })

  it('the app side: the router quotes through the server (sealed quote, local validation)', async () => {
    const wallet = walletOverServer(PHRASE, base, TOKEN)
    const account = await wallet.getAccount('eip155:1')
    const swaps = swapsOverServer(account, base, TOKEN, ['near_intents'])
    const quote = await swaps.quoteSwap2({
      fromToken: 'USDC', toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', toChain: 'eip155:8453',
      fromTokenAmount: 100_000_000n, recipient: await account.getAddress(),
    })
    expect(quote.toTokenAmountMin).toBe(99_800_000n)
    wallet.dispose()
  })

  it('env config: RPC_<NAMESPACE>_<REFERENCE> lists become upstreams', () => {
    expect(upstreamsFromEnv({ RPC_EIP155_8453: 'https://a, https://b', RPC_SOLANA_MAINNET: 'https://s', OTHER: 'x' })).toEqual({
      'eip155:8453': ['https://a', 'https://b'], 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': ['https://s'],
    })
  })
})
