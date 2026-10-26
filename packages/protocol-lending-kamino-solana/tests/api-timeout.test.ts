import { describe, expect, it } from 'vitest'
import { KaminoApi, KaminoMarketProtocolSolana } from '../src/index.js'

// Audit 2026-10-25 round 3, M32 (Kamino part): API calls had no timeout; a silent API hung every
// read and every write's build step for as long as the socket stayed open.
describe('Kamino API timeout', () => {
  it('a call the API never answers fails after timeoutMs, and the fetch gets an abort signal', async () => {
    let signal: AbortSignal | undefined
    const hanging = ((_url: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}) }) as unknown as typeof fetch
    const api = new KaminoApi(undefined, hanging, 50)
    const started = Date.now()
    await expect(api.listMarkets()).rejects.toThrow(/did not answer within 50 ms/)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('the protocol passes its timeoutMs to the client it builds', async () => {
    const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const p = new KaminoMarketProtocolSolana({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', getAddress: async () => '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC' } as never, { fetch: hanging, timeoutMs: 40 })
    await expect(p.api.listMarkets()).rejects.toThrow(/did not answer within 40 ms/)
  })
})
