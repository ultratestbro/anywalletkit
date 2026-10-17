import { beforeEach, describe, expect, it } from 'vitest'
import { createEvmHistory, decodeCursor, parseTokentxRow, resetEtherscanChainlistCache, resetSharedBuckets, type EvmChainTx } from '../src/index.js'
import { ADDRESS, etherscanRows, fakeFetch, fixture, syntheticRows } from './helpers.js'

const KEY = 'test-key'
const SWAP = '0x8ae009668f883b28beeb5fde43001c7b44e810bdfed97011bbfbb1d86bd169bd'

beforeEach(() => {
  resetEtherscanChainlistCache()
  resetSharedBuckets()
})

function source(fetch: ReturnType<typeof fakeFetch>, extra: Record<string, unknown> = {}) {
  return createEvmHistory({ chainId: 1, etherscanApiKey: KEY, fetch, rateLimit: 1000, blockscoutUrl: 'https://bs.example', etherscanCompatUrl: null, ...extra })
}

/** Follow cursors until the source is drained. */
async function drain(src: ReturnType<typeof source>, limit: number) {
  const items: EvmChainTx[] = []
  let cursor: string | undefined
  let pages = 0
  let lastW = Number.POSITIVE_INFINITY
  do {
    const page = await src.listActivity(ADDRESS, { limit, ...(cursor ? { cursor } : {}) })
    pages++
    for (const it of page.items) expect(Number(it.block)).toBeLessThan(lastW)
    items.push(...page.items)
    cursor = page.cursor
    if (cursor) {
      const c = decodeCursor(cursor)
      expect(c).toMatchObject({ v: 1, b: 'etherscan' })
      expect(typeof c.w).toBe('number')
      expect(c.w!).toBeLessThan(lastW)
      lastW = c.w!
    }
  } while (cursor && pages < 200)
  return { items, pages }
}

describe('Etherscan v2 merge (real fixtures, chain 1, 2026-10-14)', () => {
  it('folds txlist + tokentx + txlistinternal into one ChainTx per hash, newest first', async () => {
    const fetch = fakeFetch()
    const { items, pages } = await drain(source(fetch), 100)
    const rows = etherscanRows()
    const unique = new Set([...rows.txlist, ...rows.tokentx, ...rows.txlistinternal].map((r) => r['hash']!.toLowerCase()))
    // txlist has exactly 100 rows, so the first page cannot know the list ended: one more (empty) page closes it
    expect(pages).toBe(2)
    expect(items.map((i) => i.hash)).toEqual([...new Set(items.map((i) => i.hash))])
    expect(items.length).toBe(unique.size)
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.block! >= items[i]!.block!).toBe(true)
    for (const it of items) {
      expect(it.chain).toBe('eip155:1')
      expect(it.address).toBe(ADDRESS)
      expect(it.time).toBeGreaterThan(1_700_000_000)
      expect(it.raw.source).toBe('etherscan')
    }
    // the chainlist was consulted once; 3 list calls on page 1, then only txlist on page 2 (the other two lists were exhausted)
    expect(fetch.calls.filter((c) => c.url.includes('/v2/chainlist')).length).toBe(1)
    expect(fetch.etherscanCalls).toBe(4)
  })

  it('swap: one tx with 2 token legs, fee = gasUsed × gasPrice, selector from input', async () => {
    const page = await source(fakeFetch()).listActivity(ADDRESS, { limit: 100 })
    const swap = page.items.find((i) => i.hash === SWAP)!
    expect(swap).toBeDefined()
    expect(swap.status).toBe('confirmed')
    expect(swap.block).toBe(25896258n)
    expect(swap.time).toBe(1788432215)
    expect(swap.from).toBe(ADDRESS.toLowerCase())
    expect(swap.to).toBe('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae')
    expect(swap.nativeValue).toBe(0n)
    expect(swap.fee).toBe(324406n * 169448979n)
    expect(swap.call).toEqual({ to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', selector: '0x5fd9ae2e', data: expect.stringMatching(/^0x5fd9ae2e/) })
    expect(swap.transfers).toHaveLength(2)
    const ssv = swap.transfers.find((t) => t.symbol === 'SSV')!
    const usdt = swap.transfers.find((t) => t.symbol === 'USDT')!
    expect(ssv).toMatchObject({ standard: 'erc20', amount: 957661331266839909n, decimals: 18, to: ADDRESS.toLowerCase(), token: '0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54' })
    expect(usdt).toMatchObject({ standard: 'erc20', amount: 3000000n, decimals: 6, from: ADDRESS.toLowerCase(), token: '0xdac17f958d2ee523a2206206994597c13d831ec7' })
    expect(swap.spam).toBeUndefined()
    expect(swap.raw.tokens).toHaveLength(2)
    expect(swap.raw.tx).toBeDefined()
  })

  it('internal native transfers become native transfers of the same tx', async () => {
    const page = await source(fakeFetch()).listActivity(ADDRESS, { limit: 100 })
    const h = '0x6295985370012d69571cca77eac153829ba978b0306188040a78f728661c6c17'
    const tx = page.items.find((i) => i.hash === h)!
    expect(tx.raw.tx).toBeDefined()
    expect(tx.raw.internal).toHaveLength(1)
    const native = tx.transfers.filter((t) => t.token === null)
    expect(native.some((t) => t.amount === 18829163100000n && t.to === ADDRESS.toLowerCase())).toBe(true)
  })

  it('plain native send: transfer, no call, nativeValue = value', async () => {
    const page = await source(fakeFetch()).listActivity(ADDRESS, { limit: 100 })
    const send = page.items.find((i) => i.hash === '0x5d6853f3f26a365b367ecaf14839d1ce24c7e76d6ea8ca3003058ea10231a5fa')!
    expect(send.nativeValue).toBe(300000000000000n)
    expect(send.call).toBeUndefined()
    expect(send.transfers).toEqual([{ token: null, from: ADDRESS.toLowerCase(), to: '0x2ebe1b903a22409a8b84fefa38db2a769d58bbe7', amount: 300000000000000n }])
  })

  it('zero-value USDT transferFrom poisoning (token-only hash, tx not sent by us) is spam', async () => {
    const page = await source(fakeFetch()).listActivity(ADDRESS, { limit: 100 })
    const poison = page.items.find((i) => i.hash === '0xdb5c38e0169b991f2197a1d2f168e54ec364b9750e915768f8855aa892431c02')!
    expect(poison.raw.tx).toBeUndefined() // the attacker sent it; only the Transfer log names us
    expect(poison.spam).toBe(true)
    expect(poison.raw.spam).toBe(true)
    expect(poison.raw.spamReason).toBe('zero-value')
    expect(poison.transfers[0]!.amount).toBe(0n)
    // a token-only hash still carries the token symbol/decimals from the row
    expect(poison.transfers[0]).toMatchObject({ symbol: 'USDT', decimals: 6 })
  })

  it('pages with a block window: no duplicates, no gaps, cursor round-trips', async () => {
    const src = source(fakeFetch())
    const all = await drain(src, 100)
    const small = await drain(src, 10)
    expect(small.pages).toBeGreaterThan(3)
    expect(small.items.map((i) => i.hash)).toEqual(all.items.map((i) => i.hash))
    // every merged tx has the same transfer count whichever page size produced it
    for (const it of small.items) expect(it.transfers.length).toBe(all.items.find((a) => a.hash === it.hash)!.transfers.length)
    expect(() => decodeCursor('nope')).toThrow(/malformed cursor/)
  })

  it('since: filtered client-side and the cursor stops once older rows show up', async () => {
    const src = source(fakeFetch())
    const all = await drain(src, 100)
    const since = all.items[20]!.time
    const got: EvmChainTx[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await src.listActivity(ADDRESS, { limit: 10, since, ...(cursor ? { cursor } : {}) })
      pages++
      got.push(...page.items)
      cursor = page.cursor
    } while (cursor && pages < 50)
    expect(got.every((i) => i.time >= since)).toBe(true)
    expect(got.map((i) => i.hash)).toEqual(all.items.filter((i) => i.time >= since).map((i) => i.hash))
    expect(pages).toBeLessThan(6) // stopped early instead of walking all 137 rows
  })

  it('limit is clamped to 1..100', async () => {
    const fetch = fakeFetch()
    await source(fetch).listActivity(ADDRESS, { limit: 500 })
    expect(fetch.calls.some((c) => c.url.includes('offset=100'))).toBe(true)
  })
})

describe('synthetic rows (3-leg swap, failed tx, airdrop, fake USDT)', () => {
  it('maps every case', async () => {
    const synth = syntheticRows()
    const page = await source(fakeFetch({ etherscan: synth })).listActivity(ADDRESS, { limit: 50 })
    const by = (h: string) => page.items.find((i) => i.hash === h)!

    const swap = by(synth.hashes.SWAP)
    // native in (value) + 3 token legs + 1 non-zero internal; the zero-value internal is dropped
    expect(swap.transfers).toHaveLength(5)
    expect(swap.transfers.filter((t) => t.standard === 'erc20')).toHaveLength(3)
    expect(swap.nativeValue).toBe(10n ** 18n)
    expect(swap.fee).toBe(100000n * 1000000000n)
    expect(swap.call?.selector).toBe('0x12345678')
    expect(swap.spam).toBeUndefined()

    const failed = by(synth.hashes.FAILED)
    expect(failed.status).toBe('failed')
    expect(failed.fee).toBe(50000n * 1000000000n)

    const send = by(synth.hashes.SEND)
    expect(send.call).toBeUndefined()
    expect(send.transfers).toHaveLength(1)

    const airdrop = by(synth.hashes.AIRDROP)
    expect(airdrop.spam).toBe(true)
    expect(airdrop.raw.spamReason).toBe('bulk-airdrop')
    expect(airdrop.transfers).toHaveLength(20)

    const fake = by(synth.hashes.FAKE)
    expect(fake.spam).toBe(true)
    expect(fake.raw.spamReason).toBe('symbol-impersonation')
  })
})

describe('Etherscan proxy getTransaction', () => {
  it('parses tx + receipt: 9 ERC-20 Transfer logs, fee from effectiveGasPrice, time from blockTimestamp', async () => {
    const fetch = fakeFetch()
    const tx = await source(fetch).getTransaction(SWAP, ADDRESS)
    expect(tx).toBeDefined()
    expect(tx!.status).toBe('confirmed')
    expect(tx!.time).toBe(1788432215)
    expect(tx!.block).toBe(25896258n)
    expect(tx!.fee).toBe(0x4f336n * 0xa199613n)
    expect(tx!.call?.selector).toBe('0x5fd9ae2e')
    expect(tx!.transfers.filter((t) => t.standard === 'erc20')).toHaveLength(9)
    const toUs = tx!.transfers.filter((t) => t.to === ADDRESS.toLowerCase())
    expect(toUs.some((t) => t.token === '0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54' && t.amount === 957661331266839909n)).toBe(true)
    // catalog fills symbol/decimals for known tokens (USDT); raw keeps the logs
    expect(tx!.transfers.find((t) => t.token === '0xdac17f958d2ee523a2206206994597c13d831ec7')).toMatchObject({ symbol: 'USDT', decimals: 6 })
    expect(fetch.calls.some((c) => c.url.includes('eth_getBlockByNumber'))).toBe(false)
  })

  it('unknown hash → undefined', async () => {
    expect(await source(fakeFetch()).getTransaction('0x' + 'ab'.repeat(32), ADDRESS)).toBeUndefined()
  })
})

describe('Routescan (Etherscan-format mirror)', () => {
  it('tokentx rows parse with the same parser', () => {
    const rows = fixture<{ result: Record<string, string>[] }>('routescan-avax-tokentx.json').result
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const p = parseTokentxRow(r)!
      expect(p.hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(p.block).toBeGreaterThan(0)
      expect(p.time).toBeGreaterThan(1_700_000_000)
      expect(typeof p.amount).toBe('bigint')
    }
  })

  it('is used keyless for Avalanche (43114) and queried without chainid/apikey', async () => {
    const fetch = fakeFetch({ etherscan: syntheticRows() })
    const src = createEvmHistory({ chainId: 43114, fetch, etherscanCompatUrl: 'https://routescan.example/api' })
    const page = await src.listActivity(ADDRESS, { limit: 10 })
    expect(page.backend).toBe('routescan')
    expect(page.items.length).toBeGreaterThan(0)
    const u = new URL(fetch.calls[0]!.url)
    expect(u.host).toBe('routescan.example')
    expect(u.searchParams.has('chainid')).toBe(false)
    expect(u.searchParams.has('apikey')).toBe(false)
    expect(fetch.calls.some((c) => c.url.includes('chainlist'))).toBe(false)
  })
})
