import { describe, expect, it } from 'vitest'
import { NotImplementedError, ReadOnlyAccountError } from '@forgewallet/core'
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM, FARMS_PROGRAM, KLEND_PROGRAM, KVAULT_PROGRAM, KaminoApi, KaminoError, KaminoMarketProtocolSolana, KaminoVaultProtocolSolana,
  WITHDRAW_ALL, DEFAULT_FIRST_DEPOSIT_ALLOWANCE, DEFAULT_RENT_ALLOWANCE, fromDecimalString, instructionName, lessBps, toDecimalString, toWad,
} from '../src/index.js'
import { MARKET, PYUSD, SHARES, SOL, SOL_RESERVE, TX, USDC, USDC_RESERVE, USER, VAULT, account, api, obligation } from './fixture.js'

const vault = (acc = account(), extra: Record<string, unknown> = {}) => {
  const f = api()
  return { f, acc, p: new KaminoVaultProtocolSolana(acc, { vault: VAULT, fetch: f.fetch, ...extra }) }
}
const market = (acc = account(), extra: Record<string, unknown> = {}) => {
  const f = api()
  return { f, acc, p: new KaminoMarketProtocolSolana(acc, { fetch: f.fetch, ...extra }) }
}
const lastPost = (f: ReturnType<typeof api>) => f.requests.filter((r) => r.method === 'POST').at(-1)! as { url: string; method: string; body: Record<string, unknown> }

describe('amounts', () => {
  it('base units ↔ the decimal strings the API speaks', () => {
    expect(toDecimalString(1_500_000n, 6)).toBe('1.5')
    expect(toDecimalString(5n, 6)).toBe('0.000005')
    expect(toDecimalString(1_000_000n, 6)).toBe('1')
    expect(fromDecimalString('1.0627800342202071868', 6)).toBe(1_062_780n)
    expect(fromDecimalString('4.66025618528313756439e-16', 9)).toBe(0n)
    expect(fromDecimalString('2292847.2166629909741', 9)).toBe(2_292_847_216_662_990n)
    expect(toWad('1.5')).toBe(15n * 10n ** 17n)
    expect(lessBps(1_000_000n, 50)).toBe(995_000n)
  })
  it('names the Kamino instructions the API transactions carry', () => {
    const d = (hex: string) => Uint8Array.from(Buffer.from(hex + '00', 'hex'))
    expect(instructionName(KLEND_PROGRAM, d('d8e0bf1bcc9766af'))).toBe('depositReserveLiquidityAndObligationCollateralV2')
    expect(instructionName(KVAULT_PROGRAM, d('f223c68952e1f2b6'))).toBe('deposit')
    expect(instructionName(FARMS_PROGRAM, d('ceb0ca12c8d1b36c'))).toBe('stake')
    expect(instructionName(KLEND_PROGRAM, d('0000000000000000'))).toBeUndefined()
  })
})

describe('KaminoVaultProtocolSolana', () => {
  it('describes the vault from the API: asset, shares, rate, fees, TVL', async () => {
    const { p } = vault()
    const v = await p.getVault()
    expect(v.asset).toEqual({ mint: USDC, decimals: 6, symbol: 'USDC' })
    expect(v.shares.mint).toBe(SHARES)
    expect(v.apy).toBeCloseTo(4.5155, 3)
    expect(v.fees).toEqual({ performanceBps: 500, managementBps: 0 })
    expect(v.totalAssets).toBe(80_843_116_919n + 19_873_153_911_276n)
    expect(v.allocations.map((a) => a.reserve)).toEqual([USDC_RESERVE])
    expect(v.farm).toBe('7D8C5pDFxug58L9zkwK7bCiDg4kD4AygzbcZUmf5usHS')
    expect(await p.getApy()).toBeCloseTo(4.5155, 3)
  })

  it('quoteSupply builds the deposit through the API in token units and proves it through the guard without sending', async () => {
    const { p, f, acc } = vault()
    const q = await p.quoteSupply({ amount: 1_500_000n })
    expect(q.fee).toBe(7_500n)
    expect(q.expectedShares).toBe(fromDecimalString('1.5', 6) * 10n ** 18n / toWad('1.0627800342202071868') + 1n)
    expect(lastPost(f)).toMatchObject({ url: '/ktx/kvault/deposit', body: { wallet: USER, kvault: VAULT, amount: '1.5' } })
    expect(lastPost(f).body).not.toHaveProperty('skipFarm')
    expect(acc.sent).toHaveLength(0)
    const g = acc.guards[0]!
    expect(g.method).toBe('check')
    expect(g.base64).toBe(TX)
    expect(g.guard.programAllowlist).toEqual(expect.arrayContaining([KLEND_PROGRAM, KVAULT_PROGRAM, FARMS_PROGRAM, ADDRESS_LOOKUP_TABLE_PROGRAM]))
    expect(g.guard.expect).toEqual({ maxLamportsOut: DEFAULT_RENT_ALLOWANCE, maxTokenOut: { mint: USDC, amount: 1_500_000n } })
  })

  it('supply signs through sendSerialized with the same guard; skipFarm proves the shares arrive', async () => {
    const { p, f, acc } = vault(account(), { skipFarm: true, memo: 'awk' })
    const r = await p.supply({ amount: 2_000_000n })
    expect(r).toEqual({ hash: 'sig1', fee: 7_500n })
    expect(lastPost(f).body).toMatchObject({ skipFarm: true, memo: 'awk' })
    const g = acc.guards.at(-1)!
    expect(g.method).toBe('send')
    expect(g.guard.expect.maxTokenOut).toEqual({ mint: USDC, amount: 2_000_000n })
    expect(g.guard.expect.tokenIn?.mint).toBe(SHARES)
    expect(g.guard.expect.tokenIn!.minAmount).toBeLessThan(2_000_000n)
    expect(g.guard.expect.tokenIn!.minAmount).toBeGreaterThan(1_800_000n)
  })

  it('refuses the wrong token, dust below the vault minimum, and a read-only account', async () => {
    const { p } = vault()
    await expect(p.quoteSupply({ token: SOL, amount: 1_000_000n })).rejects.toThrow(/takes USDC/)
    await expect(p.quoteSupply({ amount: 10n })).rejects.toThrow(/below the vault minimum/)
    await expect(p.quoteSupply({ amount: 0n })).rejects.toThrow(KaminoError)
    const ro = new KaminoVaultProtocolSolana(account().toReadOnlyAccount(), { vault: VAULT, fetch: api().fetch })
    await expect(ro.supply({ amount: 1_000_000n })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    await expect(ro.withdraw({ amount: 'max' })).rejects.toBeInstanceOf(ReadOnlyAccountError)
  })

  it('reads the position as shares × tokensPerShare and withdraws by shares, max = every share', async () => {
    const { p, f, acc } = vault()
    f.position = { stakedShares: '10', unstakedShares: '0.5', totalShares: '10.5' }
    const pos = await p.getPosition()
    expect(pos.shares).toBe(10_500_000n)
    expect(pos.stakedShares).toBe(10_000_000n)
    expect(pos.assets).toBe(10_500_000n * toWad('1.0627800342202071868') / 10n ** 18n)

    const q = await p.quoteWithdraw({ amount: 'max' })
    expect(q.shares).toBe(10_500_000n)
    expect(q.expectedAssets).toBe(pos.assets)
    expect(q.minAssets).toBe(lessBps(pos.assets, 50))
    expect(lastPost(f)).toMatchObject({ url: '/ktx/kvault/withdraw', body: { wallet: USER, kvault: VAULT, amount: WITHDRAW_ALL } })
    expect(acc.guards.at(-1)!.guard.expect).toEqual({ maxLamportsOut: DEFAULT_RENT_ALLOWANCE, tokenIn: { mint: USDC, minAmount: lessBps(pos.assets, 50) } })

    await p.withdraw({ amount: 1_062_780n })  // ≈ 1 share's worth
    expect(lastPost(f).body.amount).toBe('1')
    expect(acc.sent).toHaveLength(1)
    await expect(p.quoteWithdraw({ amount: 100_000_000n })).rejects.toThrow(/exceeds the position/)
  })

  it('has no position → withdraw refuses; borrow / repay are not what a vault does', async () => {
    const { p } = vault()
    await expect(p.quoteWithdraw({ amount: 'max' })).rejects.toThrow(/No position/)
    await expect(p.borrow()).rejects.toBeInstanceOf(NotImplementedError)
    await expect(p.quoteRepay()).rejects.toBeInstanceOf(NotImplementedError)
  })

  it('refuses a non-mainnet Solana account up front and any other chain at the first call', async () => {
    expect(() => new KaminoVaultProtocolSolana(account({ chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }), { vault: VAULT })).toThrow(/mainnet/)
    const p = new KaminoVaultProtocolSolana(account({ chain: 'eip155:1' }), { vault: VAULT, fetch: api().fetch })
    await expect(p.getPosition()).rejects.toThrow(/Solana mainnet account/)
    expect(() => new KaminoVaultProtocolSolana(account(), { vault: 'nope' })).toThrow(/vault/)
    expect(() => new KaminoVaultProtocolSolana(account(), { vault: VAULT, slippageBps: 9_999 })).toThrow(/slippageBps/)
  })

  it('surfaces the API error code', async () => {
    const { p, f } = vault()
    f.routes.set('/ktx/kvault/deposit', { status: 400, body: { statusCode: 400, message: 'Amount overflow', error: 'Bad Request', code: 'DECIMAL_TO_LAMPORTS_OVERFLOW' } })
    await expect(p.quoteSupply({ amount: 1_000_000n })).rejects.toMatchObject({ code: 'DECIMAL_TO_LAMPORTS_OVERFLOW', message: expect.stringMatching(/Amount overflow/) })
  })
})

describe('KaminoMarketProtocolSolana', () => {
  it('lists reserves with utilization and resolves a mint to its deepest reserve unless pinned', async () => {
    const { p } = market()
    const rs = await p.getReserves()
    expect(rs.find((r) => r.reserve === USDC_RESERVE)!.utilization).toBeCloseTo(0.768, 2)
    expect((await p.resolveReserve(USDC)).reserve).toBe(USDC_RESERVE)
    expect((await p.resolveReserve(SOL)).reserve).toBe(SOL_RESERVE)
    await expect(p.resolveReserve(PYUSD)).rejects.toThrow(/no reserve/)
    const pinned = market(account(), { reserves: { [USDC]: 'AWnKJ9dsiHcoDCThxE5E93ikDTAXkApoNwrKM2tp9KFJ' } }).p
    expect((await pinned.resolveReserve(USDC)).reserve).toBe('AWnKJ9dsiHcoDCThxE5E93ikDTAXkApoNwrKM2tp9KFJ')
    const wrong = market(account(), { reserves: { [USDC]: SOL_RESERVE } }).p
    await expect(wrong.resolveReserve(USDC)).rejects.toThrow(/holds SOL/)
    const m = await p.getMarket()
    expect(m.isPrimary).toBe(true)
    expect(m.reserves).toHaveLength(3)
  })

  it('first deposit: obligation rent is allowed on top; later deposits only the usual rent', async () => {
    const { p, f, acc } = market()
    const q = await p.quoteSupply({ token: USDC, amount: 5_000_000n })
    expect(q.reserve).toBe(USDC_RESERVE)
    expect(lastPost(f)).toMatchObject({ url: '/ktx/klend/deposit', body: { wallet: USER, market: MARKET, reserve: USDC_RESERVE, amount: '5' } })
    expect(acc.guards.at(-1)!.guard.expect).toEqual({ maxLamportsOut: DEFAULT_RENT_ALLOWANCE + DEFAULT_FIRST_DEPOSIT_ALLOWANCE, maxTokenOut: { mint: USDC, amount: 5_000_000n } })
    f.obligations = [obligation]
    await p.supply({ token: USDC, amount: 5_000_000n })
    expect(acc.guards.at(-1)!.guard.expect.maxLamportsOut).toBe(DEFAULT_RENT_ALLOWANCE)
    expect(acc.sent).toHaveLength(1)
  })

  it('a SOL deposit is bounded on the lamport side', async () => {
    const { p, f, acc } = market()
    f.obligations = [obligation]
    await p.quoteSupply({ token: SOL, amount: 10n ** 9n })
    expect(lastPost(f).body).toMatchObject({ reserve: SOL_RESERVE, amount: '1' })
    expect(acc.guards.at(-1)!.guard.expect).toEqual({ maxLamportsOut: 10n ** 9n + DEFAULT_RENT_ALLOWANCE })
  })

  it('reads obligations into per-mint totals and resolves max against them', async () => {
    const { p, f, acc } = market()
    f.obligations = [obligation]
    const pos = await p.getPosition()
    expect(pos.obligations[0]!.obligation).toBe('zncEB2kLmREYgbVG6aPS6D6NamMjDskXM5pwh5Ejmeu')
    expect(pos.supplied).toEqual({ [USDC]: 5_000_123n, [SOL]: 500_000_000n })
    expect(pos.borrowed).toEqual({ [USDC]: 1_250_000n })
    expect(pos.obligations[0]!.currentLtv).toBeCloseTo(0.021)

    const w = await p.quoteWithdraw({ token: USDC, amount: 'max' })
    expect(lastPost(f)).toMatchObject({ url: '/ktx/klend/withdraw', body: { amount: '5.000123' } })
    expect(w.minReceived).toBe(lessBps(5_000_123n, 50))
    expect(acc.guards.at(-1)!.guard.expect.tokenIn).toEqual({ mint: USDC, minAmount: lessBps(5_000_123n, 50) })

    const b = await p.quoteBorrow({ token: USDC, amount: 1_000_000n })
    expect(lastPost(f).url).toBe('/ktx/klend/borrow')
    expect(b.minReceived).toBe(995_000n)

    await p.repay({ token: USDC, amount: 'max' })
    expect(lastPost(f)).toMatchObject({ url: '/ktx/klend/repay', body: { amount: '1.25' } })
    expect(acc.guards.at(-1)!.guard.expect.maxTokenOut).toEqual({ mint: USDC, amount: 1_256_250n })
    await expect(p.quoteRepay({ token: SOL, amount: 'max' })).rejects.toThrow(/Nothing borrowed/)
  })

  it('writes refuse a read-only account before any API call', async () => {
    const f = api()
    const p = new KaminoMarketProtocolSolana(account().toReadOnlyAccount(), { fetch: f.fetch })
    for (const call of [() => p.supply({ token: USDC, amount: 1n }), () => p.withdraw({ token: USDC, amount: 1n }), () => p.borrow({ token: USDC, amount: 1n }), () => p.repay({ token: USDC, amount: 1n })]) {
      await expect(call()).rejects.toBeInstanceOf(ReadOnlyAccountError)
    }
    expect(f.requests).toHaveLength(0)
  })

  it('falls back to known decimals when the account cannot read mints', async () => {
    const { p, f } = market(account({ mintInfo: false }))
    f.obligations = [obligation]
    await p.quoteSupply({ token: USDC, amount: 1_000_000n })
    expect(lastPost(f).body.amount).toBe('1')
  })
})

describe('KaminoApi', () => {
  it('parses markets (primary first), reserves (percent APYs) and a 404 position as zero', async () => {
    const f = api()
    const a = new KaminoApi(undefined, f.fetch)
    const ms = await a.listMarkets()
    expect(ms[0]!.lendingMarket).toBe(MARKET)
    const rs = await a.getReserves(MARKET)
    const sol = rs.find((r) => r.symbol === 'SOL')!
    expect(sol).toMatchObject({ mint: SOL, maxLtv: 0.74 })
    expect(sol.supplyApy).toBeCloseTo(4.57)
    expect(await a.getVaultPosition(USER, VAULT)).toEqual({ vaultAddress: VAULT, stakedShares: '0', unstakedShares: '0', totalShares: '0' })
    f.routes.set('/kvaults/users', { status: 500, body: { error: 'boom' } })
    await expect(a.getVaultPosition(USER, VAULT)).rejects.toThrow(/500/)
  })
})
