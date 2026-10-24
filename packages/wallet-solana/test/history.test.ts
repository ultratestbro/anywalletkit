import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import SplStakePoolProtocolSolana from '@anywalletkit/protocol-staking-spl-stake-pool-solana'
import {
  HistoryUnavailableError, createSolanaHistory, decodeHistoryCursor, encodeHistoryCursor, solanaExplorerTxUrl,
  TOKEN_PROGRAM, TOKEN_2022_PROGRAM, type HistoryFetch, type SignatureRow,
} from '../src/index.js'

const WALLET = '2tKRnQTAXmryVYxDNSajdZg1DfX2FbHKNboWr5EBiKhW'
const JITO_ATA = 'EvTykvN87o1arXqcf7wwU4Jzvo3pQrgaNfoxYfkw5gng'
const USDC_ATA = 'F2ZvdWL4c5eaGMzFv4FvtMG2KG41gMPMzkFfpJjiseuW'
const STAKE_POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'
const JITO_POOL = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb'
const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/history/${name}.json`, import.meta.url), 'utf8'))
const SIGS: Record<string, SignatureRow[]> = {
  [WALLET]: fx('signatures-wallet') as SignatureRow[],
  [JITO_ATA]: fx('signatures-jito-ata') as SignatureRow[],
  [USDC_ATA]: fx('signatures-usdc-ata') as SignatureRow[],
}
const TOKEN_ACCOUNTS = fx('token-accounts') as { token: Array<{ pubkey: string; mint: string }>; token2022: Array<{ pubkey: string; mint: string }> }
const TXS = new Map<string, unknown>()
for (const name of ['tx-jito-deposit', 'tx-native-receive', 'tx-native-send', 'tx-usdc-send', 'tx-swap-token2022']) {
  const tx = fx(name) as { transaction: { signatures: string[] } }
  TXS.set(tx.transaction.signatures[0]!, tx)
}
const JITO_SIG = (fx('tx-jito-deposit') as { transaction: { signatures: string[] } }).transaction.signatures[0]!

interface FakeOptions {
  /** Per-URL behaviour: return a status to fail the request for that host. */
  failUrl?: Record<string, number | 'network'>
}

function fakeRpc(opts: FakeOptions = {}) {
  const calls: Array<{ url: string; method: string; params: unknown[] }> = []
  let batches = 0
  const handle = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'getTokenAccountsByOwner': {
        const programId = (params[1] as { programId: string }).programId
        const list = programId === TOKEN_PROGRAM ? TOKEN_ACCOUNTS.token : programId === TOKEN_2022_PROGRAM ? TOKEN_ACCOUNTS.token2022 : []
        return { context: { slot: 1 }, value: list.map((a) => ({ pubkey: a.pubkey, account: { data: { parsed: { info: { mint: a.mint } } } } })) }
      }
      case 'getSignaturesForAddress': {
        const [address, o] = params as [string, { limit?: number; before?: string }]
        let rows = SIGS[address] ?? []
        if (o.before) {
          const i = rows.findIndex((r) => r.signature === o.before)
          rows = i >= 0 ? rows.slice(i + 1) : []
        }
        return rows.slice(0, o.limit ?? 1000)
      }
      case 'getTransaction':
        return TXS.get(params[0] as string) ?? null
      default:
        throw new Error(`unmocked ${method}`)
    }
  }
  const fetch: HistoryFetch = async (url, init) => {
    const fail = opts.failUrl?.[url]
    if (fail === 'network') throw new TypeError('fetch failed')
    if (typeof fail === 'number') return { ok: false, status: fail, json: async () => ({ error: 'down' }) }
    const body = JSON.parse(init?.body ?? '{}') as { id: unknown; method: string; params: unknown[] } | Array<{ id: unknown; method: string; params: unknown[] }>
    const run = (b: { id: unknown; method: string; params: unknown[] }) => {
      calls.push({ url, method: b.method, params: b.params })
      return { jsonrpc: '2.0', id: b.id, result: handle(b.method, b.params) }
    }
    if (Array.isArray(body)) {
      batches++
      return { ok: true, status: 200, json: async () => body.map(run) }
    }
    return { ok: true, status: 200, json: async () => run(body) }
  }
  return { fetch, calls, batches: () => batches }
}

const uniqueSignatures = new Set([...SIGS[WALLET]!, ...SIGS[JITO_ATA]!, ...SIGS[USDC_ATA]!].map((r) => r.signature))

describe('createSolanaHistory: pages', () => {
  it('merges the wallet and its token accounts newest-slot-first, without duplicates, and pages to the end with exact per-list cursors', async () => {
    const rpc = fakeRpc()
    const src = createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: rpc.fetch, rateLimit: 10_000 })
    expect(src.chain).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    let prevMinSlot = Number.POSITIVE_INFINITY
    do {
      const page = await src.listActivity(WALLET, { limit: 6, ...(cursor ? { cursor } : {}) })
      pages++
      expect(page.items.length).toBeGreaterThan(0)
      for (let i = 1; i < page.items.length; i++) expect(Number(page.items[i - 1]!.block)).toBeGreaterThanOrEqual(Number(page.items[i]!.block))
      for (const it of page.items) {
        expect(Number(it.block)).toBeLessThanOrEqual(prevMinSlot)
        seen.push(it.hash)
      }
      prevMinSlot = Math.min(...page.items.map((i) => Number(i.block)))
      cursor = page.cursor
    } while (cursor && pages < 20)
    expect(cursor).toBeUndefined()
    expect(new Set(seen).size, 'no signature twice across pages').toBe(seen.length)
    expect(new Set(seen)).toEqual(uniqueSignatures)
    // token accounts were listed once (two programs) and cached
    expect(rpc.calls.filter((c) => c.method === 'getTokenAccountsByOwner')).toHaveLength(2)
    expect(rpc.batches(), 'getTransaction went out in JSON-RPC batches').toBeGreaterThan(0)
  })

  it('a page lists every token account only up to maxTokenAccounts and the cursor freezes the list set', async () => {
    const rpc = fakeRpc()
    const src = createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: rpc.fetch, rateLimit: 10_000, maxTokenAccounts: 1 })
    expect(await src.tokenAccounts(WALLET)).toHaveLength(1)
    const page = await src.listActivity(WALLET, { limit: 3 })
    const lists = new Set(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress').map((c) => c.params[0]))
    expect(lists.size).toBe(2) // wallet + 1 token account
    const c = decodeHistoryCursor(page.cursor!)
    expect(Object.keys(c.l).sort()).toEqual([...lists].sort())
  })

  it('`since` cuts the page client-side and ends pagination once older rows appear', async () => {
    const rpc = fakeRpc()
    const src = createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: rpc.fetch, rateLimit: 10_000 })
    const page = await src.listActivity(WALLET, { limit: 50, since: 1791700000 })
    expect(page.items.length).toBe(2)
    expect(page.cursor).toBeUndefined()
  })

  it('a signature the node no longer has still yields a row (status from the signature list, no transfers)', async () => {
    const rpc = fakeRpc()
    const src = createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: rpc.fetch, rateLimit: 10_000 })
    const page = await src.listActivity(WALLET, { limit: 50 })
    const thin = page.items.find((i) => !TXS.has(i.hash))!
    expect(thin.transfers).toEqual([])
    expect(thin.status).toBe('confirmed')
    expect(thin.raw.tx).toBeNull()
  })
})

describe('createSolanaHistory: mapping', () => {
  const src = () => createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: fakeRpc().fetch, rateLimit: 10_000 })

  it('Jito DepositSol: SOL to the reserve + ATA rent out, JitoSOL minted in, stake-pool program as the call', async () => {
    const tx = (await src().getTransaction(JITO_SIG, WALLET))!
    expect(tx.hash).toBe(JITO_SIG)
    expect(tx.status).toBe('confirmed')
    expect(tx.from).toBe(WALLET)
    expect(tx.to).toBe(STAKE_POOL_PROGRAM)
    expect(tx.fee).toBe(20_000n)
    expect(tx.block).toBe(445_075_831n)
    expect(tx.time).toBe(1_788_787_427)
    expect(tx.nativeValue).toBe(0n)
    expect(tx.transfers).toEqual(expect.arrayContaining([
      { token: null, from: WALLET, to: JITO_ATA, amount: 1_855_569n },
      { token: null, from: WALLET, to: 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL', amount: 50_000_000n },
      { token: JITOSOL, from: JITOSOL, to: WALLET, amount: 38_460_176n, standard: 'spl', decimals: 9 },
    ]))
    expect(tx.transfers).toHaveLength(3)
    expect(tx.call?.to).toBe(STAKE_POOL_PROGRAM)
    expect(tx.call?.programs?.slice(0, 4)).toEqual(['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', STAKE_POOL_PROGRAM])
    expect(tx.call?.programs).toContain(TOKEN_PROGRAM) // inner instructions appended
    expect(tx.call?.data).toBe('EuDr9rYPe6C13GwvXkhAywV')
  })

  it('plain SOL receive and send: counterparty, nativeValue and fee', async () => {
    const s = src()
    const recv = (await s.getTransaction('GP216fwCQuQLAcTdgZwGQEZ1usE21pw6KLdwTGFUKYntHqfCnCBciyMTUSwULxwZrzjUF6W82n3vhrXDxdBhpB2', WALLET))!
    expect(recv.call).toBeUndefined()
    expect(recv.from).toBe('HnUi3nXdfMnuttWNgcUnXYodaWqYjXxdWKHtZBKFUZA3')
    expect(recv.to).toBe(WALLET)
    expect(recv.nativeValue).toBe(4_988_640n)
    expect(recv.transfers).toEqual([{ token: null, from: 'HnUi3nXdfMnuttWNgcUnXYodaWqYjXxdWKHtZBKFUZA3', to: WALLET, amount: 4_988_640n }])
    expect(recv.fee).toBe(11_360n)
    const send = (await s.getTransaction('461jk5vmt2hjpLpCpym2xmxTkum7tsLzzwArAshvncqnPGMaXydn5c5rR7FxkbDx68KfY7Vtz5Ez8kd5KEQmQqUr', WALLET))!
    expect(send.from).toBe(WALLET)
    expect(send.to).toBe('HnUi3nXdfMnuttWNgcUnXYodaWqYjXxdWKHtZBKFUZA3')
    expect(send.nativeValue).toBe(5_000_000n)
    expect(send.fee).toBe(5_000n)
  })

  it('USDC send: the SPL leg between owners, ATA rent as a SOL leg, no call, `to` = the token recipient', async () => {
    const tx = (await src().getTransaction(SIGS[USDC_ATA]![0]!.signature, WALLET))!
    expect(tx.call).toBeUndefined()
    expect(tx.transfers).toEqual(expect.arrayContaining([
      { token: USDC, from: WALLET, to: 'DH6ADEhR9pLuNKiFa4vH7EYEoH1v2aLCejT9XoKvFaqK', amount: 10_022_994n, standard: 'spl', decimals: 6 },
      { token: null, from: WALLET, to: 'D5smm48CuJEFGTGBnYXoQrTsrvHkWwzcxkjJWH1QfZMk', amount: 1_488_440n },
    ]))
    expect(tx.to).toBe('DH6ADEhR9pLuNKiFa4vH7EYEoH1v2aLCejT9XoKvFaqK')
    expect(tx.nativeValue).toBe(1_488_440n)
  })

  it('aggregator swap: Token-2022 out, USDC in, many intermediate legs paired greedily, router program as the call', async () => {
    const tx = (await src().getTransaction(SIGS[USDC_ATA]![1]!.signature, WALLET))!
    const own = tx.transfers.filter((t) => t.from === WALLET || t.to === WALLET)
    expect(own).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', from: WALLET, amount: 10_022_444n, standard: 'token2022', decimals: 6 }),
      expect.objectContaining({ token: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', from: WALLET, amount: 25_118n, standard: 'token2022' }),
      expect.objectContaining({ token: USDC, to: WALLET, amount: 10_022_994n, standard: 'spl' }),
    ]))
    // the wallet paid only the fee in SOL: no native leg of its own
    expect(own.some((t) => t.token === null)).toBe(false)
    expect(tx.call?.to).toBe('3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br')
    expect(tx.call?.programs?.[0]).toBe('ComputeBudget111111111111111111111111111111')
    expect(tx.fee).toBe(45_964n)
    // the wallet's USDC leg is paired with the pool that actually paid it, not with a mint placeholder
    expect(own.find((t) => t.token === USDC)!.from).toBe('8ekCy2jHHUbW2yeNGFWYJT9Hm9FW7SvZcZK66dSZCDiF')
  })

  it('unknown signature → undefined', async () => {
    expect(await src().getTransaction('1'.repeat(88), WALLET)).toBeUndefined()
  })
})

describe('createSolanaHistory: cursor, failover, explorer', () => {
  it('cursor round-trips and rejects garbage', () => {
    const c = encodeHistoryCursor({ v: 1, l: { [WALLET]: 'sig', [JITO_ATA]: null, [USDC_ATA]: '' } })
    expect(/^[A-Za-z0-9+/=]+$/.test(c)).toBe(true)
    expect(decodeHistoryCursor(c)).toEqual({ v: 1, l: { [WALLET]: 'sig', [JITO_ATA]: null, [USDC_ATA]: '' } })
    expect(() => decodeHistoryCursor('not-a-cursor')).toThrow(/malformed history cursor/)
    expect(() => decodeHistoryCursor(encodeHistoryCursor({ v: 2 } as never))).toThrow(/malformed history cursor/)
  })

  it('fails over to the next RPC on 5xx / network errors and names every attempt when all fail', async () => {
    const rpc = fakeRpc({ failUrl: { 'https://a.example': 503, 'https://b.example': 'network' } })
    const ok = createSolanaHistory({ rpcUrls: ['https://a.example', 'https://b.example', 'https://c.example'], fetch: rpc.fetch, rateLimit: 10_000 })
    const page = await ok.listActivity(WALLET, { limit: 3 })
    expect(page.items.length).toBe(3)
    expect(rpc.calls.every((c) => c.url === 'https://c.example')).toBe(true)

    const bad = createSolanaHistory({ rpcUrls: ['https://a.example', 'https://b.example'], fetch: rpc.fetch, rateLimit: 10_000 })
    const err = await bad.listActivity(WALLET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HistoryUnavailableError)
    const e = err as HistoryUnavailableError
    expect(e.chain).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
    expect(e.attempts).toEqual([expect.stringMatching(/^https:\/\/a\.example: HTTP 503/), expect.stringMatching(/^https:\/\/b\.example: fetch failed/)])
  })

  it('needs an endpoint', () => {
    expect(() => createSolanaHistory({ fetch: fakeRpc().fetch })).toThrow(/rpcUrl/)
  })

  it('explorer URLs', () => {
    expect(solanaExplorerTxUrl('abc')).toBe('https://solscan.io/tx/abc')
    expect(createSolanaHistory({ rpcUrl: 'x', fetch: fakeRpc().fetch, network: 'devnet' }).explorerTxUrl('abc')).toBe('https://solscan.io/tx/abc?cluster=devnet')
    expect(createSolanaHistory({ rpcUrl: 'x', fetch: fakeRpc().fetch, network: 'devnet' }).chain).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')
  })
})

describe('recognizer cross-check: @anywalletkit/protocol-staking-spl-stake-pool-solana', () => {
  it('the row this source builds for the real Jito deposit is described as a stake', async () => {
    const src = createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: fakeRpc().fetch, rateLimit: 10_000 })
    const tx = (await src.getTransaction(JITO_SIG, WALLET))!
    const protocol = new SplStakePoolProtocolSolana(createMockAccount()) as unknown as { describeActivity(tx: unknown, ctx: { own: Set<string> }): { kind: string; title: string; counterparty?: string; protocol?: string; assetsIn: Array<{ token: string | null; amount: bigint }>; assetsOut: Array<{ token: string | null; amount: bigint }> } | null }
    const item = protocol.describeActivity(tx, { own: new Set([WALLET, JITO_ATA]) })
    expect(item).not.toBeNull()
    expect(item!.kind).toBe('stake')
    expect(item!.title).toBe('Staked SOL')
    expect(item!.protocol).toBe('@anywalletkit/protocol-staking-spl-stake-pool-solana')
    expect(item!.counterparty).toBe(JITO_POOL)
    expect(item!.assetsIn).toEqual([expect.objectContaining({ token: JITOSOL, amount: 38_460_176n })])
    expect(item!.assetsOut).toEqual([expect.objectContaining({ token: null, amount: 50_000_000n })])
  })

  it('a plain SOL transfer from the same source is not claimed by the stake-pool module', async () => {
    const src = createSolanaHistory({ rpcUrl: 'https://rpc.example', fetch: fakeRpc().fetch, rateLimit: 10_000 })
    const tx = (await src.getTransaction('461jk5vmt2hjpLpCpym2xmxTkum7tsLzzwArAshvncqnPGMaXydn5c5rR7FxkbDx68KfY7Vtz5Ez8kd5KEQmQqUr', WALLET))!
    const protocol = new SplStakePoolProtocolSolana(createMockAccount()) as unknown as { describeActivity(tx: unknown, ctx: { own: Set<string> }): unknown }
    expect(protocol.describeActivity(tx, { own: new Set([WALLET]) })).toBeNull()
  })
})
