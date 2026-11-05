import { afterEach, describe, expect, it, vi } from 'vitest'
import { APY_TOLERANCE, CurveApi, ScrvUsdProtocolEvm, aprWadToApyPct, assertCurveHost, clampApy, scrvUsdAprWad } from '../src/index.js'
import { account, makeScrvUsd } from './fixture.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Live on 2026-11-05 (Ethereum block 26 350 290): the API answered proj_apy 6.27686 at block 26 350 308.
const LIVE = { profitUnlockingRate: 25_953_163_264_686_406_615_740_034_288n, fullProfitUnlockDate: 1_794_304_075n, totalSupply: 13_452_475_871_734_876_233_205_548n, now: 1_793_944_847n }

const stubApi = (body: unknown, status = 200) => {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return new Response(JSON.stringify(body), { status }) })
  return urls
}

describe('on-chain projection', () => {
  it('APR = profitUnlockingRate / 1e12 × year / totalSupply, APY = e^APR − 1: the live state gives the API figure', () => {
    const apr = scrvUsdAprWad(LIVE)
    expect(apr).toBe((LIVE.profitUnlockingRate * 31_536_000n * 10n ** 18n) / (10n ** 12n * LIVE.totalSupply))
    expect(Number(apr.toString()) / 1e16).toBeCloseTo(6.084, 2) // APR 6.08 % (a bounded WAD fraction: exact as a Number)
    expect(aprWadToApyPct(apr)).toBeCloseTo(6.2769, 2)
  })

  it('is 0 once the profit has fully unlocked (nothing unlocks until the next report), and with no supply', () => {
    expect(scrvUsdAprWad({ ...LIVE, now: LIVE.fullProfitUnlockDate })).toBe(0n)
    expect(scrvUsdAprWad({ ...LIVE, totalSupply: 0n })).toBe(0n)
    expect(aprWadToApyPct(0n)).toBe(0)
  })
})

describe('clampApy (the API only decorates, bounded by the chain)', () => {
  it('keeps an API figure inside the band, clamps one outside, falls back without one', () => {
    expect(clampApy(6.3, 6.27)).toEqual({ apy: 6.3, source: 'api' })
    expect(clampApy(60, 6.27)).toEqual({ apy: 6.27 + Math.max(APY_TOLERANCE.absolutePct, 0.627), source: 'api-clamped' })
    expect(clampApy(0, 6.27)).toEqual({ apy: 6.27 - 0.627, source: 'api-clamped' })
    expect(clampApy(null, 6.27)).toEqual({ apy: 6.27, source: 'chain' })
    expect(clampApy(Number.NaN, 6.27)).toEqual({ apy: 6.27, source: 'chain' })
    // Near zero the absolute tolerance governs and the band never goes negative.
    expect(clampApy(3, 0)).toEqual({ apy: 0.5, source: 'api-clamped' })
    expect(clampApy(-1, 0)).toEqual({ apy: 0, source: 'api-clamped' })
  })
})

describe('getApy / getApyDetails', () => {
  const make = (config: Record<string, unknown> = {}) => {
    const { chain } = makeScrvUsd()
    chain.block = { number: 26_350_290n, timestamp: LIVE.now }
    return new ScrvUsdProtocolEvm(account(), { provider: chain.provider, ...config })
  }

  it('shows the API figure when it agrees with the chain, read at one block', async () => {
    const urls = stubApi({ last_updated: '2026-11-05T18:04:47', last_updated_block: 26350308, proj_apy: 6.276860122982786, supply: 13452470.265851611 })
    const d = await make().getApyDetails()
    expect(urls).toEqual(['https://prices.curve.finance/v1/crvusd/savings/statistics'])
    expect(d).toMatchObject({ source: 'api', apy: 6.276860122982786, apiApy: 6.276860122982786, block: 26_350_290n, unlockingUntil: LIVE.fullProfitUnlockDate })
    expect(d.chainApy).toBeCloseTo(6.2769, 2)
  })

  it('clamps an inflated API figure to the on-chain band', async () => {
    stubApi({ proj_apy: 42 })
    const d = await make().getApyDetails()
    expect(d.source).toBe('api-clamped')
    expect(d.apy).toBeCloseTo(d.chainApy + Math.max(0.5, d.chainApy * 0.1), 9)
  })

  it('falls back to the chain when the API fails, answers garbage, or is disabled', async () => {
    stubApi({ error: 'down' }, 503)
    expect((await make().getApyDetails()).source).toBe('chain')
    stubApi({ proj_apy: '6.3' })
    expect((await make().getApyDetails()).source).toBe('chain')
    vi.unstubAllGlobals()
    const noFetch = vi.fn()
    vi.stubGlobal('fetch', noFetch)
    const d = await make({ api: null }).getApyDetails()
    expect(d.source).toBe('chain')
    expect(noFetch).not.toHaveBeenCalled()
    expect(await make({ api: null }).getApy()).toBeCloseTo(6.2769, 2)
  })

  it('an API that never answers gives up within the timeout', { timeout: 5_000 }, async () => {
    const asked: number[] = []
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { asked.push(ms); return real(50) })
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)) }))
    expect(await make().getStats()).toBeNull()
    expect(asked).toEqual([15_000])
  })
})

describe('API host allowlist', () => {
  it('accepts https on curve.finance and its subdomains only', () => {
    expect(assertCurveHost('https://prices.curve.finance/')).toBe('https://prices.curve.finance')
    expect(new CurveApi('https://api.curve.finance').endpoint).toBe('https://api.curve.finance')
    expect(assertCurveHost('https://Prices.Curve.Finance/v1/')).toBe('https://prices.curve.finance/v1')
    for (const bad of ['https://prices.curve.fi', 'http://prices.curve.finance', 'https://evilcurve.finance', 'https://prices.curve.finance.example.com', 'https://user@prices.curve.finance', 'https://prices.curve.finance:8443', 'https://evil.com#.curve.finance', 'not a url']) {
      expect(() => assertCurveHost(bad), bad).toThrow(/curve\.finance|must be a URL/)
    }
  })

  it('refuses a foreign API host at construction', () => {
    const { chain } = makeScrvUsd()
    expect(() => new ScrvUsdProtocolEvm(account(), { provider: chain.provider, api: 'https://prices.curve.fi' })).toThrow(expect.objectContaining({ code: 'ApiHostRefused' }))
  })
})
