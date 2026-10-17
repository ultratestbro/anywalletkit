import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeNearIntentsActivity } from '@forgewallet/protocol-swap2-near-intents'
import {
  HistoryUnavailableError, createNearHistory, decodeHistoryCursor, encodeHistoryCursor, nearExplorerTxUrl, parseJsonPreservingBigInts,
  type HistoryFetch, type NearblocksFtRow, type NearblocksReceiptRow, type NearblocksTxn, type RpcTxStatus,
} from '../src/index.js'

const WALLET = 'fc647e203e0e099212485017b78a0e77dc330019d4b532a4d44408adc0bfd9a1'
const INTENTS_USER = 'b1633df641230892b93f42d79072025d15163cb325134220321107afc1e7c932'
const DEPOSIT_HASH = 'Fdk3i7f91T7BpnNbDSZyNDzZ84WV4VwAGdFKuqHrvXNW'
const RPC = 'https://archival-rpc.example'

const raw = (name: string): string => readFileSync(new URL(`./fixtures/history/${name}.json`, import.meta.url), 'utf8')
/** Fixtures are loaded the way the source parses nearblocks bodies, so big integers survive re-serialization in the fake. */
const fx = <T>(name: string): T => parseJsonPreservingBigInts(raw(name)) as T
const TXNS: Record<string, NearblocksReceiptRow[]> = {
  [WALLET]: fx<{ txns: NearblocksReceiptRow[] }>('nearblocks-wallet-txns').txns,
  [INTENTS_USER]: fx<{ txns: NearblocksReceiptRow[] }>('nearblocks-intents-txns').txns,
}
const FT: Record<string, NearblocksFtRow[]> = {
  [WALLET]: fx<{ txns: NearblocksFtRow[] }>('nearblocks-wallet-ft-txns').txns,
  [INTENTS_USER]: fx<{ txns: NearblocksFtRow[] }>('nearblocks-intents-ft-txns').txns,
}
const TXN = fx<{ txns: NearblocksTxn[] }>('nearblocks-txn-intents-deposit')
const RPC_RESULT = fx<{ result: RpcTxStatus }>('rpc-tx-status-intents-deposit').result

interface FakeOptions {
  status?: number
  body?: unknown
  rpc?: 'unknown' | 'down'
}

function fake(opts: FakeOptions = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = []
  const text = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })
  const fetch: HistoryFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, ...(init?.body !== undefined ? { body: init.body } : {}) })
    if (url === RPC) {
      if (opts.rpc === 'down') return text(503, { error: 'down' })
      const req = JSON.parse(init?.body ?? '{}') as { params: { tx_hash: string; sender_account_id: string } }
      if (opts.rpc === 'unknown' || req.params.tx_hash !== DEPOSIT_HASH) return text(200, { jsonrpc: '2.0', id: '1', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' }, code: -32000, message: 'Server error' } })
      return text(200, { jsonrpc: '2.0', id: '1', result: RPC_RESULT })
    }
    if (opts.status !== undefined) return text(opts.status, opts.body ?? { message: 'Too Many Requests' })
    const u = new URL(url)
    let m = /^\/v1\/account\/([^/]+)\/(txns|ft-txns)$/.exec(u.pathname)
    if (m) {
      const perPage = Number(u.searchParams.get('per_page') ?? 25)
      const cursor = u.searchParams.get('cursor')
      if (m[2] === 'txns') {
        let rows = TXNS[m[1]!] ?? []
        if (cursor) rows = rows.filter((r) => BigInt(r.id) < BigInt(cursor))
        return text(200, { txns: rows.slice(0, perPage) })
      }
      let rows = FT[m[1]!] ?? []
      if (cursor) rows = rows.filter((r) => BigInt(r.event_index) < BigInt(cursor))
      return text(200, { txns: rows.slice(0, perPage) })
    }
    m = /^\/v1\/txns\/([^/]+)$/.exec(u.pathname)
    if (m) return text(200, m[1] === DEPOSIT_HASH ? TXN : { txns: [] })
    return text(404, { message: `unmocked ${u.pathname}` })
  }
  return { fetch, calls }
}

const src = (opts: FakeOptions = {}, extra: Record<string, unknown> = {}) => {
  const f = fake(opts)
  return { ...f, source: createNearHistory({ fetch: f.fetch, rateLimit: 10_000, ...extra }) }
}

describe('parseJsonPreservingBigInts', () => {
  it('keeps 16+ digit integers exact as strings, leaves small numbers, floats and string contents alone', () => {
    const v = parseJsonPreservingBigInts('{"a":492452918750000000000,"b":7e+23,"c":1,"d":-12345678901234567890,"s":"x: 123456789012345678, \\"q\\" }","n":null,"arr":[9007199254740993]}') as Record<string, unknown>
    expect(v.a).toBe('492452918750000000000')
    expect(v.b).toBe(7e23)
    expect(v.c).toBe(1)
    expect(v.d).toBe('-12345678901234567890')
    expect(v.s).toBe('x: 123456789012345678, "q" }')
    expect(v.n).toBeNull()
    expect(v.arr).toEqual(['9007199254740993'])
  })

  it('the recorded nearblocks page keeps the exact 21-digit deposit and the fee nearblocks already rounded', () => {
    const page = parseJsonPreservingBigInts(raw('nearblocks-wallet-txns')) as { txns: Array<{ actions: Array<{ deposit: unknown }>; outcomes_agg: { transaction_fee: unknown } }> }
    expect(page.txns[0]!.actions[0]!.deposit).toBe('492452918750000000000')
    expect(page.txns[1]!.actions[0]!.deposit).toBe(7e23)
    expect(page.txns[2]!.outcomes_agg.transaction_fee).toBe('411205370793300000000')
  })
})

describe('createNearHistory: pages', () => {
  it('groups receipt rows by transaction: NEAR transfers, function calls as `call`, fee, status, approximate flag', async () => {
    const { source, calls } = src()
    expect(source.chain).toBe('near:mainnet')
    const page = await source.listActivity(WALLET, { limit: 10 })
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([`/v1/account/${WALLET}/txns`, `/v1/account/${WALLET}/ft-txns`])
    expect(page.items.map((i) => i.hash.slice(0, 10))).toEqual(['3W8EDnjCsP', 'FoAiAg2kxy', 'AQAkvxyT2N'])
    expect(page.cursor).toBeUndefined()
    const send = page.items[0]!
    expect(send.from).toBe(WALLET)
    expect(send.to).toBe('f332f25118027ba4d74312f85dda99a9a04094393511c905bfa03d487fdf3cd7')
    expect(send.call).toBeUndefined()
    expect(send.transfers).toHaveLength(1)
    expect(send.transfers[0]).toMatchObject({ token: null, from: WALLET, to: 'f332f25118027ba4d74312f85dda99a9a04094393511c905bfa03d487fdf3cd7' })
    // nearblocks serialized the 0.7 NEAR deposit as 7e+23: within double precision of 7×10^23 and flagged
    const amount = send.transfers[0]!.amount
    expect(amount > 699_999_999_999_999_000_000_000n && amount <= 700_000_000_000_000_100_000_000n).toBe(true)
    expect(send.nativeValue).toBe(amount)
    expect(send.raw.approximate).toBe(true)
    expect(send.raw.receipts).toHaveLength(2)
    expect(send.status).toBe('confirmed')
    expect(send.block).toBe(219_358_965n)
    expect(send.time).toBe(1_791_624_538)
    expect(send.fee).toBeDefined()

    const call = page.items[1]!
    expect(call.call).toEqual({ to: 'usdt.tether-token.near', method: 'storage_deposit', programs: ['storage_deposit', 'ft_transfer'] })
    expect(call.to).toBe('usdt.tether-token.near')
    // storage_deposit moved 0.00125 NEAR; the 1 yoctoNEAR on ft_transfer is a NEP-141 formality, not a transfer
    expect(call.transfers).toEqual([{ token: null, from: WALLET, to: 'usdt.tether-token.near', amount: 1_250_000_000_000_000_000_000n }])
    expect(call.fee).toBe(411_205_370_793_300_000_000n)
    expect(call.raw.approximate).toBe(true)

    const recv = page.items[2]!
    expect(recv.from).toBe('intents.near')
    expect(recv.to).toBe(WALLET)
    expect(recv.transfers[0]).toMatchObject({ token: null, from: 'intents.near', to: WALLET })
  })

  it('merges NEP-141 rows (exact string deltas, symbol, decimals) into the transaction they belong to; ft-only rows still form a row', async () => {
    const { source } = src()
    const page = await source.listActivity(INTENTS_USER, { limit: 10 })
    expect(page.items.map((i) => i.hash)).toEqual([DEPOSIT_HASH, 'FgP8cJM1nT' + page.items[1]!.hash.slice(10), 'Htgn5N2TuuQieaUi8qDEArQyYtYvdy8z8mEbpMf3tXea'])
    const dep = page.items[0]!
    expect(dep.from).toBe(INTENTS_USER)
    expect(dep.call).toEqual({ to: 'wrap.near', method: 'ft_transfer_call', programs: ['ft_transfer_call', 'ft_transfer_call'] })
    expect(dep.transfers).toEqual([{ token: 'wrap.near', from: INTENTS_USER, to: 'intents.near', amount: 20_500_000_000_000_000_000_000_000n, standard: 'nep141', symbol: 'wNEAR', decimals: 24 }])
    expect(dep.nativeValue).toBe(0n)
    expect(dep.fee).toBe(888_747_685_474_100_000_000n)
    expect(dep.raw.approximate).toBeUndefined()
    expect(dep.raw.ft).toHaveLength(1)
    expect(dep.raw.receipts).toHaveLength(2)
    const ftOnly = page.items[2]!
    expect(ftOnly.raw.receipts).toEqual([])
    expect(ftOnly.from).toBe('hideon.near')
    expect(ftOnly.to).toBe(INTENTS_USER)
    expect(ftOnly.transfers[0]).toMatchObject({ token: 'wrap.near', from: 'hideon.near', to: INTENTS_USER, amount: 20_500_000_000_000_000_000_000_000n })
    expect(ftOnly.time).toBe(1_790_728_351)
  })

  it('keyset cursors: the consumed prefix of each list is remembered, pages do not overlap, lists end independently', async () => {
    const { source, calls } = src()
    const p1 = await source.listActivity(WALLET, { limit: 2 })
    expect(p1.items.map((i) => i.hash.slice(0, 10))).toEqual(['3W8EDnjCsP', 'FoAiAg2kxy'])
    const c1 = decodeHistoryCursor(p1.cursor!)
    expect(c1).toEqual({ v: 1, tx: '24759220698', ft: null })
    const p2 = await source.listActivity(WALLET, { limit: 2, cursor: p1.cursor! })
    const last = new URL(calls[calls.length - 1]!.url)
    expect(last.pathname.endsWith('/txns')).toBe(true)
    expect(last.searchParams.get('cursor')).toBe('24759220698')
    expect(calls.filter((c) => c.url.includes('ft-txns'))).toHaveLength(1) // exhausted lists are not asked again
    expect(p2.items.map((i) => i.hash.slice(0, 10))).toEqual(['AQAkvxyT2N'])
    expect(p2.cursor).toBeUndefined()
  })

  it('`since` trims and ends pagination', async () => {
    const { source } = src()
    const page = await source.listActivity(WALLET, { limit: 10, since: 1_791_624_500 })
    expect(page.items).toHaveLength(1)
    expect(page.cursor).toBeUndefined()
  })
})

describe('createNearHistory: getTransaction', () => {
  it('nearblocks only: signer, actions and approximate NEP-141 deltas, flagged', async () => {
    const { source } = src()
    const tx = (await source.getTransaction(DEPOSIT_HASH, INTENTS_USER))!
    expect(tx.from).toBe('bridge-mng.near')
    expect(tx.call?.method).toBe('ft_transfer_call')
    expect(tx.transfers).toHaveLength(1)
    expect(tx.transfers[0]).toMatchObject({ token: 'wrap.near', from: INTENTS_USER, to: 'intents.near', standard: 'nep141', symbol: 'wNEAR', decimals: 24 })
    expect(tx.raw.approximate, 'receipts[].fts.delta_amount is a double in /v1/txns').toBe(true)
    expect(tx.fee).toBe(888_747_685_474_100_000_000n)
    expect(tx.block).toBe(217_848_735n)
    expect(await source.getTransaction('nope', INTENTS_USER)).toBeUndefined()
  })

  it('with rpcUrl: exact amounts from the transfer log, fee = Σ tokens_burnt, call from the delegated action', async () => {
    const { source, calls } = src({}, { rpcUrl: RPC })
    const tx = (await source.getTransaction(DEPOSIT_HASH, INTENTS_USER))!
    const rpcCall = calls.find((c) => c.url === RPC)!
    expect(JSON.parse(rpcCall.body!)).toMatchObject({ method: 'EXPERIMENTAL_tx_status', params: { tx_hash: DEPOSIT_HASH, sender_account_id: 'bridge-mng.near' } })
    expect(tx.raw.rpc).toBeDefined()
    expect(tx.raw.approximate).toBeUndefined()
    expect(tx.from).toBe('bridge-mng.near')
    expect(tx.call).toEqual({ to: 'wrap.near', method: 'ft_transfer_call', programs: ['ft_transfer_call'] })
    expect(tx.transfers).toEqual([{ token: 'wrap.near', from: INTENTS_USER, to: 'intents.near', amount: 20_500_000_000_000_000_000_000_000n, standard: 'nep141', symbol: 'wNEAR', decimals: 24 }])
    expect(tx.fee).toBe(51_659_488_498_500_000_000n + 51_659_488_498_500_000_000n + 263_570_153_026_300_000_000n + 385_367_307_599_600_000_000n + 136_491_247_851_200_000_000n)
    expect(tx.status).toBe('confirmed')
    expect(tx.nativeValue).toBe(0n)
  })

  it('an RPC that does not know the transaction (non-archival) or is down leaves the nearblocks row in place', async () => {
    for (const rpc of ['unknown', 'down'] as const) {
      const { source } = src({ rpc }, { rpcUrl: RPC })
      const tx = (await source.getTransaction(DEPOSIT_HASH, INTENTS_USER))!
      expect(tx.raw.rpc).toBeUndefined()
      expect(tx.raw.approximate).toBe(true)
    }
  })
})

describe('createNearHistory: cursor, errors, keys, explorer', () => {
  it('cursor round-trips and rejects garbage', () => {
    expect(decodeHistoryCursor(encodeHistoryCursor({ v: 1, tx: '1', ft: null }))).toEqual({ v: 1, tx: '1', ft: null })
    expect(decodeHistoryCursor(encodeHistoryCursor({ v: 1, tx: '', ft: '2' }))).toEqual({ v: 1, tx: '', ft: '2' })
    expect(() => decodeHistoryCursor('nope')).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 1, tx: 5 } as never))).toThrow(/malformed history cursor/)
  })

  it('HTTP 429 / 5xx become HistoryUnavailableError naming nearblocks', async () => {
    const { source } = src({ status: 429 })
    const err = await source.listActivity(WALLET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HistoryUnavailableError)
    expect((err as HistoryUnavailableError).chain).toBe('near:mainnet')
    expect((err as HistoryUnavailableError).attempts).toEqual([expect.stringMatching(/^nearblocks: HTTP 429 Too Many Requests/)])
  })

  it('sends the Bearer key', async () => {
    const { source, calls } = src({}, { apiKey: 'k' })
    await source.listActivity(WALLET, { limit: 1 })
    for (const c of calls) expect(c.headers.authorization).toBe('Bearer k')
  })

  it('explorer URLs and testnet', () => {
    expect(nearExplorerTxUrl('abc')).toBe('https://nearblocks.io/txns/abc')
    const t = createNearHistory({ fetch: fake().fetch, network: 'testnet' })
    expect(t.chain).toBe('near:testnet')
    expect(t.explorerTxUrl('abc')).toBe('https://testnet.nearblocks.io/txns/abc')
  })
})

describe('recognizer cross-check: @forgewallet/protocol-swap2-near-intents', () => {
  const own = new Set([INTENTS_USER])

  it('the list row for the real ft_transfer_call into intents.near is "Bridged wNEAR"', async () => {
    const { source } = src()
    const page = await source.listActivity(INTENTS_USER, { limit: 10 })
    const item = describeNearIntentsActivity(page.items[0]!, { own })!
    expect(item).not.toBeNull()
    expect(item.kind).toBe('bridge')
    expect(item.title).toBe('Bridged wNEAR')
    expect(item.counterparty).toBe('intents.near')
    expect(item.assetsOut).toEqual([expect.objectContaining({ token: 'wrap.near', amount: 20_500_000_000_000_000_000_000_000n })])
    // the wNEAR that arrived from hideon.near in another tx is not NEAR Intents' business
    expect(describeNearIntentsActivity(page.items[2]!, { own })).toBeNull()
  })

  it('the RPC-refined single read agrees with the module\'s own fixture (same token, counterparty and exact amount)', async () => {
    const { source } = src({}, { rpcUrl: RPC })
    const tx = (await source.getTransaction(DEPOSIT_HASH, INTENTS_USER))!
    const item = describeNearIntentsActivity(tx, { own })!
    expect(item.kind).toBe('bridge')
    expect(item.title).toBe('Bridged wNEAR')
    expect(item.counterparty).toBe('intents.near')
    expect(item.assetsOut).toEqual([expect.objectContaining({ token: 'wrap.near', amount: 20_500_000_000_000_000_000_000_000n })])
  })
})
