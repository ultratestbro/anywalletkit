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

describe('Blockscout PRO backend', () => {
  const ADDRESS = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
  const empty = { status: '0', message: 'No transactions found', result: [] }
  function proFetch(seen: string[]) {
    return async (url: string) => {
      seen.push(url)
      if (url.includes('api.etherscan.io')) return { ok: true, status: 200, json: async () => ({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain' }), text: async () => '' }
      if (url.includes('api.blockscout.com')) return { ok: true, status: 200, json: async () => empty, text: async () => '' }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    }
  }
  it('serves a paid-only Etherscan chain (Base) through the PRO key with chain_id= and apikey=', async () => {
    const seen: string[] = []
    const src = createEvmHistory({ chainId: 8453, etherscanApiKey: 'free', blockscoutProApiKey: 'proapi_x', fetch: proFetch(seen) as never, rateLimit: 1000, blockscoutProRateLimit: 1000 })
    const page = await src.listActivity(ADDRESS)
    expect(page.backend).toBe('blockscout-pro')
    const pro = seen.find((u) => u.includes('api.blockscout.com'))!
    expect(pro).toContain('chain_id=8453')
    expect(pro).toContain('apikey=proapi_x')
    expect(pro).not.toContain('chainid=')
  })
  it('X Layer is no longer short-circuited when a PRO key is set', async () => {
    const seen: string[] = []
    const src = createEvmHistory({ chainId: 196, blockscoutProApiKey: 'proapi_x', fetch: proFetch(seen) as never, blockscoutProRateLimit: 1000 })
    const page = await src.listActivity(ADDRESS)
    expect(page.backend).toBe('blockscout-pro')
    expect(seen.some((u) => u.includes('chain_id=196'))).toBe(true)
  })
  it('an "Unauthorized" PRO answer is classified unavailable and falls through', async () => {
    const fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('api.blockscout.com') ? { error: 'Unauthorized' } : empty), text: async () => '' })
    const src = createEvmHistory({ chainId: 1, blockscoutProApiKey: 'bad', fetch: fetch as never, blockscoutProRateLimit: 1000 })
    const page = await src.listActivity(ADDRESS)
    expect(page.backend).toBe('routescan')
  })
})

// Elysium 99901 (2026-11-10): the explorer's Blockscout `/api/v2` is behind a Vercel bot checkpoint; its Etherscan-format
// `/api` answers keyless. Blockscout names the empty lists ("No internal transactions found", "No token transfers found").
describe('Elysium: keyless Etherscan-format Blockscout API', () => {
  const ADDRESS = '0x64c1442f63a85cd6eb443f086413422aa27ba1a4'
  const TX = {
    blockNumber: '3521004', timeStamp: '1794259910', hash: '0x7c7c4b3ce1' + '0'.repeat(54), nonce: '3', blockHash: '0x' + '1'.repeat(64), transactionIndex: '1',
    from: ADDRESS, to: '0xba876237b0f021a6c6d852d6c26e107997cc5e81', value: '303930000000000000', gas: '60000', gasPrice: '500000000', isError: '0',
    txreceipt_status: '1', input: '0xd0e30db0', contractAddress: '', cumulativeGasUsed: '58718', gasUsed: '45000', confirmations: '10', methodId: '0xd0e30db0', functionName: 'deposit()',
  }
  it('lists through https://elysium.kinetiq.xyz/api with no key, chain id or apikey, and links to the explorer root', async () => {
    const seen: string[] = []
    const fetch = async (url: string) => {
      seen.push(url)
      const action = new URL(url).searchParams.get('action')
      const body = action === 'txlist' ? { status: '1', message: 'OK', result: [TX] }
        : action === 'tokentx' ? { status: '0', message: 'No token transfers found', result: [] }
        : { status: '0', message: 'No internal transactions found', result: [] }
      return { ok: true, status: 200, json: async () => body, text: async () => '' }
    }
    const src = createEvmHistory({ chainId: 99901, fetch: fetch as never })
    const page = await src.listActivity(ADDRESS, { limit: 10 })
    expect(page.backend).toBe('routescan') // the keyless Etherscan-format client
    expect(page.items.map((i) => i.hash)).toEqual([TX.hash])
    expect(seen.length).toBe(3)
    for (const u of seen) {
      expect(u.startsWith('https://elysium.kinetiq.xyz/api?')).toBe(true)
      expect(u).not.toMatch(/chainid=|chain_id=|apikey=/)
    }
    expect(src.explorerTxUrl('0x1')).toBe('https://elysium.kinetiq.xyz/tx/0x1')
  })
  it('an address with no history is an empty page, not an unavailable backend', async () => {
    const fetch = async (url: string) => {
      const action = new URL(url).searchParams.get('action')
      const message = action === 'txlist' ? 'No transactions found' : action === 'tokentx' ? 'No token transfers found' : 'No internal transactions found'
      return { ok: true, status: 200, json: async () => ({ status: '0', message, result: [] }), text: async () => '' }
    }
    const page = await createEvmHistory({ chainId: 99901, fetch: fetch as never }).listActivity(ADDRESS)
    expect(page.items).toEqual([])
    expect(page.cursor).toBeUndefined()
  })
})
