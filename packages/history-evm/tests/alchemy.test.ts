import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALCHEMY_INTERNAL_CHAIN_IDS,
  ALCHEMY_NETWORKS,
  ALCHEMY_TRANSFERS_CHAIN_IDS,
  HistoryUnavailableError,
  SUPPORTED_CHAIN_IDS,
  createEvmHistory,
  decodeCursor,
  parseAlchemyTransfer,
  resetEtherscanChainlistCache,
  resetSharedBuckets,
} from '../src/index.js'
import { ADDRESS, fakeFetch, fixture } from './helpers.js'

/**
 * Base fixtures captured 2026-10-14 with a free-tier key for the public test wallet:
 *   SUPPLY   Aave supply   — `external` ETH 0.0005 out (from-list) + aBasWETH minted in (to-list); tx value 5e14
 *   WITHDRAW Aave withdraw — aBasWETH out (from-list) + `internal` ETH 0.0005 in + aBasWETH dust minted in (to-list); tx value 0
 *   INBOUND  someone else's tx that pays the wallet through an `internal` transfer only
 *   SEND     plain contract call with ETH value from the wallet
 *   POISON   fake "ÚSDС" transferFrom spoofing the wallet as sender (tx sent by a third party)
 */
const SUPPLY = '0x2b79c56d3c5fe0e31906da729fef53f7f9630bd9e8bdd7305d54309dff94096d'
const WITHDRAW = '0x64b993c403ca592337d2dafae2aeb8a765d84be0537a6c7e636a2c8dbdceffc1'
const A_BAS_WETH = '0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7'

type Transfer = Record<string, unknown>
const fromRows = () => fixture<{ result: { transfers: Transfer[] } }>('alchemy-base-transfers-from.json').result.transfers
const toRows = () => fixture<{ result: { transfers: Transfer[] } }>('alchemy-base-transfers-to.json').result.transfers
const hashOfPrefix = (prefix: string) => [...fromRows(), ...toRows()].map((t) => String(t['hash'])).find((h) => h.startsWith(prefix))!

beforeEach(() => {
  resetEtherscanChainlistCache()
  resetSharedBuckets()
})

const base = (fetch: ReturnType<typeof fakeFetch>) => createEvmHistory({ chainId: 8453, alchemyApiKey: 'alch_test', fetch, alchemyRateLimit: 1000 })

describe('Alchemy backend: requests', () => {
  it('asks both directions with external+erc20+internal on Base, desc, metadata, maxCount = limit, zero values included', async () => {
    const fetch = fakeFetch()
    const page = await base(fetch).listActivity(ADDRESS, { limit: 7 })
    expect(page.backend).toBe('alchemy')
    const lists = fetch.alchemyBodies.filter((b): b is { method: string; params: Record<string, unknown>[] } => !Array.isArray(b) && (b as { method?: string }).method === 'alchemy_getAssetTransfers')
    expect(lists).toHaveLength(2)
    const dirs = lists.map((b) => ('fromAddress' in b.params[0]! ? 'from' : 'to')).sort()
    expect(dirs).toEqual(['from', 'to'])
    for (const b of lists) {
      const p = b.params[0]!
      expect(p['category']).toEqual(['external', 'erc20', 'internal'])
      expect(p['order']).toBe('desc')
      expect(p['withMetadata']).toBe(true)
      expect(p['excludeZeroValue']).toBe(false)
      expect(p['maxCount']).toBe('0x7')
      expect(p['toBlock']).toBeUndefined()
      expect(p['pageKey']).toBeUndefined()
    }
    expect(fetch.calls.every((c) => c.url === 'https://base-mainnet.g.alchemy.com/v2/alch_test')).toBe(true)
  })

  it('omits the internal category where Alchemy does not support it (Arbitrum) and honours alchemyNetwork / alchemyUrl', async () => {
    const fetch = fakeFetch()
    const src = createEvmHistory({ chainId: 42161, alchemyApiKey: 'k', fetch, alchemyRateLimit: 1000, alchemyNetwork: 'arb-custom', alchemyUrl: 'https://proxy.example/{network}/{key}' })
    await src.listActivity(ADDRESS, { limit: 5 })
    const p = (fetch.alchemyBodies[0] as { params: Record<string, unknown>[] }).params[0]!
    expect(p['category']).toEqual(['external', 'erc20'])
    expect(fetch.calls[0]!.url).toBe('https://proxy.example/arb-custom/k')
  })

  it('fetches tx + receipt for every unique hash of the page in JSON-RPC batches of at most 20', async () => {
    const fetch = fakeFetch()
    const page = await base(fetch).listActivity(ADDRESS, { limit: 50 })
    const batches = fetch.alchemyBodies.filter((b): b is unknown[] => Array.isArray(b))
    expect(page.items).toHaveLength(36) // 20 + 20 transfers → 36 distinct hashes
    expect(batches.map((b) => b.length)).toEqual([20, 20, 20, 12])
    const methods = new Set(batches.flat().map((r) => (r as { method: string }).method))
    expect([...methods].sort()).toEqual(['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    expect(fetch.alchemyCalls).toBe(2 + 4)
  })
})

describe('Alchemy backend: merge', () => {
  it('SUPPLY: the external row is the tx value — one native transfer, not two; the minted aToken is an erc20 leg', async () => {
    const page = await base(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const tx = page.items.find((i) => i.hash === SUPPLY)!
    expect(tx.nativeValue).toBe(500_000_000_000_000n)
    expect(tx.from.toLowerCase()).toBe(ADDRESS.toLowerCase())
    const native = tx.transfers.filter((t) => t.token === null)
    expect(native).toHaveLength(1)
    expect(native[0]!.amount).toBe(500_000_000_000_000n)
    expect(native[0]!.to.toLowerCase().startsWith('0xa0d9c1')).toBe(true) // Aave pool
    const erc20 = tx.transfers.filter((t) => t.token === A_BAS_WETH)
    expect(erc20).toHaveLength(1)
    expect(erc20[0]).toMatchObject({ standard: 'erc20', symbol: 'aBasWETH', decimals: 18, amount: 0x1c6bf52633fffn })
    expect(tx.call?.selector).toBe('0x474cf53d')
    expect(tx.status).toBe('confirmed')
    expect(tx.spam).toBeUndefined()
    expect(tx.raw.source).toBe('alchemy')
    expect((tx.raw.tx as { tx: unknown; receipt: unknown }).receipt).toBeTruthy()
  })

  it('WITHDRAW: erc20 out + erc20 in + native arriving as an internal transfer; fee = gasUsed × effectiveGasPrice; selector from calldata', async () => {
    const page = await base(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const tx = page.items.find((i) => i.hash === WITHDRAW)!
    expect(tx.nativeValue).toBe(0n)
    const erc20 = tx.transfers.filter((t) => t.token === A_BAS_WETH)
    expect(erc20).toHaveLength(2)
    expect(erc20.some((t) => t.from.toLowerCase() === ADDRESS.toLowerCase() && t.amount === 500_000_000_000_000n)).toBe(true) // out
    expect(erc20.some((t) => t.to.toLowerCase() === ADDRESS.toLowerCase() && t.amount === 0xa158f5n)).toBe(true) // dust mint in
    const native = tx.transfers.filter((t) => t.token === null)
    expect(native).toHaveLength(1)
    expect(native[0]!.to.toLowerCase()).toBe(ADDRESS.toLowerCase())
    expect(native[0]!.amount).toBe(500_000_000_000_000n)
    expect(tx.fee).toBe(0x367ecn * 0x5b8d80n)
    expect(tx.status).toBe('confirmed')
    expect(tx.call?.selector).toBe('0x80500d20')
    expect(tx.time).toBe(Math.floor(Date.parse('2026-10-10T16:56:35.000Z') / 1000))
    expect(tx.block).toBe(0x32008b0n)
  })

  it('INBOUND: a tx the wallet did not send, listed only through an internal transfer, keeps the sender and the internal leg', async () => {
    const hash = hashOfPrefix('0x05e3b0d0c7')
    const page = await base(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const tx = page.items.find((i) => i.hash === hash)!
    expect(tx.from.toLowerCase()).not.toBe(ADDRESS.toLowerCase())
    expect(tx.raw.tx).toBeTruthy()
    const toMe = tx.transfers.filter((t) => t.token === null && t.to.toLowerCase() === ADDRESS.toLowerCase())
    expect(toMe).toHaveLength(1)
    expect(toMe[0]!.amount).toBe(3_150_090_000_000_000n)
    expect(tx.raw.internal).toHaveLength(1)
    expect(tx.fee).toBeGreaterThan(0n)
  })

  it('SEND: status / fee / selector come from the receipt batch, not the Transfers API', async () => {
    const hash = hashOfPrefix('0x5d98676ede')
    const page = await base(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const tx = page.items.find((i) => i.hash === hash)!
    expect(tx.status).toBe('confirmed')
    expect(tx.call?.selector).toBe('0x4c279d6b')
    expect(tx.nativeValue).toBe(1_475_000_000_000_000n)
    const rc = (tx.raw.tx as { receipt: Record<string, string> }).receipt
    expect(tx.fee).toBe(BigInt(rc['gasUsed']!) * BigInt(rc['effectiveGasPrice']!))
  })

  it('spam rules still fire on Transfers API rows: non-ASCII "ÚSDС" spoofed from the wallet by a third party', async () => {
    const page = await base(fakeFetch()).listActivity(ADDRESS, { limit: 50 })
    const poison = page.items.find((i) => i.hash === hashOfPrefix('0x0c6f0fc638'))!
    expect(poison.spam).toBe(true)
    expect(poison.raw.spamReason).toBe('symbol-impersonation')
    const usdc = page.items.find((i) => i.hash === hashOfPrefix('0x40fad7c23b'))!
    expect(usdc.spam).toBeUndefined()
    expect(usdc.transfers[0]).toMatchObject({ symbol: 'USDC', decimals: 6, amount: 13_968_444n })
  })

  it('a hash the node no longer knows (null tx) still renders from its external row', async () => {
    const hash = hashOfPrefix('0x48ee9c475c')
    const fetch = fakeFetch({
      alchemyIntercept: (body) => {
        if (!Array.isArray(body)) return undefined
        const reqs = body as { id: number; method: string; params: string[] }[]
        if (!reqs.some((r) => r.params[0] === hash)) return undefined
        return { status: 200, body: reqs.map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.params[0] === hash ? null : undefined })) }
      },
    })
    // The intercept only answers the batch that holds our hash; make that the only batch by paging small.
    const src = base(fetch)
    let page = await src.listActivity(ADDRESS, { limit: 5 })
    while (!page.items.some((i) => i.hash === hash) && page.cursor) page = await src.listActivity(ADDRESS, { cursor: page.cursor, limit: 5 })
    const tx = page.items.find((i) => i.hash === hash)!
    expect(tx.from.toLowerCase()).toBe(ADDRESS.toLowerCase())
    expect(tx.nativeValue).toBe(3_146_000_000_000_000n)
    expect(tx.fee).toBeUndefined()
    expect(tx.status).toBe('confirmed')
  })

  it('without transfer metadata the block timestamps are fetched in the same batch', async () => {
    const fetch = fakeFetch({ alchemyStripMetadata: true })
    const page = await base(fetch).listActivity(ADDRESS, { limit: 5 })
    const batches = fetch.alchemyBodies.filter((b): b is { method: string }[] => Array.isArray(b))
    expect(batches.flat().some((r) => r.method === 'eth_getBlockByNumber')).toBe(true)
    for (const it of page.items) expect(it.time).toBe(1_790_000_000 + Number(it.block))
  })
})

describe('Alchemy backend: pagination', () => {
  it('pages by block window: toBlock = w - 1 on every list, no pageKey, complete and duplicate-free', async () => {
    const fetch = fakeFetch()
    const src = base(fetch)
    const seen: string[] = []
    let page = await src.listActivity(ADDRESS, { limit: 5 })
    expect(page.cursor).toBeDefined()
    const c = decodeCursor(page.cursor!)
    expect(c.b).toBe('alchemy')
    // Per-list cursors are only the `more` marker or absent (re-fetch below `w`); never an Alchemy pageKey.
    expect(Object.values(c.lists).every((v) => v === 'more' || v === null)).toBe(true)
    expect(c.w).toBe(0x320360c + 1)
    let lastMin = Number.POSITIVE_INFINITY
    for (let i = 0; i < 20; i++) {
      for (const it of page.items) {
        expect(Number(it.block)).toBeLessThan(lastMin + 1)
        seen.push(it.hash)
      }
      lastMin = Math.min(...page.items.map((i) => Number(i.block)))
      if (!page.cursor) break
      const before = fetch.alchemyBodies.length
      page = await src.listActivity(ADDRESS, { cursor: page.cursor, limit: 5 })
      const lists = fetch.alchemyBodies.slice(before).filter((b): b is { method: string; params: Record<string, unknown>[] } => !Array.isArray(b))
      expect(lists.length).toBeGreaterThan(0)
      for (const b of lists) {
        expect(b.params[0]!['pageKey']).toBeUndefined()
        expect(parseInt(String(b.params[0]!['toBlock']), 16)).toBeLessThan(lastMin + 1)
      }
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(36)
  })

  it('a cursor is only a block window, so it never expires (the Transfers API pageKey TTL of 10 min does not apply)', async () => {
    const fetch = fakeFetch()
    const src = base(fetch)
    const p1 = await src.listActivity(ADDRESS, { limit: 5 })
    // "Hours later": a fresh process, fresh limiter, same cursor.
    resetSharedBuckets()
    const p2 = await base(fakeFetch()).listActivity(ADDRESS, { cursor: p1.cursor!, limit: 5 })
    const minP1 = Math.min(...p1.items.map((i) => Number(i.block)))
    expect(p2.items.length).toBeGreaterThan(0)
    for (const it of p2.items) expect(Number(it.block)).toBeLessThan(minP1)
    expect(JSON.stringify(p1.cursor)).not.toMatch(/pageKey/)
  })

  it('an Etherscan cursor resumes on Alchemy by block when Etherscan starts refusing', async () => {
    const good = fakeFetch()
    const first = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', fetch: good, rateLimit: 1000, etherscanCompatUrl: null, blockscoutUrl: null })
    const p1 = await first.listActivity(ADDRESS, { limit: 10 })
    expect(p1.backend).toBe('etherscan')
    const broken = fakeFetch({ etherscanIntercept: () => ({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain' }) })
    resetEtherscanChainlistCache()
    const second = createEvmHistory({ chainId: 1, etherscanApiKey: 'k', alchemyApiKey: 'a', fetch: broken, rateLimit: 1000, alchemyRateLimit: 1000, etherscanCompatUrl: null, blockscoutUrl: null })
    const p2 = await second.listActivity(ADDRESS, { limit: 10, cursor: p1.cursor! })
    expect(p2.backend).toBe('alchemy')
    const w = decodeCursor(p1.cursor!).w!
    const lists = broken.alchemyBodies.filter((b): b is { params: Record<string, unknown>[] } => !Array.isArray(b))
    for (const b of lists) expect(parseInt(String(b.params[0]!['toBlock']), 16)).toBe(w - 1)
  })
})

describe('Alchemy backend: failures and ordering', () => {
  it('"<NETWORK> is not enabled for this app" (HTTP 403) is unavailable: no retry, next backend', async () => {
    const fetch = fakeFetch({ alchemyNotEnabled: true })
    const src = createEvmHistory({ chainId: 8453, alchemyApiKey: 'k', fetch, alchemyRateLimit: 1000, blockscoutUrl: 'https://bs.example' })
    const page = await src.listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('blockscout')
    expect(fetch.alchemyCalls).toBe(1)
  })

  it('…and the reason is reported when nothing else is left', async () => {
    const fetch = fakeFetch({ alchemyNotEnabled: true })
    const src = createEvmHistory({ chainId: 56, alchemyApiKey: 'k', fetch, alchemyRateLimit: 1000 })
    const err = (await src.listActivity(ADDRESS).catch((e: unknown) => e)) as HistoryUnavailableError
    expect(err).toBeInstanceOf(HistoryUnavailableError)
    expect(err.attempts).toEqual([expect.stringMatching(/^alchemy: .*BNB_MAINNET is not enabled for this app/)])
  })

  it('HTTP 429 is retried once through the limiter, then served', async () => {
    const fetch = fakeFetch({ alchemyIntercept: (_b, n) => (n === 1 ? { status: 429, body: { error: 'Too Many Requests' } } : undefined) })
    const page = await base(fetch).listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('alchemy')
    expect(fetch.alchemyCalls).toBe(2 + 1 + 1) // from (429) + retry + to + one batch
  })

  it('a JSON-RPC 401 "Must be authenticated" and a 400 malformed answer are not retried', async () => {
    for (const [status, body] of [
      [401, { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Must be authenticated!' } }],
      [400, { error: 'Invalid pageKey format for transfers. Expected UUID format.' }],
    ] as const) {
      resetSharedBuckets()
      const fetch = fakeFetch({ alchemyIntercept: () => ({ status, body }) })
      const src = createEvmHistory({ chainId: 8453, alchemyApiKey: 'k', fetch, alchemyRateLimit: 1000, blockscoutUrl: 'https://bs.example' })
      const page = await src.listActivity(ADDRESS, { limit: 5 })
      expect(page.backend).toBe('blockscout')
      expect(fetch.alchemyCalls).toBe(1)
    }
  })

  it('default order: etherscan → blockscout-pro → alchemy → routescan → blockscout; prefer: "alchemy" moves it first', async () => {
    const fetch = fakeFetch()
    const all = { chainId: 1, etherscanApiKey: 'e', blockscoutProApiKey: 'p', alchemyApiKey: 'a', fetch, rateLimit: 1000, blockscoutProRateLimit: 1000, alchemyRateLimit: 1000 } as const
    const p = await createEvmHistory(all).listActivity(ADDRESS, { limit: 5 })
    expect(p.backend).toBe('etherscan')
    expect(fetch.alchemyCalls).toBe(0)

    // Etherscan + PRO refuse → Alchemy is next, before the keyless Routescan / Blockscout.
    const refusing = fakeFetch({ etherscanIntercept: (url) => (url.hostname === 'api.blockscout.com' ? { error: 'Unauthorized' } : { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain' }) })
    resetSharedBuckets()
    const p2 = await createEvmHistory({ ...all, fetch: refusing }).listActivity(ADDRESS, { limit: 5 })
    expect(p2.backend).toBe('alchemy')
    expect(refusing.blockscoutCalls).toBe(0)
    expect(refusing.calls.some((c) => c.url.includes('routescan'))).toBe(false)

    const preferred = fakeFetch()
    resetSharedBuckets()
    const p3 = await createEvmHistory({ ...all, fetch: preferred, prefer: 'alchemy' }).listActivity(ADDRESS, { limit: 5 })
    expect(p3.backend).toBe('alchemy')
    expect(preferred.etherscanCalls).toBe(0)
  })

  it('Base with only an Alchemy key is served (the chain that has no other free source)', async () => {
    const fetch = fakeFetch()
    const page = await createEvmHistory({ chainId: 8453, alchemyApiKey: 'k', fetch, alchemyRateLimit: 1000 }).listActivity(ADDRESS, { limit: 5 })
    expect(page.backend).toBe('alchemy')
  })

  it('a chain without a documented Transfers API (Sonic) is not tried unless alchemyNetwork is passed', async () => {
    const fetch = fakeFetch()
    await expect(createEvmHistory({ chainId: 146, alchemyApiKey: 'k', fetch }).listActivity(ADDRESS)).rejects.toThrow(/Transfers API is not documented.*alchemyNetwork/)
    expect(fetch.alchemyCalls).toBe(0)
    const forced = await createEvmHistory({ chainId: 146, alchemyApiKey: 'k', fetch, alchemyNetwork: 'sonic-mainnet', alchemyRateLimit: 1000 }).listActivity(ADDRESS, { limit: 5 })
    expect(forced.backend).toBe('alchemy')
    expect(fetch.calls[0]!.url).toBe('https://sonic-mainnet.g.alchemy.com/v2/k')
  })

  it('X Layer with an Alchemy key but no Transfers API stays a quiet empty page; with alchemyNetwork it is tried', async () => {
    const fetch = fakeFetch()
    const quiet = await createEvmHistory({ chainId: 196, alchemyApiKey: 'k', fetch }).listActivity(ADDRESS)
    expect(quiet.items).toEqual([])
    expect(quiet.note).toMatch(/no public explorer API/)
    expect(fetch.calls).toHaveLength(0)
    const forced = await createEvmHistory({ chainId: 196, alchemyApiKey: 'k', fetch, alchemyNetwork: 'xlayer-mainnet', alchemyRateLimit: 1000 }).listActivity(ADDRESS, { limit: 5 })
    expect(forced.backend).toBe('alchemy')
  })
})

describe('Alchemy backend: getTransaction', () => {
  it('tx + receipt in one batch, ERC-20 Transfer logs → transfers, block timestamp fetched', async () => {
    const fetch = fakeFetch()
    const tx = await base(fetch).getTransaction(WITHDRAW, ADDRESS)
    expect(tx).toBeDefined()
    expect(tx!.status).toBe('confirmed')
    expect(tx!.fee).toBe(0x367ecn * 0x5b8d80n)
    expect(tx!.call?.selector).toBe('0x80500d20')
    expect(tx!.transfers.filter((t) => t.standard === 'erc20')).toHaveLength(5)
    expect(tx!.transfers.filter((t) => t.token === A_BAS_WETH)).toHaveLength(4)
    expect(tx!.transfers.some((t) => t.token === '0x4200000000000000000000000000000000000006' && t.amount === 500_000_000_000_000n)).toBe(true)
    expect(tx!.time).toBe(1_790_000_000 + 0x32008b0)
    const batch = fetch.alchemyBodies[0] as { method: string }[]
    expect(batch.map((r) => r.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
    expect((fetch.alchemyBodies[1] as { method: string }).method).toBe('eth_getBlockByNumber')
  })

  it('unknown hash → undefined', async () => {
    expect(await base(fakeFetch()).getTransaction('0x' + 'f'.repeat(64), ADDRESS)).toBeUndefined()
  })
})

describe('Alchemy tables', () => {
  it('every supported chain has a slug; Transfers ⊂ slugs; internal ⊂ Transfers; the undocumented set is exactly Sonic, Plasma, MegaETH, Sei, Plume, X Layer', () => {
    for (const id of SUPPORTED_CHAIN_IDS) expect(ALCHEMY_NETWORKS[id], `slug for ${id}`).toMatch(/^[a-z]+-mainnet$/)
    expect(new Set(Object.values(ALCHEMY_NETWORKS)).size).toBe(Object.keys(ALCHEMY_NETWORKS).length)
    for (const id of ALCHEMY_TRANSFERS_CHAIN_IDS) expect(ALCHEMY_NETWORKS[id], `transfers chain ${id} has a slug`).toBeDefined()
    for (const id of ALCHEMY_INTERNAL_CHAIN_IDS) expect(ALCHEMY_TRANSFERS_CHAIN_IDS).toContain(id)
    expect(ALCHEMY_INTERNAL_CHAIN_IDS).toEqual([1, 137, 8453, 5042])
    const undocumented = SUPPORTED_CHAIN_IDS.filter((id) => !ALCHEMY_TRANSFERS_CHAIN_IDS.includes(id)).sort((a, b) => a - b)
    expect(undocumented).toEqual([146, 196, 1329, 4326, 9745, 98866])
    expect(ALCHEMY_NETWORKS[8453]).toBe('base-mainnet')
    expect(ALCHEMY_NETWORKS[56]).toBe('bnb-mainnet')
    expect(ALCHEMY_NETWORKS[999]).toBe('hyperliquid-mainnet')
    expect(ALCHEMY_NETWORKS[4663]).toBe('robinhood-mainnet')
    expect(ALCHEMY_NETWORKS[5042]).toBe('arc-mainnet')
  })

  it('parseAlchemyTransfer: erc20 / external / internal rows; NFT rows skipped', () => {
    const erc20 = parseAlchemyTransfer(toRows()[0]!)!
    expect(erc20).toMatchObject({ category: 'erc20', symbol: 'USDC', decimals: 6, amount: 0xd5243cn, token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', block: 0x32159a1 })
    expect(erc20.time).toBe(Math.floor(Date.parse('2026-10-12T16:51:49.000Z') / 1000))
    const external = parseAlchemyTransfer(fromRows()[0]!)!
    expect(external).toMatchObject({ category: 'external', amount: 1_475_000_000_000_000n })
    expect(external.token).toBeUndefined()
    const internal = parseAlchemyTransfer(toRows().find((t) => t['category'] === 'internal')!)!
    expect(internal.category).toBe('internal')
    expect(internal.amount).toBe(500_000_000_000_000n)
    expect(parseAlchemyTransfer({ ...toRows()[0]!, category: 'erc721' })).toBeUndefined()
    expect(parseAlchemyTransfer({ ...toRows()[0]!, category: 'erc1155' })).toBeUndefined()
    expect(parseAlchemyTransfer({ hash: 1 })).toBeUndefined()
  })
})
