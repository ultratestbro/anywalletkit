import { beforeEach, describe, expect, it } from 'vitest'
import { createEvmHistory, decodeCursor, resetEtherscanChainlistCache, resetSharedBuckets } from '../src/index.js'
import { ADDRESS, fakeFetch, fixture } from './helpers.js'

const THOR = '0x26f9c864902f7867bf9d042b142df28d1d811e0cb66106dd3b12124bbee51fc4'

beforeEach(() => {
  resetEtherscanChainlistCache()
  resetSharedBuckets()
})

const bs = (fetch: ReturnType<typeof fakeFetch>) => createEvmHistory({ chainId: 1, fetch, blockscoutUrl: 'https://eth.blockscout.example', etherscanCompatUrl: null })

describe('Blockscout v2 mapping (eth.blockscout.com fixtures, 2026-10-14)', () => {
  it('keyless source goes straight to Blockscout and never touches Etherscan', async () => {
    const fetch = fakeFetch()
    const page = await bs(fetch).listActivity(ADDRESS, { limit: 50 })
    expect(page.backend).toBe('blockscout')
    expect(fetch.etherscanCalls).toBe(0)
    expect(fetch.calls.some((c) => c.url.includes('chainlist'))).toBe(false)
    expect(fetch.calls.some((c) => c.url.includes('/api/v2/addresses/' + ADDRESS + '/token-transfers?type=ERC-20'))).toBe(true)
    expect(page.items.length).toBeGreaterThan(0)
  })

  it('maps a transaction item: fee.value, ISO timestamp, raw_input selector, status ok', async () => {
    const page = await bs(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const tx = page.items.find((i) => i.hash === THOR)!
    expect(tx).toBeDefined()
    expect(tx.status).toBe('confirmed')
    expect(tx.block).toBe(26159725n)
    expect(tx.time).toBe(Math.floor(Date.parse('2026-10-10T04:45:11Z') / 1000))
    expect(tx.fee).toBe(7702362388952n)
    expect(tx.from).toBe(ADDRESS)
    expect(tx.to).toBe('0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146')
    expect(tx.call).toMatchObject({ to: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146', selector: '0x44bc937b' })
    expect(tx.raw.source).toBe('blockscout')
    expect(tx.spam).toBeUndefined()
  })

  it('token-transfer items merge into their tx with symbol/decimals from the token object', async () => {
    const page = await bs(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const items = fixture<{ items: { transaction_hash: string; token: { symbol: string }; total: { value: string } }[] }>('blockscout-eth-token-transfers.json').items
    const usdt = items.find((i) => i.token.symbol === 'USDT')!
    const tx = page.items.find((i) => i.hash === usdt.transaction_hash)!
    expect(tx).toBeDefined()
    const t = tx.transfers.find((x) => x.symbol === 'USDT')!
    expect(t).toMatchObject({ standard: 'erc20', decimals: 6, token: '0xdac17f958d2ee523a2206206994597c13d831ec7', amount: BigInt(usdt.total.value) })
  })

  it('look-alike "U⁯S⁯DΤ" dust from an unknown contract is spam (symbol-impersonation)', async () => {
    const page = await bs(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const spoof = page.items.filter((i) => i.transfers.some((t) => t.token === '0x6d2dc43dfe2092216566259b2ddf04bdbfc4c17f'))
    expect(spoof.length).toBeGreaterThan(0)
    for (const s of spoof) {
      expect(s.spam).toBe(true)
      expect(s.raw.spamReason).toBe('symbol-impersonation')
      expect(s.raw.tx).toBeUndefined()
    }
  })

  it('internal-transactions add native legs', async () => {
    const page = await bs(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const tx = page.items.find((i) => i.hash === '0xa20c6a8add0063242073e0014ab8fabcdad49d3f503dcd5970cd64797d8643fc')!
    expect(tx).toBeDefined()
    expect(tx.transfers.some((t) => t.token === null && t.amount === 989089680023743n && t.to === ADDRESS)).toBe(true)
    expect(tx.raw.internal).toHaveLength(1)
  })

  it('pages with next_page_params per list and the block window; union is complete and duplicate-free', async () => {
    const fetchAll = fakeFetch({ blockscoutPageSize: 200 })
    const all = await bs(fetchAll).listActivity(ADDRESS, { limit: 100 })
    expect(all.cursor).toBeUndefined()

    const fetch = fakeFetch({ blockscoutPageSize: 7 })
    const src = bs(fetch)
    const hashes: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await src.listActivity(ADDRESS, { limit: 7, ...(cursor ? { cursor } : {}) })
      pages++
      hashes.push(...page.items.map((i) => i.hash))
      cursor = page.cursor
      if (cursor) expect(decodeCursor(cursor).b).toBe('blockscout')
    } while (cursor && pages < 200)
    expect(pages).toBeGreaterThan(3)
    expect(hashes).toEqual(all.items.map((i) => i.hash))
  })

  it('getTransaction: detail + token-transfers endpoints', async () => {
    const tx = await bs(fakeFetch()).getTransaction(THOR, ADDRESS)
    expect(tx).toBeDefined()
    expect(tx!.fee).toBe(7702362388952n)
    expect(tx!.status).toBe('confirmed')
    expect(tx!.call?.selector).toBe('0x44bc937b')
    expect(tx!.transfers).toEqual([
      expect.objectContaining({ token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, amount: 9165808n, from: ADDRESS }),
    ])
    expect(await bs(fakeFetch()).getTransaction('0x' + 'cd'.repeat(32), ADDRESS)).toBeUndefined()
  })

  it('an address Blockscout has never seen (404) is an empty page, not an error', async () => {
    const page = await bs(fakeFetch()).listActivity('0x000000000000000000000000000000000000dEaD')
    expect(page.items).toEqual([])
    expect(page.cursor).toBeUndefined()
  })
})
