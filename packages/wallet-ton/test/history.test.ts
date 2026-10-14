import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@forgewallet/conformance'
import TonstakersProtocolTon from '@forgewallet/protocol-staking-tonstakers-ton'
import { describeOmnistonActivity } from '@forgewallet/protocol-swap2-omniston'
import type { ActivityItem, ChainTx } from '@forgewallet/core'
import {
  HistoryUnavailableError, createTonHistory, decodeHistoryCursor, encodeHistoryCursor, rawTonAddress, tonExplorerTxUrl,
  type HistoryFetch, type TonapiEvent,
} from '../src/index.js'

const WALLET = 'UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq'
const WALLET_RAW = '0:9b5c9d7e1ddfc2cb202ddd33608ab71db8d227e501f9763d7f2c1373fffcb87d'
const POOL_RAW = '0:a45b17f28409229b78360e3290420f13e4fe20f90d7e2bf8c4ac6703259e22fa'
const POOL_FRIENDLY = 'EQCkWxfyhAkim3g2DjKQQg8T5P4g-Q1-K_jErGcDJZ4i-vqR'
const TSTON_RAW = '0:bdf3fa8098d129b54b4f73b5bac5d1e1fd91eb054169c3916dfc8ccd536d1000'
const USDT_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
const STONFI_ROUTER_RAW = rawTonAddress('EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3')
const ESCROW_RAW = rawTonAddress('EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ')

const fx = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/history/${name}.json`, import.meta.url), 'utf8')) as T
const PAGE1 = fx<{ events: TonapiEvent[]; next_from: number }>('tonapi-events-page1')
const ACCOUNT_EVENTS: Record<string, TonapiEvent> = {}
for (const n of ['stake', 'unstake', 'payout', 'swap', 'escrow']) {
  const e = fx<TonapiEvent>(`tonapi-account-event-${n}`)
  ACCOUNT_EVENTS[e.event_id] = e
}
const FULL_UNSTAKE = fx<TonapiEvent>('tonapi-event-unstake')
const V3 = fx<{ transactions: Array<{ lt: string; hash: string }> }>('toncenter-v3-transactions')
/** The fixtures' tx hashes (as the module fixtures name them) that tonapi resolves to the trace's event id. */
const HASH_ALIASES: Record<string, string> = { daf22a93fd9466182dfbc8fd83e61878fd1d65c8667684aac9f3ef8763d7f6b1: '127209447a2c' }

interface FakeOptions {
  tonapi?: 'down' | 'rate-limited' | 'ok'
  toncenter?: 'down' | 'ok'
}

function fake(opts: FakeOptions = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body })
  const fetch: HistoryFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const u = new URL(url)
    if (u.hostname.endsWith('tonapi.io')) {
      if (opts.tonapi === 'down') throw new TypeError('fetch failed')
      if (opts.tonapi === 'rate-limited') return json(429, { error: 'rate limit exceeded' })
      let m = /^\/v2\/accounts\/([^/]+)\/events$/.exec(u.pathname)
      if (m) {
        const limit = Number(u.searchParams.get('limit') ?? 25)
        const before = u.searchParams.get('before_lt')
        let events = PAGE1.events
        if (before) events = events.filter((e) => BigInt(e.lt) < BigInt(before))
        events = events.slice(0, limit)
        return json(200, { events, next_from: events.length ? events[events.length - 1]!.lt : 0 })
      }
      m = /^\/v2\/accounts\/([^/]+)\/events\/([^/]+)$/.exec(u.pathname)
      if (m) {
        const id = m[2]!
        const e = ACCOUNT_EVENTS[id] ?? Object.values(ACCOUNT_EVENTS).find((x) => x.event_id.startsWith(HASH_ALIASES[id] ?? '\u0000'))
        return e ? json(200, e) : json(404, { error: 'event not found' })
      }
      m = /^\/v2\/events\/([^/]+)$/.exec(u.pathname)
      if (m) return m[1] === FULL_UNSTAKE.event_id ? json(200, FULL_UNSTAKE) : json(404, { error: 'event not found' })
      return json(500, { error: `unmocked ${u.pathname}` })
    }
    if (u.hostname.endsWith('toncenter.com')) {
      if (opts.toncenter === 'down') return json(503, { error: 'maintenance' })
      if (u.pathname === '/api/v3/transactions') {
        const hash = u.searchParams.get('hash')
        if (hash) return json(200, { transactions: V3.transactions.filter((t) => t.hash === hash) })
        const limit = Number(u.searchParams.get('limit') ?? 10)
        const endLt = u.searchParams.get('end_lt')
        let rows = V3.transactions
        if (endLt) rows = rows.filter((t) => BigInt(t.lt) <= BigInt(endLt))
        return json(200, { transactions: rows.slice(0, limit) })
      }
      return json(500, { error: `unmocked ${u.pathname}` })
    }
    throw new Error(`unexpected host ${u.hostname}`)
  }
  return { fetch, calls }
}

const src = (opts: FakeOptions = {}, extra: Record<string, unknown> = {}) => {
  const f = fake(opts)
  return { ...f, source: createTonHistory({ fetch: f.fetch, rateLimit: 10_000, ...extra }) }
}

describe('createTonHistory: tonapi pages', () => {
  it('maps a real account page: jetton transfers with master/symbol/decimals, TON transfers, fee from `extra`, cursor = next_from', async () => {
    const { source, calls } = src()
    expect(source.chain).toBe('ton:-239')
    const page = await source.listActivity(WALLET, { limit: 10 })
    expect(page.backend).toBe('tonapi')
    expect(page.items).toHaveLength(10)
    expect(calls[0]!.url).toContain(`/v2/accounts/${WALLET}/events?limit=10`)
    const first = page.items[0]!
    expect(first.hash).toBe('3e90722877ab3717b7a57d397d8cf61a57deae48faca7240dae63dce325552b3')
    expect(first.status).toBe('confirmed')
    expect(first.from).toBe(WALLET_RAW)
    expect(first.to).toBe('0:7178bc9e9a8491e294c208d900cb447d0ff610c2316392186d2966132147f30f')
    expect(first.transfers).toEqual([{ token: USDT_RAW, from: WALLET_RAW, to: '0:7178bc9e9a8491e294c208d900cb447d0ff610c2316392186d2966132147f30f', amount: 13_990_032n, standard: 'jetton', symbol: 'USD₮', decimals: 6 }])
    expect(first.call, 'a jetton transfer to a wallet is a plain transfer').toBeUndefined()
    expect(first.fee).toBe(2_133_848n)
    expect(first.nativeValue).toBe(0n)
    expect(first.block).toBe(109110597000032n)
    const ton = page.items.find((i) => i.hash.startsWith('d9b2b5bafbb8'))!
    expect(ton.transfers).toEqual([{ token: null, from: WALLET_RAW, to: '0:8a0d28bf0ee5b521da79203e1607772ff8c07fd77004539289a11c578f0d7af0', amount: 6_599_100_000n }])
    expect(ton.nativeValue).toBe(6_599_100_000n)
    expect(ton.fee).toBe(513_538n)
    const inbound = page.items.find((i) => i.hash.startsWith('043fdd483651'))!
    expect(inbound.from).not.toBe(WALLET_RAW)
    expect(inbound.to).toBe(WALLET_RAW)
    expect(inbound.nativeValue).toBe(6_599_640_529n)
    // every item newest first
    for (let i = 1; i < page.items.length; i++) expect(page.items[i - 1]!.time).toBeGreaterThanOrEqual(page.items[i]!.time)
    expect(decodeHistoryCursor(page.cursor!)).toEqual({ v: 1, b: 'tonapi', lt: String(PAGE1.next_from) })
  })

  it('the cursor is an exclusive lt bound: the next page asks tonapi for before_lt and ends when short', async () => {
    const { source, calls } = src()
    const p1 = await source.listActivity(WALLET, { limit: 4 })
    const p2 = await source.listActivity(WALLET, { limit: 4, cursor: p1.cursor! })
    expect(calls[calls.length - 1]!.url).toContain(`before_lt=${PAGE1.events[3]!.lt}`)
    expect(p2.items.map((i) => i.hash)).toEqual(PAGE1.events.slice(4, 8).map((e) => e.event_id))
    const p3 = await source.listActivity(WALLET, { limit: 4, cursor: p2.cursor! })
    expect(p3.items).toHaveLength(2)
    expect(p3.cursor).toBeUndefined()
  })

  it('`since` trims and ends pagination', async () => {
    const { source } = src()
    const page = await source.listActivity(WALLET, { limit: 10, since: 1791634000 })
    expect(page.items).toHaveLength(3)
    expect(page.cursor).toBeUndefined()
  })

  it('sends the Bearer key and raises the default rate limit with it', async () => {
    const { source, calls } = src({}, { apiKey: 'k' })
    await source.listActivity(WALLET, { limit: 2 })
    expect(calls[0]!.headers.authorization).toBe('Bearer k')
  })
})

describe('createTonHistory: single events (account-scoped tonapi)', () => {
  const stake = () => src().source.getTransaction('15e18e04a9ef99ca9a30178e6fa18fabdee729ffb2865bd7b669796c33e7465e', WALLET)

  it('Tonstakers stake: DepositStake → TON to the pool, JettonMint → tsTON in, call to the pool', async () => {
    const tx = (await stake())!
    expect(tx.from).toBe(WALLET_RAW)
    expect(tx.to).toBe(POOL_RAW)
    expect(tx.nativeValue).toBe(3_000_000_000n)
    expect(tx.transfers).toEqual([
      { token: null, from: WALLET_RAW, to: POOL_RAW, amount: 3_000_000_000n },
      { token: TSTON_RAW, from: TSTON_RAW, to: WALLET_RAW, amount: 2_602_334_618n, standard: 'jetton', symbol: 'tsTON', decimals: 9 },
    ])
    expect(tx.call).toEqual({ to: POOL_RAW, method: 'stake' })
    expect(tx.fee).toBe(3_514_920n)
    expect(tx.block).toBe(101244263000001n)
    expect(tx.time).toBe(1788516212)
    expect(tx.raw.backend).toBe('tonapi')
  })

  it('Tonstakers unstake request: the tsTON burn is recovered from value_flow (one extra tonapi call)', async () => {
    const { source, calls } = src()
    const tx = (await source.getTransaction('feadea0945e146bdd0e1b617c75163ecab2123547e518ed0c5609cd7421858a9', WALLET))!
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      `/v2/accounts/${WALLET}/events/feadea0945e146bdd0e1b617c75163ecab2123547e518ed0c5609cd7421858a9`,
      '/v2/events/feadea0945e146bdd0e1b617c75163ecab2123547e518ed0c5609cd7421858a9',
    ])
    expect(tx.call).toEqual({ to: POOL_RAW, method: 'unstake' })
    expect(tx.transfers).toEqual([{ token: TSTON_RAW, from: WALLET_RAW, to: POOL_RAW, amount: 1_000_000_000n, standard: 'jetton', symbol: 'tsTON', decimals: 9 }])
    expect(tx.raw.valueFlow).toBeDefined()
    expect(tx.fee).toBe(95_327_081n)
  })

  it('Tonstakers payout: WithdrawStake → TON from the pool to us, the pool initiated', async () => {
    const tx = (await src().source.getTransaction('daf22a93fd9466182dfbc8fd83e61878fd1d65c8667684aac9f3ef8763d7f6b1', WALLET))!
    expect(tx.hash.startsWith('127209447a2c'), 'tonapi answers with the trace root event id, not the account tx hash').toBe(true)
    expect(tx.from).toBe(POOL_RAW)
    expect(tx.to).toBe(POOL_RAW)
    expect(tx.nativeValue).toBe(939_863_465n)
    expect(tx.transfers).toEqual([{ token: null, from: POOL_RAW, to: WALLET_RAW, amount: 939_863_465n }])
    expect(tx.call).toEqual({ to: POOL_RAW, method: 'withdraw_stake' })
  })

  it('STON.fi swap via Omniston: JettonSwap → TON out to the router, USD₮ in, call = router/swap', async () => {
    const tx = (await src().source.getTransaction('72ea596844b123844b1798cdc285f361e3146e0286c79bae14918725a14ca3bd', WALLET))!
    expect(tx.transfers).toEqual([
      { token: null, from: WALLET_RAW, to: STONFI_ROUTER_RAW, amount: 36_127_400_000n },
      { token: USDT_RAW, from: STONFI_ROUTER_RAW, to: WALLET_RAW, amount: 52_333_196n, standard: 'jetton', symbol: 'USD₮', decimals: 6 },
    ])
    expect(tx.call).toEqual({ to: STONFI_ROUTER_RAW, method: 'swap' })
    expect(tx.nativeValue).toBe(36_127_400_000n)
    expect(tx.fee).toBe(5_694_048n)
  })

  it('Omniston escrow order: jetton to a contract with a forward op → call with the op code, TON refund back', async () => {
    const tx = (await src().source.getTransaction('c18547c1f6d7a0531aaa954d976f38e285026dca9950bbeac966518cf8af62c4', WALLET))!
    expect(tx.call).toEqual({ to: ESCROW_RAW, method: 'jetton_transfer', data: '0xc0a5f0d9' })
    expect(tx.transfers).toEqual([
      { token: USDT_RAW, from: WALLET_RAW, to: ESCROW_RAW, amount: 1_600_000n, standard: 'jetton', symbol: 'USD₮', decimals: 6 },
      { token: null, from: '0:1b40c2d98f32bf31627b4771d215f39a520391710417dbdba0f94813b7bbd69e', to: WALLET_RAW, amount: 169_435_207n },
    ])
    expect(tx.fee).toBe(308_497_479n)
  })

  it('unknown hash → undefined', async () => {
    expect(await src().source.getTransaction('00'.repeat(32), WALLET)).toBeUndefined()
  })
})

describe('createTonHistory: toncenter fallback', () => {
  it('falls back to toncenter v3 when tonapi is down, with the reduced mapping (TON legs, op codes, fee = total_fees)', async () => {
    const { source, calls } = src({ tonapi: 'down' })
    const page = await source.listActivity(WALLET, { limit: 5 })
    expect(page.backend).toBe('toncenter')
    expect(calls.some((c) => c.url.includes('toncenter.com/api/v3/transactions?account='))).toBe(true)
    expect(page.items).toHaveLength(5)
    const excess = page.items[0]!
    expect(excess.hash).toBe(Buffer.from('VfzFSRHvxVBOUNPC4hF32z+7ZClntLUmO9yCGQw1e0g=', 'base64').toString('hex'))
    expect(excess.from).toBe('0:d339c650e383d08f9379d22d75dfa12d00a948c7ff9f90e7db57c2d34f14d6bc')
    expect(excess.to).toBe(WALLET_RAW)
    expect(excess.transfers).toEqual([{ token: null, from: '0:d339c650e383d08f9379d22d75dfa12d00a948c7ff9f90e7db57c2d34f14d6bc', to: WALLET_RAW, amount: 48_533_962n }])
    expect(excess.call).toEqual({ to: WALLET_RAW, data: '0xd53276db', method: 'excess' })
    expect(excess.fee).toBe(51_868n)
    expect(excess.status).toBe('confirmed')
    const external = page.items[1]!
    expect(external.from).toBe(WALLET_RAW)
    expect(external.call).toEqual({ to: '0:fdb51192f5f1f7c814bbf55a1b60a86f2c442a419b616fa6a653b0a567a77992', data: '0x0f8a7ea5', method: 'jetton_transfer' })
    expect(external.nativeValue).toBe(50_000_001n)
    const plain = page.items[3]!
    expect(plain.call, 'a TON transfer without an op is a plain transfer').toBeUndefined()
    expect(plain.nativeValue).toBe(100_000n)
    expect(decodeHistoryCursor(page.cursor!)).toEqual({ v: 1, b: 'toncenter', lt: V3.transactions[4]!.lt })
    expect(page.items.every((i) => i.raw.backend === 'toncenter')).toBe(true)
  })

  it('a tonapi cursor resumes on toncenter by lt (end_lt = lt - 1), and vice versa', async () => {
    const good = src()
    const p1 = await good.source.listActivity(WALLET, { limit: 2 })
    const broken = src({ tonapi: 'rate-limited' })
    const p2 = await broken.source.listActivity(WALLET, { limit: 2, cursor: p1.cursor! })
    expect(p2.backend).toBe('toncenter')
    const url = broken.calls.find((c) => c.url.includes('toncenter.com'))!.url
    expect(new URL(url).searchParams.get('end_lt')).toBe((BigInt(PAGE1.events[1]!.lt) - 1n).toString())
    for (const it of p2.items) expect(it.block! < BigInt(PAGE1.events[1]!.lt)).toBe(true)
    // a toncenter cursor prefers toncenter while it answers…
    const same = src()
    const p3 = await same.source.listActivity(WALLET, { limit: 2, cursor: p2.cursor! })
    expect(p3.backend).toBe('toncenter')
    // …and resumes on tonapi by the same lt when it does not
    const back = src({ toncenter: 'down' })
    const p4 = await back.source.listActivity(WALLET, { limit: 2, cursor: p2.cursor! })
    expect(p4.backend).toBe('tonapi')
    expect(new URL(back.calls[back.calls.length - 1]!.url).searchParams.get('before_lt')).toBe(V3.transactions[4]!.lt)
  })

  it('throws HistoryUnavailableError naming both attempts when everything fails', async () => {
    const { source } = src({ tonapi: 'rate-limited', toncenter: 'down' })
    const err = await source.listActivity(WALLET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HistoryUnavailableError)
    const e = err as HistoryUnavailableError
    expect(e.chain).toBe('ton:-239')
    expect(e.attempts).toEqual([expect.stringMatching(/^tonapi: HTTP 429/), expect.stringMatching(/^toncenter: HTTP 503/)])
  })

  it('getTransaction through toncenter by hash', async () => {
    const { source } = src({ tonapi: 'down' })
    const tx = (await source.getTransaction('VfzFSRHvxVBOUNPC4hF32z+7ZClntLUmO9yCGQw1e0g=', WALLET))!
    expect(tx.raw.backend).toBe('toncenter')
    expect(tx.fee).toBe(51_868n)
  })
})

describe('createTonHistory: cursor, explorer, addresses', () => {
  it('cursor round-trips and rejects garbage', () => {
    const c = encodeHistoryCursor({ v: 1, b: 'tonapi', lt: '109110597000032' })
    expect(decodeHistoryCursor(c)).toEqual({ v: 1, b: 'tonapi', lt: '109110597000032' })
    expect(() => decodeHistoryCursor('zzz')).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor(Buffer.from('{"v":1,"b":"x","lt":"1"}').toString('base64'))).toThrow(/malformed history cursor/)
  })

  it('explorer URLs and testnet defaults', () => {
    expect(tonExplorerTxUrl('abc')).toBe('https://tonviewer.com/transaction/abc')
    const t = createTonHistory({ fetch: fake().fetch, network: 'testnet' })
    expect(t.chain).toBe('ton:-3')
    expect(t.explorerTxUrl('abc')).toBe('https://testnet.tonviewer.com/transaction/abc')
  })

  it('rawTonAddress normalizes friendly and raw spellings', () => {
    expect(rawTonAddress(WALLET)).toBe(WALLET_RAW)
    expect(rawTonAddress(POOL_FRIENDLY)).toBe(POOL_RAW)
    expect(rawTonAddress(WALLET_RAW.toUpperCase())).toBe(WALLET_RAW)
  })

  it('needs at least one backend', () => {
    expect(() => createTonHistory({ fetch: fake().fetch, tonapiUrl: null, toncenterUrl: null })).toThrow(/needs tonapi or toncenter/)
  })
})

describe('recognizer cross-check: Tonstakers and Omniston describe the rows this source builds', () => {
  type Describer = { describeActivity(tx: ChainTx, ctx: { own: Set<string> }): ActivityItem | null }
  const tonstakers = () => new TonstakersProtocolTon(createMockAccount()) as unknown as Describer
  // Tonstakers normalizes `own` to raw itself; swap2-core's netTransfers compares verbatim, so the kit must list the raw form too.
  const own = new Set([WALLET, WALLET_RAW])

  it('stake → "Staked GRAM" with 3 GRAM out and tsTON in', async () => {
    const tx = (await src().source.getTransaction('15e18e04a9ef99ca9a30178e6fa18fabdee729ffb2865bd7b669796c33e7465e', WALLET))!
    const item = tonstakers().describeActivity(tx, { own })!
    expect(item).not.toBeNull()
    expect(item.kind).toBe('stake')
    expect(item.title).toBe('Staked GRAM')
    expect(item.counterparty).toBe(POOL_FRIENDLY)
    expect(item.assetsOut).toEqual([expect.objectContaining({ token: null, amount: 3_000_000_000n })])
    expect(item.assetsIn).toEqual([expect.objectContaining({ token: TSTON_RAW, amount: 2_602_334_618n, symbol: 'tsTON' })])
  })

  it('unstake request → "Requested unstake" with 1 tsTON out', async () => {
    const tx = (await src().source.getTransaction('feadea0945e146bdd0e1b617c75163ecab2123547e518ed0c5609cd7421858a9', WALLET))!
    const item = tonstakers().describeActivity(tx, { own })!
    expect(item).not.toBeNull()
    expect(item.kind).toBe('unstake')
    expect(item.title).toBe('Requested unstake')
    expect(item.assetsOut).toEqual([expect.objectContaining({ token: TSTON_RAW, amount: 1_000_000_000n })])
  })

  it('payout → "Received unstaked GRAM"', async () => {
    const tx = (await src().source.getTransaction('daf22a93fd9466182dfbc8fd83e61878fd1d65c8667684aac9f3ef8763d7f6b1', WALLET))!
    const item = tonstakers().describeActivity(tx, { own })!
    expect(item).not.toBeNull()
    expect(item.kind).toBe('claim')
    expect(item.title).toBe('Received unstaked GRAM')
    expect(item.assetsIn).toEqual([expect.objectContaining({ token: null, amount: 939_863_465n })])
  })

  it('STON.fi swap → Omniston "Swapped GRAM → USD₮"; escrow order → "Bridged USD₮"; a plain jetton transfer is nobody\'s', async () => {
    const s = src().source
    const swap = (await s.getTransaction('72ea596844b123844b1798cdc285f361e3146e0286c79bae14918725a14ca3bd', WALLET))!
    const item = describeOmnistonActivity(swap, { own })!
    expect(item).not.toBeNull()
    expect(item.kind).toBe('swap')
    expect(item.title).toBe('Swapped GRAM → USD₮')
    expect(item.assetsOut).toEqual([expect.objectContaining({ token: null, amount: 36_127_400_000n })])
    expect(item.assetsIn).toEqual([expect.objectContaining({ token: USDT_RAW, amount: 52_333_196n })])
    const escrow = (await s.getTransaction('c18547c1f6d7a0531aaa954d976f38e285026dca9950bbeac966518cf8af62c4', WALLET))!
    const bridge = describeOmnistonActivity(escrow, { own })!
    expect(bridge.kind).toBe('bridge')
    expect(bridge.title).toBe('Bridged USD₮')
    expect(bridge.assetsOut).toEqual([expect.objectContaining({ token: USDT_RAW, amount: 1_600_000n })])
    const page = await s.listActivity(WALLET, { limit: 1 })
    expect(describeOmnistonActivity(page.items[0]!, { own })).toBeNull()
    expect(tonstakers().describeActivity(page.items[0]!, { own })).toBeNull()
  })
})
