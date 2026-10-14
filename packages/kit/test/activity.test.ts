import { describe, expect, it, vi } from 'vitest'
import { WalletManager, type ActivityItem, type ChainTx, type DescribeActivityContext, type FeeRates, type HistoryPage, type HistoryQuery, type HistorySource, type IWalletAccount, type IWalletAccountReadOnly, type Signer } from '@forgewallet/core'
import { LendingProtocol } from '@forgewallet/core'
import { createMockAccount } from '@forgewallet/conformance'
import {
  InvalidCursorError, Wallet, applyIntent, buildFeed, createMemoryIntentJournal, describeGeneric, nativeOf, packCursor, unpackCursor,
  type ActivityErrorReport, type ActivityRecognizer, type Intent,
} from '../src/index.js'

const OWN = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const OWN_LC = OWN.toLowerCase()
const OTHER = '0x000000000000000000000000000000000000bEEF'
const SPENDER = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE = 'eip155:8453', ETH = 'eip155:1', TON = 'ton:-239'
const ctx: DescribeActivityContext = { own: new Set([OWN, OWN_LC]) }

const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const approveData = (spender: string, amount: bigint) => `0x095ea7b3${pad(spender)}${pad(amount.toString(16))}`
const transferData = (to: string, amount: bigint) => `0xa9059cbb${pad(to)}${pad(amount.toString(16))}`

let seq = 0
function tx(chain: string, time: number, over: Partial<ChainTx> = {}): ChainTx {
  seq++
  return { chain, hash: `0x${seq.toString(16).padStart(4, '0')}${pad(String(time))}`.slice(0, 66), time, status: 'confirmed', address: OWN, from: OWN, to: OTHER, nativeValue: 0n, transfers: [], ...over }
}
const native = (from: string, to: string, amount: bigint) => ({ token: null, from, to, amount })
const erc20 = (token: string, from: string, to: string, amount: bigint, symbol?: string, decimals?: number) =>
  ({ token, from, to, amount, standard: 'erc20' as const, ...(symbol ? { symbol } : {}), ...(decimals !== undefined ? { decimals } : {}) })

/** Explorer stand-in: rows newest first, fixed page size, numeric offset cursors; `late` rows only answer `getTransaction`. */
class FakeSource implements HistorySource {
  calls: Array<HistoryQuery | undefined> = []
  failNext = 0
  constructor(readonly chain: string, public rows: ChainTx[], private readonly pageSize: number, public late: ChainTx[] = []) {}
  async listActivity(_address: string, q?: HistoryQuery): Promise<HistoryPage> {
    this.calls.push(q)
    if (this.failNext > 0) { this.failNext--; throw new Error(`${this.chain} explorer down`) }
    const start = q?.cursor ? Number(q.cursor) : 0
    const items = this.rows.slice(start, start + this.pageSize)
    const next = start + this.pageSize < this.rows.length ? String(start + this.pageSize) : undefined
    return next === undefined ? { items } : { items, cursor: next }
  }
  async getTransaction(hash: string): Promise<ChainTx | undefined> { return this.late.find((t) => t.hash === hash) ?? this.rows.find((t) => t.hash === hash) }
  explorerTxUrl(hash: string): string { return `https://scan/${this.chain}/${hash}` }
}

const FAKE_PROTOCOL = '@forgewallet/protocol-fake'
/** Recognizes calls to one contract. */
const recognizerFor = (contract: string, name = 'fake'): ActivityRecognizer => ({
  name,
  describe(t: ChainTx, c: DescribeActivityContext): ActivityItem | null {
    if (t.call?.to.toLowerCase() !== contract.toLowerCase()) return null
    expect(c.own.has(OWN_LC)).toBe(true)
    return { id: `${t.chain}:${t.hash}`, chain: t.chain, hash: t.hash, time: t.time, status: t.status, kind: 'supply', protocol: FAKE_PROTOCOL, title: 'Supplied USDC', subtitle: 'Fake v3', assetsOut: [], assetsIn: [] }
  },
})
const throwing: ActivityRecognizer = { name: 'broken', describe() { throw new Error('boom') } }

const addresses = (...chains: string[]) => chains.map((chain) => ({ chain, address: OWN }))
const ids = (items: { id: string }[]) => items.map((i) => i.id)

describe('describeGeneric', () => {
  it('send: own → others, native, with the chain symbol and the recipient as subtitle', () => {
    const t = tx(BASE, 100, { nativeValue: 10n ** 18n, transfers: [native(OWN, OTHER, 10n ** 18n)] })
    const item = describeGeneric(t, ctx)
    expect(item.kind).toBe('send')
    expect(item.title).toBe('Sent ETH')
    expect(item.assetsOut).toEqual([{ token: null, amount: 10n ** 18n, symbol: 'ETH', decimals: 18 }])
    expect(item.assetsIn).toEqual([])
    expect(item.counterparty).toBe(OTHER)
    expect(item.subtitle).toBe('0x0000…bEEF')
  })
  it('send: counts a top-level native value the source did not mirror in transfers, once', () => {
    const t = tx(ETH, 100, { nativeValue: 5n })
    expect(describeGeneric(t, ctx).assetsOut).toEqual([{ token: null, amount: 5n, symbol: 'ETH', decimals: 18 }])
    const mirrored = tx(ETH, 100, { nativeValue: 5n, transfers: [native(OWN, OTHER, 5n)] })
    expect(describeGeneric(mirrored, ctx).assetsOut[0]!.amount).toBe(5n)
  })
  it('send: ERC-20 transfer call is a send, symbol from the transfer row; catalog fills missing metadata', () => {
    const t = tx(BASE, 100, { to: USDC_BASE, call: { to: USDC_BASE, selector: '0xa9059cbb' }, transfers: [erc20(USDC_BASE, OWN, OTHER, 5_000_000n)] })
    const item = describeGeneric(t, ctx)
    expect(item.kind).toBe('send')
    expect(item.title).toBe('Sent USDC')
    expect(item.assetsOut[0]).toMatchObject({ token: USDC_BASE, amount: 5_000_000n, symbol: 'USDC', decimals: 6 })
    expect(item.counterparty).toBe(OTHER)
  })
  it('receive: others → own; the sender is the counterparty', () => {
    const t = tx(ETH, 100, { from: OTHER, to: OWN, nativeValue: 7n, transfers: [native(OTHER, OWN, 7n)] })
    const item = describeGeneric(t, ctx)
    expect(item.kind).toBe('receive')
    expect(item.title).toBe('Received ETH')
    expect(item.assetsIn).toEqual([{ token: null, amount: 7n, symbol: 'ETH', decimals: 18 }])
    expect(item.counterparty).toBe(OTHER)
  })
  it('receive: a token airdrop sent through someone else\'s contract call is still a receive', () => {
    const t = tx(ETH, 100, { from: OTHER, to: '0x1111111111111111111111111111111111111111', call: { to: '0x1111111111111111111111111111111111111111', selector: '0xdeadbeef' }, transfers: [erc20(USDC_BASE, OTHER, OWN, 1n, 'FOO', 18)] })
    expect(describeGeneric(t, ctx).kind).toBe('receive')
  })
  it('self: own → own moves nothing net; the moved amount is reported', () => {
    const second = '0x2222222222222222222222222222222222222222'
    const c: DescribeActivityContext = { own: new Set([OWN_LC, second]) }
    const t = tx(ETH, 100, { to: second, nativeValue: 3n, transfers: [native(OWN, second, 3n)] })
    const item = describeGeneric(t, c)
    expect(item.kind).toBe('self')
    expect(item.title).toBe('Self-transfer')
    expect(item.assetsOut).toEqual([{ token: null, amount: 3n, symbol: 'ETH', decimals: 18 }])
  })
  it('approve: ERC-20 approve with spender and amount; unlimited reads as null', () => {
    const t = tx(BASE, 100, { to: USDC_BASE, call: { to: USDC_BASE, selector: '0x095ea7b3', data: approveData(SPENDER, 1_000_000n) } })
    const item = describeGeneric(t, ctx, { known: { [BASE]: { [SPENDER.toLowerCase()]: 'Permit2' } } })
    expect(item.kind).toBe('approve')
    expect(item.title).toBe('Approved USDC for Permit2')
    expect(item.approval).toEqual({ token: USDC_BASE, spender: SPENDER.toLowerCase(), amount: 1_000_000n })
    expect(item.counterparty).toBe(SPENDER.toLowerCase())
    const max = tx(BASE, 100, { to: USDC_BASE, call: { to: USDC_BASE, data: approveData(SPENDER, (1n << 256n) - 1n) } })
    expect(describeGeneric(max, ctx).approval?.amount).toBeNull()
  })
  it('revoke: zero-amount approve', () => {
    const t = tx(BASE, 100, { to: USDC_BASE, call: { to: USDC_BASE, selector: '0x095ea7b3', data: approveData(SPENDER, 0n) } })
    const item = describeGeneric(t, ctx)
    expect(item.kind).toBe('revoke')
    expect(item.title).toBe('Revoked USDC for 0x0000…8ba3')
    expect(item.approval?.amount).toBe(0n)
  })
  it('contract: any other call by the owner, subtitle from the known-label table or the short address, amounts attached', () => {
    const router = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'
    const t = tx(BASE, 100, { to: router, call: { to: router, selector: '0x3593564c' }, nativeValue: 10n, transfers: [native(OWN, router, 10n), erc20(USDC_BASE, router, OWN, 25n)] })
    const labelled = describeGeneric(t, ctx, { known: { [BASE]: { [router]: 'Uniswap Universal Router' } } })
    expect(labelled.kind).toBe('contract')
    expect(labelled.title).toBe('Contract call')
    expect(labelled.subtitle).toBe('Uniswap Universal Router')
    expect(labelled.counterparty).toBe(router)
    expect(labelled.assetsOut).toEqual([{ token: null, amount: 10n, symbol: 'ETH', decimals: 18 }])
    expect(labelled.assetsIn[0]).toMatchObject({ token: USDC_BASE, amount: 25n, symbol: 'USDC' })
    expect(describeGeneric(t, ctx).subtitle).toBe('0x3fC9…7FAD')
  })
  it('unknown: nothing moved and no call we can see', () => {
    const t = tx(ETH, 100, { from: OTHER, to: '0x3333333333333333333333333333333333333333' })
    const item = describeGeneric(t, ctx)
    expect(item.kind).toBe('unknown')
    expect(item.title).toBe('Transaction')
  })
  it('failed sends keep the intended amount: native, and ERC-20 from calldata', () => {
    const n = describeGeneric(tx(ETH, 100, { status: 'failed', nativeValue: 9n }), ctx)
    expect(n.kind).toBe('send')
    expect(n.assetsOut).toEqual([{ token: null, amount: 9n, symbol: 'ETH', decimals: 18 }])
    const e = describeGeneric(tx(BASE, 100, { status: 'failed', to: USDC_BASE, call: { to: USDC_BASE, data: transferData(OTHER, 42n) } }), ctx)
    expect(e.kind).toBe('send')
    expect(e.assetsOut[0]).toMatchObject({ token: USDC_BASE, amount: 42n, symbol: 'USDC' })
    expect(e.counterparty).toBe(OTHER.toLowerCase())
    expect(e.status).toBe('failed')
  })
  it('spam from raw.spam or tx.spam', () => {
    const a = tx(ETH, 100, { from: OTHER, to: OWN, transfers: [erc20('0x4444444444444444444444444444444444444444', OTHER, OWN, 0n, 'V1SIT', 18)], raw: { spam: true, spamReason: 'zero-value' } })
    expect(describeGeneric(a, ctx).spam).toBe(true)
    const b = { ...tx(ETH, 100, { from: OTHER, to: OWN }), spam: true } as ChainTx
    expect(describeGeneric(b, ctx).spam).toBe(true)
    expect(describeGeneric(tx(ETH, 100), ctx).spam).toBeUndefined()
  })
  it('native symbols: GRAM on TON, catalog natives on EVM chains, namespace fallbacks, caller overrides', () => {
    expect(nativeOf(TON)).toEqual({ symbol: 'GRAM', decimals: 9 })
    expect(nativeOf('eip155:56')).toEqual({ symbol: 'BNB', decimals: 18 })
    expect(nativeOf('eip155:137').symbol).toBe('POL')
    expect(nativeOf('eip155:43114').symbol).toBe('AVAX')
    expect(nativeOf('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp').symbol).toBe('SOL')
    expect(nativeOf('tron:0x2b6653dc').symbol).toBe('TRX')
    expect(nativeOf('bip122:000000000019d6689c085ae165831e93').symbol).toBe('BTC')
    expect(nativeOf('near:mainnet')).toEqual({ symbol: 'NEAR', decimals: 24 })
    expect(nativeOf('eip155:999999').symbol).toBe('ETH')
    expect(nativeOf(TON, { natives: { [TON]: { symbol: 'TON', decimals: 9 } } }).symbol).toBe('TON')
    const t = tx(TON, 100, { address: 'UQown', from: 'UQown', to: 'UQother', nativeValue: 5n, transfers: [native('UQown', 'UQother', 5n)] })
    expect(describeGeneric(t, { own: new Set(['UQown']) }).title).toBe('Sent GRAM')
  })
  it('explorer url from the options', () => {
    expect(describeGeneric(tx(ETH, 100), ctx, { explorerUrl: (c, h) => `https://e/${c}/${h}` }).explorerUrl).toMatch(/^https:\/\/e\/eip155:1\/0x/)
  })
})

describe('cursor', () => {
  it('round-trips and rejects foreign strings', () => {
    const c = packCursor({ 'eip155:1|0xa': { c: '20', n: 3 }, 'eip155:8453|0xa': { n: 1 } })!
    expect(unpackCursor(c)).toEqual({ 'eip155:1|0xa': { c: '20', n: 3 }, 'eip155:8453|0xa': { n: 1 } })
    expect(packCursor({})).toBeUndefined()
    expect(unpackCursor(undefined)).toBeUndefined()
    expect(() => unpackCursor('nope')).toThrow(InvalidCursorError)
    expect(() => unpackCursor('fw1:{"a":{"n":-1}}')).toThrow(InvalidCursorError)
  })
})

describe('buildFeed', () => {
  const contract = '0xAAAA000000000000000000000000000000000001'
  const rowsEth = [
    tx(ETH, 500, { to: contract, call: { to: contract, selector: '0x12345678' } }),             // recognized
    tx(ETH, 300, { nativeValue: 1n, transfers: [native(OWN, OTHER, 1n)] }),                       // send
    tx(ETH, 100, { from: OTHER, to: OWN, transfers: [erc20(USDC_BASE, OTHER, OWN, 0n, 'SCAM', 18)], raw: { spam: true } }), // spam
  ]
  const rowsBase = [
    tx(BASE, 400, { from: OTHER, to: OWN, nativeValue: 2n, transfers: [native(OTHER, OWN, 2n)] }), // receive
    tx(BASE, 200, { to: USDC_BASE, call: { to: USDC_BASE, data: approveData(SPENDER, 0n) } }),       // revoke
  ]
  const feed = (over: Partial<Parameters<typeof buildFeed>[0]> = {}, query: Parameters<typeof buildFeed>[0]['query'] = {}) =>
    buildFeed({ sources: new Map<string, HistorySource>([[ETH, new FakeSource(ETH, rowsEth, 10)], [BASE, new FakeSource(BASE, rowsBase, 10)]]), addresses: addresses(ETH, BASE), recognizers: [recognizerFor(contract)], query, opts: {}, ...over })

  it('merges two chains newest-first, recognizer first then generic, spam hidden, explorer urls from the sources', async () => {
    const page = await feed()
    expect(page.items.map((i) => [i.chain, i.time, i.kind])).toEqual([[ETH, 500, 'supply'], [BASE, 400, 'receive'], [ETH, 300, 'send'], [BASE, 200, 'revoke']])
    expect(page.items[0]!.protocol).toBe(FAKE_PROTOCOL)
    expect(page.items[1]!.protocol).toBeUndefined()
    expect(page.items[1]!.explorerUrl).toBe(`https://scan/${BASE}/${rowsBase[0]!.hash}`)
    expect(page.cursor).toBeUndefined()
    expect(page.errors).toBeUndefined()
  })
  it('includeSpam shows the flagged row; chains filter narrows the sources', async () => {
    const all = await feed({}, { includeSpam: true })
    expect(all.items).toHaveLength(5)
    expect(all.items[4]!.spam).toBe(true)
    const only = await feed({}, { chains: [BASE] })
    expect(only.items.map((i) => i.chain)).toEqual([BASE, BASE])
  })
  it('a throwing recognizer is isolated: reported, the next recognizer and the fallback still run', async () => {
    const onError = vi.fn()
    const page = await feed({ recognizers: [throwing, recognizerFor(contract)], opts: { onError } })
    expect(page.items.map((i) => i.kind)).toEqual(['supply', 'receive', 'send', 'revoke'])
    expect(onError).toHaveBeenCalledTimes(5) // every row, spam included
    expect(onError.mock.calls[0]![0]).toMatchObject({ stage: 'recognizer', module: 'broken', chain: ETH })
    expect(page.errors).toHaveLength(5)
  })
  it('a failing source is isolated: the other chain is served, the failure is in-band, the cursor retries it next call', async () => {
    const eth = new FakeSource(ETH, rowsEth, 10)
    eth.failNext = 1
    const sources = new Map<string, HistorySource>([[ETH, eth], [BASE, new FakeSource(BASE, rowsBase, 10)]])
    const p1 = await feed({ sources })
    expect(p1.items.map((i) => i.chain)).toEqual([BASE, BASE])
    expect(p1.errors).toEqual([expect.objectContaining({ stage: 'source', chain: ETH, address: OWN })])
    expect(p1.cursor).toBeDefined()
    const p2 = await feed({ sources }, { cursor: p1.cursor! })
    expect(p2.items.map((i) => [i.chain, i.time])).toEqual([[ETH, 500], [ETH, 300]])
    expect(p2.cursor).toBeUndefined()
  })

  it('pagination: cursor round-trip across two chains with different page sizes yields every row once, in order', async () => {
    const times = (n: number, step: number, start: number) => Array.from({ length: n }, (_, i) => start - i * step)
    const a = times(11, 7, 1000).map((t) => tx(ETH, t, { nativeValue: 1n }))
    const b = times(7, 11, 995).map((t) => tx(BASE, t, { from: OTHER, to: OWN, nativeValue: 1n }))
    const sources = new Map<string, HistorySource>([[ETH, new FakeSource(ETH, a, 3)], [BASE, new FakeSource(BASE, b, 2)]])
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await buildFeed({ sources, addresses: addresses(ETH, BASE), recognizers: [], query: { limit: 4, ...(cursor ? { cursor } : {}) }, opts: {} })
      expect(page.items.length).toBeLessThanOrEqual(4)
      seen.push(...ids(page.items))
      cursor = page.cursor
      if (++pages > 20) throw new Error('cursor never ended')
    } while (cursor)
    const expected = [...a, ...b].sort((x, y) => y.time - x.time).map((t) => `${t.chain}:${t.hash}`)
    expect(seen).toEqual(expected)
  })
  it('pagination: a chain whose short page was fully consumed holds back older rows of the other chain', async () => {
    // ETH page 1 has 2 rows (1000, 900) and more pages; BASE has 5 rows 950..550 in one page. Page 1 must stop at 900.
    const a = [1000, 900, 800, 700].map((t) => tx(ETH, t, { nativeValue: 1n }))
    const b = [950, 850, 750, 650, 550].map((t) => tx(BASE, t, { nativeValue: 1n }))
    const sources = new Map<string, HistorySource>([[ETH, new FakeSource(ETH, a, 2)], [BASE, new FakeSource(BASE, b, 10)]])
    const p1 = await buildFeed({ sources, addresses: addresses(ETH, BASE), recognizers: [], query: { limit: 10 }, opts: {} })
    expect(p1.items.map((i) => i.time)).toEqual([1000, 950, 900])
    const p2 = await buildFeed({ sources, addresses: addresses(ETH, BASE), recognizers: [], query: { limit: 10, cursor: p1.cursor! }, opts: {} })
    expect(p2.items.map((i) => i.time)).toEqual([850, 800, 750, 700, 650, 550])
    expect(p2.cursor).toBeUndefined()
  })
  it('pagination: empty pages with a cursor (block windows) are followed', async () => {
    const rows = [tx(ETH, 100, { nativeValue: 1n })]
    const src: HistorySource = {
      chain: ETH,
      async listActivity(_a, q) { const n = Number(q?.cursor ?? '0'); return n < 2 ? { items: [], cursor: String(n + 1) } : { items: rows } },
      async getTransaction() { return undefined },
      explorerTxUrl: (h) => h,
    }
    const page = await buildFeed({ sources: new Map([[ETH, src]]), addresses: addresses(ETH), recognizers: [], query: {}, opts: {} })
    expect(page.items).toHaveLength(1)
    expect(page.cursor).toBeUndefined()
  })
  it('two own addresses on one chain: a shared row is described once with both in `own`', async () => {
    const second = '0x2222222222222222222222222222222222222222'
    const shared = tx(ETH, 100, { to: second, nativeValue: 3n, transfers: [native(OWN, second, 3n)] })
    const src = new FakeSource(ETH, [shared], 10)
    const page = await buildFeed({ sources: new Map([[ETH, src]]), addresses: [{ chain: ETH, address: OWN }, { chain: ETH, address: second }], recognizers: [], query: {}, opts: {} })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.kind).toBe('self')
  })
})

describe('intent journal', () => {
  const lifi = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
  const swapIntent = (over: Partial<Intent> = {}): Intent => ({
    id: 'swap-1', kind: 'swap', createdAt: 1000, chain: ETH, address: OWN, status: 'pending',
    hashes: [{ chain: ETH, hash: '0xsrc' }],
    expect: { assetsOut: [{ token: USDC_BASE, amount: 5_000_000n, symbol: 'USDC', decimals: 6 }], assetsIn: [{ token: null, amount: 10n ** 15n, symbol: 'ETH', decimals: 18 }] },
    protocol: '@forgewallet/protocol-swap2-lifi', subtitle: 'LI.FI', ...over,
  })
  const run = (sources: Map<string, HistorySource>, journal: ReturnType<typeof createMemoryIntentJournal>, query: Record<string, unknown> = {}, now = 2000) =>
    buildFeed({ sources, addresses: addresses(ETH, BASE), recognizers: [], journal, query, opts: { now: () => now } })

  it('pending: no row yet → a pending item at the top; then the row arrives and inherits kind / protocol / subtitle, the journal flips to confirmed', async () => {
    const eth = new FakeSource(ETH, [tx(ETH, 900, { nativeValue: 1n })], 10)
    const base = new FakeSource(BASE, [], 10)
    const sources = new Map<string, HistorySource>([[ETH, eth], [BASE, base]])
    const journal = createMemoryIntentJournal([swapIntent()])
    const p1 = await run(sources, journal)
    expect(p1.items.map((i) => [i.id, i.status, i.kind])).toEqual([['intent:swap-1', 'pending', 'swap'], [`${ETH}:${eth.rows[0]!.hash}`, 'confirmed', 'send']])
    expect(p1.items[0]!.title).toBe('Swapped USDC → ETH')
    expect(p1.items[0]!.subtitle).toBe('LI.FI')
    expect((await journal.list())[0]!.status).toBe('pending')

    // The explorer indexes the row: a generic "send" of USDC to the LI.FI diamond.
    eth.rows.unshift({ ...tx(ETH, 1001, { to: lifi, call: { to: lifi, selector: '0x4666fc80' }, transfers: [erc20(USDC_BASE, OWN, lifi, 5_000_000n, 'USDC', 6)] }), hash: '0xsrc' })
    const p2 = await run(sources, journal)
    expect(p2.items.map((i) => i.id)).toEqual([`${ETH}:0xsrc`, `${ETH}:${eth.rows[1]!.hash}`])
    const item = p2.items[0]!
    expect(item.kind).toBe('swap')
    expect(item.protocol).toBe('@forgewallet/protocol-swap2-lifi')
    expect(item.subtitle).toBe('LI.FI')
    expect(item.intentId).toBe('swap-1')
    expect(item.assetsOut[0]!.amount).toBe(5_000_000n) // on-chain
    expect(item.assetsIn).toEqual(swapIntent().expect!.assetsIn) // expected, the chain showed nothing arriving
    expect(item.title).toBe('Swapped USDC → ETH')
    expect((await journal.list())[0]!.status).toBe('confirmed')
  })
  it('a recognizer\'s verdict is kept (only generic items inherit), but the item still learns its intent and legs', async () => {
    const row = { ...tx(ETH, 1001, { to: lifi, call: { to: lifi, selector: '0x4666fc80' } }), hash: '0xsrc' }
    const sources = new Map<string, HistorySource>([[ETH, new FakeSource(ETH, [row], 10)], [BASE, new FakeSource(BASE, [], 10)]])
    const journal = createMemoryIntentJournal([swapIntent({ kind: 'bridge', related: [{ chain: BASE, hash: '0xfill' }] })])
    const page = await buildFeed({ sources, addresses: addresses(ETH, BASE), recognizers: [recognizerFor(lifi)], journal, query: {}, opts: {} })
    expect(page.items[0]).toMatchObject({ kind: 'supply', protocol: FAKE_PROTOCOL, intentId: 'swap-1', related: [{ chain: BASE, hash: '0xfill' }] })
  })
  it('indexer lag: the row is not on the page but getTransaction finds it → emitted confirmed, journal updated', async () => {
    const late = { ...tx(ETH, 1001, { to: lifi, call: { to: lifi, selector: '0x4666fc80' }, transfers: [erc20(USDC_BASE, OWN, lifi, 5_000_000n, 'USDC', 6)] }), hash: '0xsrc' }
    const sources = new Map<string, HistorySource>([[ETH, new FakeSource(ETH, [], 10, [late])], [BASE, new FakeSource(BASE, [], 10)]])
    const journal = createMemoryIntentJournal([swapIntent()])
    const page = await run(sources, journal)
    expect(page.items.map((i) => [i.id, i.status, i.kind])).toEqual([[`${ETH}:0xsrc`, 'confirmed', 'swap']])
    expect((await journal.list())[0]!.status).toBe('confirmed')
  })
  it('cross-chain join: both legs on the page → one item with the destination amount and `related`; the second row is dropped', async () => {
    const src = { ...tx(ETH, 1001, { to: lifi, call: { to: lifi, selector: '0xbbbbbbbb' }, transfers: [erc20(USDC_BASE, OWN, lifi, 5_000_000n, 'USDC', 6)] }), hash: '0xsrc' }
    const dst = { ...tx(BASE, 1030, { from: OTHER, to: OWN, nativeValue: 999n, transfers: [native(OTHER, OWN, 999n)] }), hash: '0xdst' }
    const sources = new Map<string, HistorySource>([[ETH, new FakeSource(ETH, [src], 10)], [BASE, new FakeSource(BASE, [dst], 10)]])
    const journal = createMemoryIntentJournal([swapIntent({ kind: 'bridge', hashes: [{ chain: ETH, hash: '0xsrc' }, { chain: BASE, hash: '0xdst' }] })])
    const page = await run(sources, journal)
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item.id).toBe(`${ETH}:0xsrc`)
    expect(item.kind).toBe('bridge')
    expect(item.title).toBe('Bridged USDC → ETH')
    expect(item.assetsOut[0]!.amount).toBe(5_000_000n)
    expect(item.assetsIn).toEqual([{ token: null, amount: 999n, symbol: 'ETH', decimals: 18 }])
    expect(item.related).toEqual([{ chain: BASE, hash: '0xdst' }])
    expect(item.intentId).toBe('swap-1')
    expect((await journal.list())[0]!.status).toBe('confirmed')
  })
  it('ttl: a pending intent older than pendingTtl with no row becomes failed (emitted and persisted); confirmed intents with no row are silent', async () => {
    const sources = new Map<string, HistorySource>([[ETH, new FakeSource(ETH, [], 10)], [BASE, new FakeSource(BASE, [], 10)]])
    const journal = createMemoryIntentJournal([swapIntent(), swapIntent({ id: 'old', status: 'confirmed' })])
    const fresh = await run(sources, journal, {}, 1000 + 86_400)
    expect(fresh.items.map((i) => [i.id, i.status])).toEqual([['intent:swap-1', 'pending']])
    const stale = await run(sources, journal, {}, 1000 + 86_401)
    expect(stale.items.map((i) => [i.id, i.status])).toEqual([['intent:swap-1', 'failed']])
    expect((await journal.list()).find((i) => i.id === 'swap-1')!.status).toBe('failed')
    // Still shown as failed until the app removes it; not on later pages.
    expect((await run(sources, journal, {}, 1000 + 90_000)).items.map((i) => i.status)).toEqual(['failed'])
    await journal.remove('swap-1')
    expect((await run(sources, journal)).items).toEqual([])
  })
  it('pending intents only appear on the first page; a journal failure is isolated', async () => {
    const eth = new FakeSource(ETH, [tx(ETH, 900, { nativeValue: 1n }), tx(ETH, 800, { nativeValue: 1n })], 1)
    const sources = new Map<string, HistorySource>([[ETH, eth], [BASE, new FakeSource(BASE, [], 10)]])
    const journal = createMemoryIntentJournal([swapIntent()])
    const p1 = await run(sources, journal, { limit: 1 })
    expect(p1.items.map((i) => i.id)).toEqual(['intent:swap-1', `${ETH}:${eth.rows[0]!.hash}`])
    const p2 = await run(sources, journal, { limit: 1, cursor: p1.cursor })
    expect(p2.items.map((i) => i.id)).toEqual([`${ETH}:${eth.rows[1]!.hash}`])
    const broken = { ...journal, list: async () => { throw new Error('db locked') } }
    const errors: ActivityErrorReport[] = []
    const p3 = await buildFeed({ sources, addresses: addresses(ETH), recognizers: [], journal: broken, query: {}, opts: { onError: (e) => errors.push(e) } })
    expect(p3.items).toHaveLength(1) // page size 1, no pending rows without the journal
    expect(errors).toEqual([expect.objectContaining({ stage: 'journal' })])
  })
  it('applyIntent is pure: generic items inherit, recognized items only learn legs', () => {
    const generic = describeGeneric(tx(ETH, 1, { nativeValue: 1n }), ctx)
    const out = applyIntent(generic, swapIntent({ kind: 'stake', subtitle: 'Lido', expect: { assetsOut: [], assetsIn: [{ token: '0xst', amount: 1n, symbol: 'stETH' }] } }))
    expect(out).toMatchObject({ kind: 'stake', subtitle: 'Lido', title: 'Staked ETH', intentId: 'swap-1' })
    expect(out.assetsIn[0]!.symbol).toBe('stETH')
    expect(generic.kind).toBe('send')
  })
})

describe('Wallet.history / describeTransaction', () => {
  const SEED = 'test test test test test test test test test test test junk'
  class FakeManager extends WalletManager<IWalletAccount, { chain: string; address: string }> {
    constructor(seed: string | Signer, config: { chain: string; address: string }) { super(seed, config) }
    async getAccount(index = 0) { return this.getAccountByPath(`m/${index}`) }
    async getAccountByPath(path: string) {
      let a = this._accounts.get(path)
      if (!a) { a = createMockAccount({ chain: this._config.chain, address: this._config.address }); this._accounts.set(path, a) }
      return a
    }
    async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 2n, fast: 3n } }
  }
  const pool = '0xPOOL000000000000000000000000000000000001'
  class FakeAave extends LendingProtocol<{ pool: string }> {
    constructor(account: IWalletAccountReadOnly | IWalletAccount, config: { pool: string }) { super(account, config) }
    override describeActivity(t: ChainTx, c: DescribeActivityContext): ActivityItem | null {
      if (t.call?.to.toLowerCase() !== this._config.pool.toLowerCase()) return null
      expect(c.own.has(OWN_LC)).toBe(true)
      return { id: `${t.chain}:${t.hash}`, chain: t.chain, hash: t.hash, time: t.time, status: t.status, kind: 'supply', protocol: '@forgewallet/protocol-lending-aave-evm', title: 'Supplied USDC', subtitle: 'Aave v3 · Base', assetsOut: [], assetsIn: [] }
    }
  }

  it('resolves addresses from the registered wallets, runs registered protocols as recognizers, honours known labels', async () => {
    const rows = [
      tx(BASE, 300, { to: pool, call: { to: pool, selector: '0x617ba037' } }),
      tx(BASE, 200, { to: OTHER, call: { to: OTHER, selector: '0xdeadbeef' } }),
      tx(BASE, 100, { nativeValue: 1n }),
    ]
    const onError = vi.fn()
    const w = new Wallet(SEED, { activity: { known: { [BASE]: { [OTHER]: 'Treasury' } }, onError } })
    w.registerWallet('eip155', FakeManager, { chain: BASE, address: OWN })
    w.registerProtocol('aave', FakeAave, { chain: BASE, config: { pool } })
    w.registerProtocol('orphan', FakeAave, { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', config: { pool } }) // no wallet for its chain → skipped
    w.registerHistorySource(new FakeSource(BASE, rows, 10))
    expect(() => w.registerHistorySource(new FakeSource(BASE, [], 1))).toThrow(/already registered/)
    expect(w.historyChains).toEqual([BASE])

    const page = await w.history()
    expect(page.items.map((i) => [i.kind, i.subtitle])).toEqual([['supply', 'Aave v3 · Base'], ['contract', 'Treasury'], ['send', 'Treasury']])
    expect(page.items[2]!.explorerUrl).toBe(`https://scan/${BASE}/${rows[2]!.hash}`)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ stage: 'recognizer', module: 'orphan' }))

    const single = await w.describeTransaction(rows[0]!)
    expect(single.kind).toBe('supply')
    expect((await w.describeTransaction(rows[2]!)).kind).toBe('send')
    w.dispose()
  })
  it('intent journal through the kit: setIntentJournal, pending row, then describeTransaction inherits', async () => {
    const w = new Wallet(SEED)
    w.registerWallet('eip155', FakeManager, { chain: BASE, address: OWN })
    const src = new FakeSource(BASE, [], 10)
    w.registerHistorySource(src)
    const journal = createMemoryIntentJournal([{ id: 'earn-1', kind: 'supply', createdAt: Math.floor(Date.now() / 1000), chain: BASE, address: OWN, status: 'pending', hashes: [{ chain: BASE, hash: '0xdep' }], protocol: '@forgewallet/protocol-lending-aave-evm', subtitle: 'Aave v3 · Base', expect: { assetsOut: [{ token: USDC_BASE, amount: 1n, symbol: 'USDC', decimals: 6 }], assetsIn: [] } }])
    w.setIntentJournal(journal)
    const p1 = await w.history({ addresses: [{ chain: BASE, address: OWN }] })
    expect(p1.items.map((i) => [i.id, i.status, i.title])).toEqual([['intent:earn-1', 'pending', 'Supplied USDC']])
    const row = { ...tx(BASE, 20, { to: pool, call: { to: pool, selector: '0x617ba037' }, transfers: [erc20(USDC_BASE, OWN, pool, 1n)] }), hash: '0xdep' }
    const item = await w.describeTransaction(row)
    expect(item).toMatchObject({ kind: 'supply', protocol: '@forgewallet/protocol-lending-aave-evm', subtitle: 'Aave v3 · Base', intentId: 'earn-1', title: 'Supplied USDC' })
    w.dispose()
  })
})
