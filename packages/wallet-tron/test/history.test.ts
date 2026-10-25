import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HistoryUnavailableError, createTronHistory, decodeHistoryCursor, encodeHistoryCursor, tronExplorerTxUrl, toBase58Address,
  type FullNodeTxInfo, type HistoryFetch, type TronGridTrc20, type TronGridTx,
} from '../src/index.js'

const WALLET = 'TVSz6xJL2M53HDZyFTeDcGCmEDdwmU4zbv'
const OTHER = 'TCanhfMgr9RsFRoxkJ8YkJD8Faha85a14p'
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_TX = '65a8c50053aec9bd210a92a835f90ec61d7922e1c64768dda94bbeb44a9322b5'

const fx = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/history/${name}.json`, import.meta.url), 'utf8')) as T
const TXS: Record<string, TronGridTx[]> = {
  [WALLET]: fx<{ data: TronGridTx[] }>('trongrid-wallet-transactions').data,
  [OTHER]: fx<{ data: TronGridTx[] }>('trongrid-other-transactions').data,
}
const TRC20: Record<string, TronGridTrc20[]> = {
  [WALLET]: fx<{ data: TronGridTrc20[] }>('trongrid-wallet-trc20').data,
  [OTHER]: fx<{ data: TronGridTrc20[] }>('trongrid-other-trc20').data,
}
const INFO = fx<FullNodeTxInfo>('fullnode-gettransactioninfobyid')
const TX_BY_ID = fx<TronGridTx>('fullnode-gettransactionbyid')

interface FakeOptions {
  status?: number
  body?: unknown
}

function fake(opts: FakeOptions = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = []
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body })
  const fetch: HistoryFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, ...(init?.body !== undefined ? { body: init.body } : {}) })
    if (opts.status !== undefined) return json(opts.status, opts.body ?? { error: 'nope' })
    if (opts.body !== undefined) return json(200, opts.body)
    const u = new URL(url)
    if (init?.method === 'POST') {
      const { value } = JSON.parse(init.body ?? '{}') as { value: string }
      if (u.pathname === '/wallet/gettransactionbyid') return json(200, value === USDT_TX ? TX_BY_ID : {})
      if (u.pathname === '/wallet/gettransactioninfobyid') return json(200, value === USDT_TX ? INFO : {})
      return json(404, {})
    }
    const m = /^\/v1\/accounts\/([^/]+)\/transactions(\/trc20)?$/.exec(u.pathname)
    if (!m) return json(404, { success: false, error: `unmocked ${u.pathname}` })
    const limit = Number(u.searchParams.get('limit') ?? 20)
    const max = u.searchParams.get('max_timestamp')
    const min = u.searchParams.get('min_timestamp')
    const inRange = (ts: number) => (max === null || ts <= Number(max)) && (min === null || ts >= Number(min))
    // TronGrid pages along `meta.fingerprint` (opaque; here the offset of the next row).
    const fp = u.searchParams.get('fingerprint')
    const from = fp ? Number(Buffer.from(fp, 'base64').toString()) : 0
    const paged = <T>(all: T[]) => {
      const rows = all.slice(from, from + limit)
      const next = from + limit < all.length ? { fingerprint: Buffer.from(String(from + limit)).toString('base64') } : {}
      return json(200, { data: rows, success: true, meta: { at: 1, page_size: rows.length, ...next } })
    }
    if (m[2]) return paged((TRC20[m[1]!] ?? []).filter((r) => inRange(r.block_timestamp)))
    return paged((TXS[m[1]!] ?? []).filter((r) => inRange(r.block_timestamp ?? 0)))
  }
  return { fetch, calls }
}

const src = (opts: FakeOptions = {}, extra: Record<string, unknown> = {}) => {
  const f = fake(opts)
  return { ...f, source: createTronHistory({ fetch: f.fetch, rateLimit: 10_000, ...extra }) }
}

async function allPages(source: ReturnType<typeof createTronHistory>, address: string, limit: number) {
  const items = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await source.listActivity(address, { limit, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    cursor = page.cursor
    pages++
  } while (cursor && pages < 30)
  expect(cursor).toBeUndefined()
  return { items, pages }
}

describe('createTronHistory: pages', () => {
  it('maps the test wallet page: TRX in / out with fee, TRC-10 as token transfers, newest first, a position per list', async () => {
    const { source, calls } = src()
    expect(source.chain).toBe('tron:0x2b6653dc')
    const page = await source.listActivity(WALLET, { limit: 10 })
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([`/v1/accounts/${WALLET}/transactions`, `/v1/accounts/${WALLET}/transactions/trc20`])
    expect(page.items).toHaveLength(10)
    for (let i = 1; i < page.items.length; i++) expect(page.items[i - 1]!.time).toBeGreaterThanOrEqual(page.items[i]!.time)
    const out = page.items.find((i) => i.hash.startsWith('0b8adf5a1968'))!
    expect(out.from).toBe(WALLET)
    expect(out.to).toBe(OTHER)
    expect(out.nativeValue).toBe(21_000_000n)
    expect(out.transfers).toEqual([{ token: null, from: WALLET, to: OTHER, amount: 21_000_000n }])
    expect(out.fee, 'ret[0].fee (1 TRX account activation) beats net_fee + energy_fee = 0').toBe(1_000_000n)
    expect(out.status).toBe('confirmed')
    expect(out.block).toBe(86_968_021n)
    expect(out.time).toBe(1_791_576_861)
    expect(out.call).toBeUndefined()
    const trc10 = page.items.find((i) => i.hash.startsWith('a6ab67aeef39'))!
    expect(trc10.transfers).toEqual([{ token: '1005114', from: toBase58Address('41afcee3a50b422fbbdb78935c242980b36f6e4a09'), to: WALLET, amount: 8_888n, symbol: 'TRC-10 #1005114', decimals: 0 }])
    expect(trc10.raw.spam, 'an inbound TRC-10 from a stranger is flagged as an airdrop').toBe(true)
    expect(trc10.nativeValue).toBe(0n)
    expect(trc10.fee).toBe(0n)
    const inbound = page.items.find((i) => i.hash.startsWith('43ef38813a2f'))!
    expect(inbound.from).toBe('TX5XiRXdyz7sdFwF5mnhT1QoGCpbkncpke')
    expect(inbound.to).toBe(WALLET)
    expect(inbound.nativeValue).toBe(12_804_421n)
    // the wallet has 10 transactions and no TRC-20 rows: this page is the whole history
    expect(page.cursor).toBeUndefined()
    // a shorter page: each list continues from its own position; the empty TRC-20 list is done
    const first = await source.listActivity(WALLET, { limit: 4 })
    expect(first.items.map((i) => i.hash)).toEqual(page.items.slice(0, 4).map((i) => i.hash))
    expect(decodeHistoryCursor(first.cursor!)).toEqual({ v: 2, n: 20, s: { tx: { k: 4 }, trc20: null } })
  })

  it('pages to the end without losing or repeating a transaction, across both lists', async () => {
    const { source } = src()
    for (const [address, limit] of [[WALLET, 10], [WALLET, 3], [OTHER, 8], [OTHER, 2]] as const) {
      const { items } = await allPages(source, address, limit)
      const expected = new Set([...TXS[address]!.map((t) => t.txID), ...TRC20[address]!.map((t) => t.transaction_id)])
      expect(new Set(items.map((i) => i.hash)).size, `${address} limit ${limit}: duplicates`).toBe(items.length)
      expect(new Set(items.map((i) => i.hash)), `${address} limit ${limit}: coverage`).toEqual(expected)
      for (let i = 1; i < items.length; i++) expect(items[i - 1]!.time).toBeGreaterThanOrEqual(items[i]!.time)
    }
  })

  it('merges a TriggerSmartContract row with its TRC-20 list row: call with selector / data / method, token leg with symbol and decimals', async () => {
    const { source } = src()
    const { items } = await allPages(source, OTHER, 8)
    const tx = items.find((i) => i.hash === USDT_TX)!
    expect(tx.from).toBe(OTHER)
    expect(tx.to).toBe(USDT)
    expect(tx.call?.to).toBe(USDT)
    expect(tx.call?.selector).toBe('0xa9059cbb')
    expect(tx.call?.method).toBe('transfer')
    expect(tx.call?.data).toMatch(/^0xa9059cbb0{24}4d39d5c55cfeb48f44d680fcac20493635dafdee/)
    expect(tx.transfers).toEqual([{ token: USDT, from: OTHER, to: 'TH1YKH9MUuJtDmekPia4x9fZXAcpPrMv8B', amount: 10_815_498_031n, standard: 'trc20', symbol: 'USDT', decimals: 6 }])
    expect(tx.fee).toBe(7_428_500n)
    expect(tx.nativeValue).toBe(0n)
    expect(tx.raw.tx).toBeDefined()
    expect(tx.raw.trc20).toHaveLength(1)
    // a transfer someone else made to this address is known only from the TRC-20 list: no fee, no call, status confirmed
    const only = items.find((i) => i.hash.startsWith('ad524576'))!
    expect(only.raw.tx).toBeUndefined()
    expect(only.fee).toBeUndefined()
    expect(only.call).toBeUndefined()
    expect(only.to).toBe(OTHER)
    expect(only.transfers[0]).toMatchObject({ token: USDT, to: OTHER, amount: 5_000_000n, standard: 'trc20' })
    expect(only.status).toBe('confirmed')
  })

  it('`since` becomes min_timestamp (ms) on both lists', async () => {
    const { source, calls } = src()
    const page = await source.listActivity(WALLET, { limit: 10, since: 1_791_000_000 })
    for (const c of calls) expect(new URL(c.url).searchParams.get('min_timestamp')).toBe('1791000000000')
    expect(page.items.every((i) => i.time >= 1_791_000_000)).toBe(true)
    expect(page.items).toHaveLength(6)
  })
})

describe('createTronHistory: getTransaction', () => {
  it('reads the full node: exact fee, TRC-20 Transfer logs, block and time from the info', async () => {
    const { source, calls } = src()
    const tx = (await source.getTransaction(USDT_TX, OTHER))!
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/wallet/gettransactionbyid', '/wallet/gettransactioninfobyid'])
    expect(calls[0]!.body).toBe(JSON.stringify({ value: USDT_TX }))
    expect(tx.hash).toBe(USDT_TX)
    expect(tx.fee).toBe(7_428_500n)
    expect(tx.status).toBe('confirmed')
    expect(tx.block).toBe(87_036_981n)
    expect(tx.time).toBe(1_791_783_795)
    expect(tx.call).toMatchObject({ to: USDT, selector: '0xa9059cbb', method: 'transfer' })
    expect(tx.transfers).toEqual([{ token: USDT, from: OTHER, to: 'TH1YKH9MUuJtDmekPia4x9fZXAcpPrMv8B', amount: 10_815_498_031n, standard: 'trc20' }])
    expect(tx.raw.info).toBeDefined()
  })

  it('unknown hash → undefined', async () => {
    expect(await src().source.getTransaction('00'.repeat(32), OTHER)).toBeUndefined()
  })
})

describe('createTronHistory: cursor, errors, keys, explorer', () => {
  it('cursor round-trips and rejects garbage', () => {
    const c = encodeHistoryCursor({ v: 2, n: 20, s: { tx: { f: 'ZnA=', k: 3 }, trc20: null }, t: 1_788_250_521_000, g: 2 })
    expect(decodeHistoryCursor(c)).toEqual({ v: 2, n: 20, s: { tx: { f: 'ZnA=', k: 3 }, trc20: null }, t: 1_788_250_521_000, g: 2 })
    expect(decodeHistoryCursor(encodeHistoryCursor({ v: 2, n: 50, s: { tx: { k: 0 }, trc20: { k: 1 } } }))).toEqual({ v: 2, n: 50, s: { tx: { k: 0 }, trc20: { k: 1 } } })
    // the page size the positions were taken with is required and bounded
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 2, s: { tx: { k: 0 }, trc20: null } } as never))).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 2, n: 500, s: { tx: { k: 0 }, trc20: null } }))).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor('???')).toThrow(/malformed history cursor/)
    // a cursor from the time-window format (v1) is refused: start the listing again
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 1, w: 1, x: [], e: [] } as never))).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 2, n: 20, s: { tx: { k: -1 }, trc20: null } } as never))).toThrow(/malformed history cursor/)
  })

  it('HTTP errors and TronGrid error bodies become HistoryUnavailableError with the attempt', async () => {
    const limited = src({ body: { Error: 'request rate exceeded the allowed_rps(1), and the query server is suspended for 5 s' } })
    const e1 = await limited.source.listActivity(WALLET).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(HistoryUnavailableError)
    expect((e1 as HistoryUnavailableError).chain).toBe('tron:0x2b6653dc')
    expect((e1 as HistoryUnavailableError).attempts[0]).toMatch(/^trongrid: HTTP 200 request rate exceeded/)
    const down = src({ status: 503 })
    const e2 = await down.source.listActivity(WALLET).catch((e: unknown) => e)
    expect(e2).toBeInstanceOf(HistoryUnavailableError)
    expect((e2 as HistoryUnavailableError).attempts[0]).toMatch(/^trongrid: HTTP 503/)
    const bad = src({ status: 400, body: { success: false, error: 'A valid account address is required.', statusCode: 400 } })
    const e3 = await bad.source.listActivity('nope').catch((e: unknown) => e)
    expect((e3 as HistoryUnavailableError).message).toContain('A valid account address is required.')
  })

  it('sends TRON-PRO-API-KEY when given', async () => {
    const { source, calls } = src({}, { apiKey: 'k' })
    await source.listActivity(WALLET, { limit: 2 })
    for (const c of calls) expect(c.headers['TRON-PRO-API-KEY']).toBe('k')
  })

  it('explorer URLs, chain ids and default API roots per network', () => {
    expect(tronExplorerTxUrl('abc')).toBe('https://tronscan.org/#/transaction/abc')
    const nile = createTronHistory({ fetch: fake().fetch, network: 'nile' })
    expect(nile.chain).toBe('tron:0xcd8690dc')
    expect(nile.explorerTxUrl('abc')).toBe('https://nile.tronscan.org/#/transaction/abc')
    expect(createTronHistory({ fetch: fake().fetch, network: 'shasta' }).explorerTxUrl('abc')).toBe('https://shasta.tronscan.org/#/transaction/abc')
  })
})
