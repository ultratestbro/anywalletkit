import { beforeEach, describe, expect, it } from 'vitest'
import { HistoryUnavailableError, createEvmHistory, resetEtherscanChainlistCache, resetSharedBuckets } from '../src/index.js'
import { ADDRESS, fakeFetch } from './helpers.js'

beforeEach(() => {
  resetEtherscanChainlistCache()
  resetSharedBuckets()
})

describe('failover', () => {
  it('retries once after an Etherscan rate-limit answer, then succeeds', async () => {
    const fetch = fakeFetch({
      etherscanIntercept: (_url, n) => (n === 1 ? { status: '0', message: 'NOTOK', result: 'Max rate limit reached, please use API Key for higher rate limit' } : undefined),
    })
    const src = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch, rateLimit: 1000, etherscanCompatUrl: null })
    const page = await src.listActivity(ADDRESS, { limit: 20 })
    expect(page.backend).toBe('etherscan')
    expect(fetch.etherscanCalls).toBe(4) // txlist (rate limited) + retry + tokentx + internal
  })

  it('falls back to Blockscout when Etherscan refuses the plan ("Free API access is not supported")', async () => {
    const fetch = fakeFetch({ etherscanIntercept: () => ({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' }) })
    const src = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch, rateLimit: 1000, blockscoutUrl: 'https://bs.example', etherscanCompatUrl: null })
    const page = await src.listActivity(ADDRESS, { limit: 20 })
    expect(page.backend).toBe('blockscout')
    expect(fetch.etherscanCalls).toBe(1) // not retried: this is not a rate limit
    expect(fetch.blockscoutCalls).toBeGreaterThan(0)
  })

  it('falls back to Blockscout on persistent HTTP 5xx / 429 and on an invalid key', async () => {
    for (const intercept of [
      () => ({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }),
      () => ({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }),
    ]) {
      resetSharedBuckets()
      const fetch = fakeFetch({ etherscanIntercept: intercept })
      const src = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch, rateLimit: 1000, blockscoutUrl: 'https://bs.example', etherscanCompatUrl: null })
      const page = await src.listActivity(ADDRESS, { limit: 20 })
      expect(page.backend).toBe('blockscout')
    }
  })

  it('a cursor from one backend resumes on another by block window', async () => {
    const good = fakeFetch()
    const first = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch: good, rateLimit: 1000, blockscoutUrl: 'https://bs.example', etherscanCompatUrl: null })
    const p1 = await first.listActivity(ADDRESS, { limit: 10 })
    expect(p1.backend).toBe('etherscan')
    expect(p1.cursor).toBeDefined()
    const broken = fakeFetch({ etherscanIntercept: () => ({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }) })
    resetEtherscanChainlistCache()
    const second = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch: broken, rateLimit: 1000, blockscoutUrl: 'https://bs.example', etherscanCompatUrl: null })
    const p2 = await second.listActivity(ADDRESS, { limit: 10, cursor: p1.cursor! })
    expect(p2.backend).toBe('blockscout')
    const minP1 = Math.min(...p1.items.map((i) => Number(i.block)))
    expect(p2.items.length).toBeGreaterThan(0)
    for (const it of p2.items) expect(Number(it.block)).toBeLessThan(minP1)
    expect(new Set([...p1.items, ...p2.items].map((i) => i.hash)).size).toBe(p1.items.length + p2.items.length)
  })

  it('throws HistoryUnavailableError naming chain and every attempt when all backends fail', async () => {
    const fetch = fakeFetch({
      etherscanIntercept: () => ({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }),
      blockscoutIntercept: () => ({ status: 503, body: { message: 'down' } }),
    })
    const src = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch, rateLimit: 1000, blockscoutUrl: 'https://bs.example', etherscanCompatUrl: null })
    const err = await src.listActivity(ADDRESS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HistoryUnavailableError)
    const e = err as HistoryUnavailableError
    expect(e.name).toBe('HistoryUnavailableError')
    expect(e.chain).toBe('eip155:1')
    expect(e.attempts).toHaveLength(2)
    expect(e.attempts[0]).toMatch(/^etherscan: .*Invalid API Key/)
    expect(e.attempts[1]).toMatch(/^blockscout: .*HTTP 503/)
    expect(e.message).toContain('eip155:1')
  })
})

describe('chains without a usable backend', () => {
  it('Base without a key: no keyless explorer → HistoryUnavailableError with the reason', async () => {
    const fetch = fakeFetch()
    const src = createEvmHistory({ chainId: 8453, fetch })
    await expect(src.listActivity(ADDRESS)).rejects.toThrow(/no keyless explorer.*etherscanApiKey/)
    expect(fetch.calls).toHaveLength(0)
  })

  it('a key for a chain the Etherscan chainlist does not serve and no Blockscout → clear reason', async () => {
    const fetch = fakeFetch({ chainlist: [1] })
    const src = createEvmHistory({ chainId: 8453, etherscanApiKey: 'k', fetch })
    await expect(src.listActivity(ADDRESS)).rejects.toThrow(/does not serve chain 8453.*blockscoutUrl/)
  })

  it('X Layer (196): empty page with a note, no requests, getTransaction undefined', async () => {
    const fetch = fakeFetch()
    const src = createEvmHistory({ chainId: 196, etherscanApiKey: 'k', fetch })
    const page = await src.listActivity(ADDRESS)
    expect(page.items).toEqual([])
    expect(page.note).toMatch(/no public explorer API/)
    expect(await src.getTransaction('0x' + '0'.repeat(64), ADDRESS)).toBeUndefined()
    expect(src.explorerTxUrl('0xabc')).toBe('https://www.okx.com/web3/explorer/xlayer/tx/0xabc')
    expect(fetch.calls).toHaveLength(0)
  })

  it('the Etherscan chainlist falls back to the built-in table when it cannot be fetched', async () => {
    const fetch = fakeFetch({
      blockscoutIntercept: () => undefined,
    })
    const failing = ((input: string, init?: unknown) => (input.includes('chainlist') ? Promise.reject(new Error('offline')) : fetch(input, init as never))) as typeof fetch
    const src = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch: failing, rateLimit: 1000 })
    const page = await src.listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('etherscan')
  })

  it('prefer: blockscout puts Blockscout first even with a key', async () => {
    const fetch = fakeFetch()
    const src = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch, blockscoutUrl: 'https://bs.example', prefer: 'blockscout', etherscanCompatUrl: null })
    const page = await src.listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('blockscout')
    expect(fetch.etherscanCalls).toBe(0)
  })
})
